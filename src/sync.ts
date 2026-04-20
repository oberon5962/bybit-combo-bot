// ============================================================
// Bybit Combo Bot — Exchange State Sync
// ============================================================
//
// При каждом старте бота:
//   1. Загружает все открытые ордера с Bybit
//   2. Сверяет с сохранённым состоянием (bot-state.json)
//   3. Удаляет из состояния ордера, которых нет на бирже
//   4. Загружает реальные балансы криптовалют
//   5. Логирует полную картину портфеля
// ============================================================

import { BotConfig, Logger, sanitizeError } from './types';
import { BybitExchange } from './exchange';
import { StateManager } from './state';
import { POSITION_RECONCILE_TOLERANCE_PERCENT } from './constants';

export interface PortfolioSnapshot {
  usdtFree: number;
  usdtInOrders: number;
  usdtTotal: number;
  holdings: HoldingInfo[];
  openOrders: OrderInfo[];
  totalValueUSDT: number;
}

export interface HoldingInfo {
  currency: string;
  amount: number;
  valueUSDT: number;
  currentPrice: number;
}

export interface OrderInfo {
  id: string;
  symbol: string;
  side: string;
  price: number;
  amount: number;
  valueUSDT: number;
}

export class ExchangeSync {
  private config: BotConfig;
  private exchange: BybitExchange;
  private state: StateManager;
  private log: Logger;

  constructor(config: BotConfig, exchange: BybitExchange, state: StateManager, log: Logger) {
    this.config = config;
    this.exchange = exchange;
    this.state = state;
    this.log = log;
  }

  /** Hot-reload: обновить конфиг (per-pair spacing и т.д.) */
  updateConfig(config: BotConfig): void {
    this.config = config;
  }

  /** Callback для получения актуального spacing (учитывает auto-spacing) */
  private spacingResolver?: (symbol: string) => { buySpacingPct: number; sellSpacingPct: number };

  setSpacingResolver(fn: (symbol: string) => { buySpacingPct: number; sellSpacingPct: number }): void {
    this.spacingResolver = fn;
  }

  // ----------------------------------------------------------
  // Full sync on startup
  // ----------------------------------------------------------

  async syncOnStartup(): Promise<PortfolioSnapshot> {
    this.log.info('='.repeat(60));
    this.log.info('  SYNCING WITH BYBIT...');
    this.log.info('='.repeat(60));

    // 1. Sync open orders
    await this.syncOrders();

    // 1b. Enforce buy-freeze: cancel any live buy-orders for frozen bases
    await this.enforceBuyFreezeAfterSync();

    // 1c. Reconcile position.amount with exchange balance per pair.
    // Bot tracks position only through its own fills; crypto held before bot start,
    // manual buys via Bybit UI, or untracked partial fills create desync over time.
    // SL/TP/closePosition read position.amount — desync means undersized emergency sells.
    await this.reconcilePositionsWithBalance();

    // 2. Build portfolio snapshot
    const snapshot = await this.buildPortfolioSnapshot();

    // 3. Log full picture
    this.logPortfolio(snapshot);

    return snapshot;
  }

  /**
   * For each pair, compare state.positionAmount with actual Bybit balance (free + used).
   * If they diverge by more than 5%, adopt Bybit balance as truth:
   *   new positionAmount = Bybit total
   *   new costBasis = new amount × existing avgEntryPrice (preserves PnL baseline)
   * If bot had no position in state but crypto exists on Bybit, use current market price.
   */
  private async reconcilePositionsWithBalance(): Promise<void> {
    let allBalances: Record<string, { free: number; used: number; total: number }>;
    try {
      allBalances = await this.exchange.fetchAllBalances();
    } catch (err) {
      this.log.warn(`[sync] position reconcile: fetchAllBalances failed: ${sanitizeError(err)}`);
      return;
    }

    for (const pair of this.config.pairs) {
      if (pair.state === 'deleted') continue;
      const base = pair.symbol.split('/')[0];
      const bybitTotal = allBalances[base]?.total ?? 0;
      const statePos = this.state.getPosition(pair.symbol);
      const stateAmt = statePos.amount;

      // Skip if both near zero (dust)
      if (bybitTotal < 1e-8 && stateAmt < 1e-8) continue;

      const ref = Math.max(bybitTotal, stateAmt, 1e-8);
      const diffPct = Math.abs(bybitTotal - stateAmt) / ref * 100;
      if (diffPct <= POSITION_RECONCILE_TOLERANCE_PERCENT) continue; // within tolerance

      let newCost: number;
      let note: string;

      if (statePos.avgEntryPrice <= 0) {
        // No prior avgEntry — use current market price as baseline.
        // Skip entirely if ticker fetch fails (don't corrupt state with bogus costBasis=bybitTotal*1).
        try {
          const ticker = await this.exchange.fetchTicker(pair.symbol);
          newCost = bybitTotal * ticker.last;
          note = `avgEntry set to market ${ticker.last.toFixed(4)}`;
        } catch (err) {
          this.log.warn(`[sync] ${pair.symbol} reconcile skipped — no avgEntry baseline and ticker fetch failed: ${sanitizeError(err)}`);
          continue;
        }
      } else if (bybitTotal < stateAmt) {
        // External sell: scale costBasis proportionally (same as reducePosition).
        const fraction = bybitTotal / stateAmt;
        newCost = statePos.costBasis * fraction;
        note = `avgEntry ${statePos.avgEntryPrice.toFixed(4)} preserved (external sell)`;
      } else {
        // External buy: delta purchased at current market price, blend cost basis.
        const delta = bybitTotal - stateAmt;
        let priceForDelta = statePos.avgEntryPrice; // fallback
        try {
          const ticker = await this.exchange.fetchTicker(pair.symbol);
          if (ticker.last > 0) priceForDelta = ticker.last;
        } catch { /* use fallback */ }
        newCost = statePos.costBasis + delta * priceForDelta;
        const newAvg = newCost / bybitTotal;
        note = `external buy +${delta.toFixed(6)} @ ~${priceForDelta.toFixed(4)}, avgEntry ${statePos.avgEntryPrice.toFixed(4)} → ${newAvg.toFixed(4)}`;
      }

      this.log.warn(
        `[sync] ${pair.symbol} position desync: state=${stateAmt.toFixed(6)}, ` +
        `Bybit=${bybitTotal.toFixed(6)} (${diffPct.toFixed(1)}% diff). ${note}`,
      );
      this.state.setPosition(pair.symbol, bybitTotal, newCost);
    }
  }

  /** Cancel any live buy-orders on exchange for currencies in blockedBuyBases. Called after sync. */
  private async enforceBuyFreezeAfterSync(): Promise<void> {
    const frozen = this.state.getBlockedBuyBases();
    if (frozen.length === 0) return;
    const symbols = this.config.pairs.map(p => p.symbol).concat(this.state.getManualPairs())
      .filter((s, i, arr) => arr.indexOf(s) === i)
      .filter(sym => frozen.includes(sym.split('/')[0].toUpperCase()));
    const batchSize = Math.max(1, this.config.parallelPairs || 1);
    let cancelled = 0;
    // Process frozen pairs in parallel batches; within each pair, cancels for that pair's buys run in parallel too.
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (sym) => {
          const orders = await this.exchange.fetchOpenOrders(sym);
          const buyOrders = orders.filter(o => o.side === 'buy');
          const cancelResults = await Promise.allSettled(
            buyOrders.map(o => this.exchange.cancelOrder(o.id, sym)),
          );
          let localCancelled = 0;
          for (let k = 0; k < buyOrders.length; k++) {
            const cr = cancelResults[k];
            if (cr.status === 'fulfilled') localCancelled++;
            else this.log.warn(`[sync] enforceBuyFreeze: cancel ${buyOrders[k].id} ${sym} failed: ${sanitizeError(cr.reason)}`);
          }
          // Clear orderId on buy-levels in state so grid doesn't think they're still pending
          const levels = this.state.getGridLevels(sym);
          let mutated = false;
          for (const l of levels) {
            if (l.side === 'buy' && l.orderId) {
              l.orderId = undefined;
              l.placedAt = undefined;
              mutated = true;
            }
          }
          if (mutated) this.state.setGridLevels(sym, levels);
          return localCancelled;
        }),
      );
      for (let j = 0; j < batch.length; j++) {
        const r = results[j];
        if (r.status === 'fulfilled') cancelled += r.value;
        else this.log.warn(`[sync] enforceBuyFreeze: fetchOpenOrders ${batch[j]} failed: ${sanitizeError(r.reason)}`);
      }
    }
    if (cancelled > 0 || frozen.length > 0) {
      this.log.info(`[sync] enforceBuyFreeze: frozen=${frozen.join(',')} — cancelled ${cancelled} buy-order(s) across ${symbols.length} pair(s)`);
    }
  }

  // ----------------------------------------------------------
  // 1. Sync orders: remove stale orders from state
  // ----------------------------------------------------------

  private async syncOrders(): Promise<void> {
    const batchSize = Math.max(1, this.config.parallelPairs || 1);
    for (let bi = 0; bi < this.config.pairs.length; bi += batchSize) {
      const batch = this.config.pairs.slice(bi, bi + batchSize);
      await Promise.allSettled(batch.map(async (pair) => {
      const { symbol } = pair;

      // Fetch real open orders from Bybit
      let exchangeOrders: { id: string; symbol: string; side: string; price: number; amount: number }[] = [];
      try {
        exchangeOrders = await this.exchange.fetchOpenOrders(symbol);
      } catch (err) {
        this.log.error(`Failed to fetch open orders for ${symbol}: ${sanitizeError(err)}`);
        return;
      }

      const exchangeOrderIds = new Set(exchangeOrders.map((o) => o.id));

      // Get saved grid levels
      const savedLevels = this.state.getGridLevels(symbol);

      if (savedLevels.length === 0) {
        // No saved grid levels. Any orders on exchange are user-manual — do NOT adopt.
        // Grid will init fresh on first tick; manual orders live independently.
        if (exchangeOrders.length > 0) {
          this.log.info(`[sync] ${symbol}: no saved grid levels, ${exchangeOrders.length} manual order(s) on exchange — left untouched`);
        } else {
          this.log.info(`[sync] ${symbol}: no saved grid levels, no orders on exchange`);
        }
        return;
      }

      let removedCount = 0;
      let validCount = 0;

      for (const level of savedLevels) {
        if (level.orderId) {
          if (exchangeOrderIds.has(level.orderId)) {
            // Order still exists on exchange — keep it
            validCount++;
          } else {
            // Order NOT in open orders — check if it was filled or cancelled
            try {
              const orderInfo = await this.exchange.fetchOrder(level.orderId, symbol);
              if (orderInfo.filled > 0) {
                // Order was filled (fully or partially before cancel) — update position
                const fillPrice = orderInfo.price > 0 ? orderInfo.price : level.price;
                const fillAmount = orderInfo.filled;
                const fillCost = fillAmount * fillPrice;
                if (level.side === 'buy') {
                  this.state.addToPosition(symbol, fillAmount, fillCost);
                } else {
                  this.state.reducePosition(symbol, fillAmount);
                }
                this.state.addTrade({
                  timestamp: Date.now(),
                  symbol,
                  side: level.side,
                  amount: fillAmount,
                  price: fillPrice,
                  cost: fillCost,
                  fee: orderInfo.fee > 0 ? orderInfo.fee : fillCost * 0.001,
                  strategy: 'grid-sync',
                });
                // Flip level to counter-side so grid places counter-order on next tick
                // buy filled → sell counter uses sellSpacing; sell filled → buy counter uses buySpacing
                const counterSide: 'buy' | 'sell' = level.side === 'buy' ? 'sell' : 'buy';
                // Spacing: через resolver (учитывает auto-spacing) или fallback на config
                const pairCfg = this.config.pairs.find(p => p.symbol === symbol);
                const fallbackBuy = pairCfg?.gridSpacingPercent ?? this.config.grid.gridSpacingPercent;
                const fallbackSell = pairCfg?.gridSpacingSellPercent ?? this.config.grid.gridSpacingSellPercent;
                let syncBuyPct = fallbackBuy;
                let syncSellPct = fallbackSell;
                if (this.spacingResolver) {
                  try {
                    const spacing = this.spacingResolver(symbol);
                    if (spacing && spacing.buySpacingPct > 0 && spacing.sellSpacingPct > 0) {
                      syncBuyPct = spacing.buySpacingPct;
                      syncSellPct = spacing.sellSpacingPct;
                    }
                  } catch { /* fallback to config values */ }
                }
                const rawCounterPrice = level.side === 'buy'
                  ? fillPrice * (1 + syncSellPct / 100)
                  : fillPrice * (1 - syncBuyPct / 100);
                // Round to market precision (same as grid.ts) to avoid Bybit rejection
                const pricePrecision = (await this.exchange.getMarketPrecision(symbol)).pricePrecision;
                const factor = Math.pow(10, pricePrecision);
                const counterPrice = Math.round(rawCounterPrice * factor) / factor;
                this.log.info(`[sync] ${symbol}: order ${level.orderId} at ${level.price} (${level.side}) was FILLED — position updated (${fillAmount} @ ${fillPrice}), level flipped to ${counterSide} @ ${counterPrice}`);
                level.side = counterSide;
                level.price = counterPrice;
                level.orderId = undefined;
                level.filled = false;
                if (counterSide === 'sell') {
                  level.oldBreakEven = fillPrice * (1 + this.config.grid.minSellProfitPercent / 100);
                  level.originalPlannedSellPrice = counterPrice;
                  level.virtualNewSellPrice = undefined;
                  level.nextStepAt = undefined;
                  level.sellSource = 'counter';
                } else {
                  level.oldBreakEven = undefined;
                  level.originalPlannedSellPrice = undefined;
                  level.virtualNewSellPrice = undefined;
                  level.nextStepAt = undefined;
                  level.sellSource = undefined;
                }
              } else {
                this.log.info(`[sync] ${symbol}: order ${level.orderId} at ${level.price} (${level.side}) was ${orderInfo.status} — removing from state`);
                level.orderId = undefined;
                level.filled = false;
              }
            } catch (err) {
              this.log.warn(`[sync] ${symbol}: could not fetch order ${level.orderId}: ${sanitizeError(err)} — removing from state`);
              level.orderId = undefined;
              level.filled = false;
            }
            removedCount++;
          }
        }
      }

      // Check if exchange has orders we don't know about (user-manual via Bybit UI).
      // Do NOT adopt them — they belong to the user, not the bot. They live independently.
      // However, if a manual order matches an EXISTING unplaced level (bot had it planned
      // but never got orderId), reconnect — this recovers from a fill-during-downtime where
      // the bot's own orderId was lost but the order itself is bot's creation.
      const knownIds = new Set(savedLevels.map((l) => l.orderId).filter(Boolean));
      const unknownOrders = exchangeOrders.filter((o) => !knownIds.has(o.id));
      let reconnectedCount = 0;
      let untouchedCount = 0;
      for (const o of unknownOrders) {
        const match = savedLevels.find(
          (l) => !l.orderId && l.side === o.side && Math.abs(l.price - o.price) / o.price < 0.001,
        );
        if (match) {
          match.orderId = o.id;
          reconnectedCount++;
          this.log.info(`[sync] ${symbol}: reconnected ${o.side} @ ${o.price} to existing bot level (id: ${o.id})`);
        } else {
          untouchedCount++;
        }
      }
      if (untouchedCount > 0) {
        this.log.info(`[sync] ${symbol}: ${untouchedCount} manual order(s) on exchange — left untouched (not bot levels)`);
      }

      // Save cleaned state. If any fill was processed (removedCount > 0, path flips level and calls
      // addToPosition which saveCritical), the grid-level flip MUST also survive crash — otherwise
      // restart would re-fetch the same orderId, see it filled, and double-count position.
      const flipOccurred = removedCount > 0;
      this.state.setGridLevels(symbol, savedLevels, flipOccurred);

      this.log.info(`[sync] ${symbol}: ${validCount} confirmed, ${removedCount} stale removed, ${reconnectedCount} reconnected, ${untouchedCount} manual ignored`);
      }));
    }
  }

  // ----------------------------------------------------------
  // 2. Build full portfolio snapshot from Bybit
  // ----------------------------------------------------------

  async buildPortfolioSnapshot(): Promise<PortfolioSnapshot> {
    // USDT balance
    const usdtBalance = await this.exchange.fetchBalance('USDT');

    // All crypto balances
    const allBalances = await this.exchange.fetchAllBalances();
    const holdings: HoldingInfo[] = [];

    // Holdings: fetch tickers in parallel batches of parallelPairs.
    // Include manualPairs (e.g., /buy DOGE/USDT without DOGE in config) so their holdings are counted.
    const batchSize = Math.max(1, this.config.parallelPairs || 1);
    const allSymbols = Array.from(new Set([
      ...this.config.pairs.map(p => p.symbol),
      ...this.state.getManualPairs(),
    ]));
    const pairsWithHoldings = allSymbols
      .map(symbol => ({ symbol }))
      .filter(pair => {
      const held = allBalances[pair.symbol.split('/')[0]];
      return held && held.total > 0;
    });
    for (let i = 0; i < pairsWithHoldings.length; i += batchSize) {
      const batch = pairsWithHoldings.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(p => this.exchange.fetchTicker(p.symbol)),
      );
      for (let j = 0; j < batch.length; j++) {
        const pair = batch[j];
        const base = pair.symbol.split('/')[0];
        const held = allBalances[base];
        if (!held) continue;
        const r = results[j];
        if (r.status === 'fulfilled') {
          holdings.push({
            currency: base,
            amount: held.total,
            valueUSDT: held.total * r.value.last,
            currentPrice: r.value.last,
          });
        } else {
          this.log.error(`Failed to get price for ${base}: ${sanitizeError(r.reason)}`);
          holdings.push({ currency: base, amount: held.total, valueUSDT: 0, currentPrice: 0 });
        }
      }
    }

    // Open orders: include config.pairs + manualPairs to catch manual positions.
    const orderSymbols = allSymbols.map(symbol => ({ symbol }));
    const openOrders: OrderInfo[] = [];
    for (let i = 0; i < orderSymbols.length; i += batchSize) {
      const batch = orderSymbols.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(p => this.exchange.fetchOpenOrders(p.symbol)),
      );
      for (let j = 0; j < batch.length; j++) {
        const pair = batch[j];
        const r = results[j];
        if (r.status === 'fulfilled') {
          for (const o of r.value) {
            openOrders.push({
              id: o.id, symbol: pair.symbol, side: o.side, price: o.price,
              amount: o.amount, valueUSDT: o.price * o.amount,
            });
          }
        } else {
          this.log.error(`[sync] Failed to fetch open orders for ${pair.symbol} during portfolio build: ${sanitizeError(r.reason)}`);
        }
      }
    }

    const holdingsValue = holdings.reduce((s, h) => s + h.valueUSDT, 0);
    const totalValueUSDT = usdtBalance.total + holdingsValue;

    return {
      usdtFree: usdtBalance.free,
      usdtInOrders: usdtBalance.used,
      usdtTotal: usdtBalance.total,
      holdings,
      openOrders,
      totalValueUSDT,
    };
  }

  // ----------------------------------------------------------
  // 3. Log full portfolio
  // ----------------------------------------------------------

  private logPortfolio(snapshot: PortfolioSnapshot): void {
    this.log.info('-'.repeat(60));
    this.log.info('PORTFOLIO SNAPSHOT (from Bybit):');
    this.log.info('-'.repeat(60));

    // USDT
    this.log.info(`USDT: ${snapshot.usdtTotal.toFixed(2)} (free: ${snapshot.usdtFree.toFixed(2)}, in orders: ${snapshot.usdtInOrders.toFixed(2)})`);

    // Holdings
    if (snapshot.holdings.length > 0) {
      this.log.info('Holdings:');
      for (const h of snapshot.holdings) {
        this.log.info(`  ${h.currency}: ${h.amount.toFixed(8)} (~${h.valueUSDT.toFixed(2)} USDT @ ${h.currentPrice.toFixed(2)})`);
      }
    } else {
      this.log.info('Holdings: none (all in USDT)');
    }

    // Open orders
    if (snapshot.openOrders.length > 0) {
      this.log.info(`Open orders: ${snapshot.openOrders.length}`);
      for (const o of snapshot.openOrders) {
        this.log.info(`  ${o.side.toUpperCase()} ${o.symbol}: ${o.amount} @ ${o.price} (~${o.valueUSDT.toFixed(2)} USDT) [${o.id}]`);
      }
    } else {
      this.log.info('Open orders: none');
    }

    // Total
    this.log.info('-'.repeat(60));
    this.log.info(`TOTAL PORTFOLIO VALUE: ${snapshot.totalValueUSDT.toFixed(2)} USDT`);

    // Compare with saved state
    if (this.state.startingCapital > 0) {
      const pnl = snapshot.totalValueUSDT - this.state.startingCapital;
      const pnlPercent = (pnl / this.state.startingCapital) * 100;
      const sign = pnl >= 0 ? '+' : '';
      this.log.info(`PnL from start: ${sign}${pnl.toFixed(2)} USDT (${sign}${pnlPercent.toFixed(1)}%)`);
    }

    this.log.info('-'.repeat(60));
  }
}
