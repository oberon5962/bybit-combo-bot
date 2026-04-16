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

    // 2. Build portfolio snapshot
    const snapshot = await this.buildPortfolioSnapshot();

    // 3. Log full picture
    this.logPortfolio(snapshot);

    return snapshot;
  }

  // ----------------------------------------------------------
  // 1. Sync orders: remove stale orders from state
  // ----------------------------------------------------------

  private async syncOrders(): Promise<void> {
    for (const pair of this.config.pairs) {
      const { symbol } = pair;

      // Fetch real open orders from Bybit
      let exchangeOrders: { id: string; symbol: string; side: string; price: number; amount: number }[] = [];
      try {
        exchangeOrders = await this.exchange.fetchOpenOrders(symbol);
      } catch (err) {
        this.log.error(`Failed to fetch open orders for ${symbol}: ${sanitizeError(err)}`);
        continue;
      }

      const exchangeOrderIds = new Set(exchangeOrders.map((o) => o.id));

      // Get saved grid levels
      const savedLevels = this.state.getGridLevels(symbol);

      if (savedLevels.length === 0) {
        // No saved grid levels — adopt exchange orders as grid levels
        if (exchangeOrders.length > 0) {
          this.log.info(`[sync] ${symbol}: no saved grid levels, adopting ${exchangeOrders.length} orders from Bybit`);
          const adoptedLevels = exchangeOrders.map((o) => ({
            price: o.price,
            amount: o.amount ?? 0,
            side: o.side as 'buy' | 'sell',
            orderId: o.id,
            filled: false,
          }));
          adoptedLevels.sort((a, b) => a.price - b.price);
          this.state.setGridLevels(symbol, adoptedLevels);
          this.state.setGridInitialized(symbol, true);
          // Set center price from adopted levels midpoint (best estimate without original center)
          const adoptedCenter = (adoptedLevels[0].price + adoptedLevels[adoptedLevels.length - 1].price) / 2;
          this.state.setGridCenterPrice(symbol, adoptedCenter);
          this.log.info(`[sync] ${symbol}: adopted ${adoptedLevels.length} orders as grid levels (center: ${adoptedCenter.toFixed(4)})`);
        } else {
          this.log.info(`[sync] ${symbol}: no saved grid levels, no orders on exchange`);
        }
        continue;
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
                  fee: fillCost * 0.001,
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

      // Check if exchange has orders we don't know about
      const knownIds = new Set(savedLevels.map((l) => l.orderId).filter(Boolean));
      const unknownOrders = exchangeOrders.filter((o) => !knownIds.has(o.id));

      // Adopt unknown orders into grid levels instead of cancelling
      if (unknownOrders.length > 0) {
        this.log.info(`[sync] ${symbol}: found ${unknownOrders.length} untracked orders on Bybit — adopting into grid:`);
        for (const o of unknownOrders) {
          // Try to match to an existing unplaced level at the same price and side
          const match = savedLevels.find(
            (l) => !l.orderId && l.side === o.side && Math.abs(l.price - o.price) / o.price < 0.001,
          );
          if (match) {
            match.orderId = o.id;
            this.log.info(`  → matched ${o.side} @ ${o.price} to existing level (id: ${o.id})`);
          } else {
            // No matching level — add as new level
            savedLevels.push({
              price: o.price,
              amount: o.amount ?? 0,
              side: o.side as 'buy' | 'sell',
              orderId: o.id,
              filled: false,
            });
            this.log.info(`  → adopted ${o.side} @ ${o.price} as new level (id: ${o.id})`);
          }
        }
        savedLevels.sort((a, b) => a.price - b.price);
      }

      // Save cleaned state
      this.state.setGridLevels(symbol, savedLevels);

      this.log.info(`[sync] ${symbol}: ${validCount} orders confirmed, ${removedCount} stale removed, ${unknownOrders.length} adopted from exchange`);
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

    for (const pair of this.config.pairs) {
      const base = pair.symbol.split('/')[0]; // "BTC" from "BTC/USDT"
      const held = allBalances[base];

      if (held && held.total > 0) {
        try {
          const ticker = await this.exchange.fetchTicker(pair.symbol);
          holdings.push({
            currency: base,
            amount: held.total,
            valueUSDT: held.total * ticker.last,
            currentPrice: ticker.last,
          });
        } catch (err) {
          this.log.error(`Failed to get price for ${base}: ${sanitizeError(err)}`);
          holdings.push({
            currency: base,
            amount: held.total,
            valueUSDT: 0,
            currentPrice: 0,
          });
        }
      }
    }

    // Open orders on all pairs
    const openOrders: OrderInfo[] = [];
    for (const pair of this.config.pairs) {
      try {
        const orders = await this.exchange.fetchOpenOrders(pair.symbol);
        for (const o of orders) {
          openOrders.push({
            id: o.id,
            symbol: pair.symbol,
            side: o.side,
            price: o.price,
            amount: o.amount,
            valueUSDT: o.price * o.amount,
          });
        }
      } catch (err) {
        this.log.error(`[sync] Failed to fetch open orders for ${pair.symbol} during portfolio build: ${sanitizeError(err)}`);
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
