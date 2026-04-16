// ============================================================
// Bybit Combo Bot — Grid Trading Strategy (with persistence)
// ============================================================

import {
  BotConfig, GridConfig, PairConfig, Ticker, IndicatorSnapshot,
  StrategyDecision, Logger, sanitizeError,
} from '../types';
import { BybitExchange } from '../exchange';
import { StateManager, GridLevelState } from '../state';

export class GridStrategy {
  private config: GridConfig;
  private pairsConfig: PairConfig[];
  private exchange: BybitExchange;
  private log: Logger;
  private lastIndicators: Map<string, IndicatorSnapshot> = new Map();
  private state: StateManager;
  private restoredLogged: Set<string> = new Set(); // prevent repeated "Grid restored" logs
  // BUG #12 fix: cache market precision per symbol
  private precisionCache: Map<string, { pricePrecision: number; amountPrecision: number; minAmount: number; minCost: number }> = new Map();
  private lastSkipSummary: Map<string, string> = new Map(); // suppress repeated skip logs
  private lastRebalanceTime: Map<string, number> = new Map(); // cooldown between rebalances
  private _marketProtectionActive: boolean = false;
  private autoSpacingMap: Map<string, { buy: number; sell: number }> = new Map();

  private maxOpenOrdersPerPair: number;

  constructor(config: BotConfig, exchange: BybitExchange, log: Logger, state: StateManager) {
    this.config = config.grid;
    this.pairsConfig = config.pairs;
    this.maxOpenOrdersPerPair = config.risk.maxOpenOrdersPerPair;
    this.exchange = exchange;
    this.log = log;
    this.state = state;
  }

  /** Hot-reload: обновить конфиг без перестроения сетки. Новые параметры применятся к новым ордерам. */
  updateConfig(config: BotConfig): void {
    const wasAutoOn = this.config.autoSpacingPriority !== 'off';
    this.config = config.grid;
    this.pairsConfig = config.pairs;
    this.maxOpenOrdersPerPair = config.risk.maxOpenOrdersPerPair;
    // При отключении autoSpacing — очистить auto-значения, вернуться к config
    if (wasAutoOn && config.grid.autoSpacingPriority === 'off') {
      this.autoSpacingMap.clear();
    }
  }

  /** Установить auto-spacing значения из volatility analysis */
  setAutoSpacing(spacingMap: Map<string, { buy: number; sell: number }>): void {
    this.autoSpacingMap = spacingMap;
  }

  /** Очистить auto-spacing (revert к config-значениям) */
  clearAutoSpacing(): void {
    this.autoSpacingMap.clear();
  }

  /** Публичный доступ к spacing для sync.ts */
  getSpacingPublic(symbol: string): { buySpacingPct: number; sellSpacingPct: number } {
    return this.getSpacing(symbol);
  }

  /** Принудительный ребаланс всех пар на следующем тике (сброс center → drift 100%) */
  forceRebalanceAll(): void {
    for (const pair of this.pairsConfig) {
      if (this.state.isGridInitialized(pair.symbol)) {
        this.state.setGridCenterPrice(pair.symbol, 0);
      }
    }
  }

  /** Get grid spacing for a symbol: auto-spacing → per-pair override → global fallback */
  private getSpacing(symbol: string): { buySpacingPct: number; sellSpacingPct: number } {
    // Auto-spacing приоритет (если включено и priority=auto и есть данные)
    if (this.config.autoSpacingPriority === 'auto') {
      const auto = this.autoSpacingMap.get(symbol);
      if (auto) {
        return { buySpacingPct: auto.buy, sellSpacingPct: auto.sell };
      }
    }
    // Fallback: per-pair config → global config
    const pair = this.pairsConfig.find(p => p.symbol === symbol);
    return {
      buySpacingPct: pair?.gridSpacingPercent ?? this.config.gridSpacingPercent,
      sellSpacingPct: pair?.gridSpacingSellPercent ?? this.config.gridSpacingSellPercent,
    };
  }

  private async getPrecision(symbol: string) {
    if (!this.precisionCache.has(symbol)) {
      const p = await this.exchange.getMarketPrecision(symbol);
      this.precisionCache.set(symbol, p);
      this.log.info(`Market precision for ${symbol}: price=${p.pricePrecision}, amount=${p.amountPrecision}, minAmount=${p.minAmount}, minCost=${p.minCost}`);
    }
    return this.precisionCache.get(symbol)!;
  }

  // Bollinger Bands adaptive: determine buy/sell level shift and order size multipliers
  private getBollingerAdaptive(symbol: string): {
    buyLevelShift: number;    // positive = more buy levels (e.g. +3 means 13 buy / 7 sell)
    buyMultiplier: number;    // orderSize multiplier for buys
    sellMultiplier: number;   // orderSize multiplier for sells
    reason: string;
  } {
    const neutral = { buyLevelShift: 0, buyMultiplier: 1, sellMultiplier: 1, reason: 'neutral' };
    if (!this.config.useBollingerAdaptive) return neutral;

    const ind = this.lastIndicators.get(symbol);
    if (!ind) return neutral;

    const shift = this.config.bollingerShiftLevels;

    // Price near lower Bollinger band → aggressive buy
    if (ind.pricePosition === 'below_lower') {
      return {
        buyLevelShift: shift,
        buyMultiplier: this.config.bollingerBuyMultiplier,
        sellMultiplier: 1,
        reason: 'BB lower → aggressive buy',
      };
    }

    // Price near upper Bollinger band → check EMA before aggressive sell
    if (ind.pricePosition === 'above_upper') {
      if (ind.emaCrossover === 'bullish' || (ind.emaFast > ind.emaSlow)) {
        // EMA bullish — strong uptrend, don't sell aggressively
        return {
          buyLevelShift: 0,
          buyMultiplier: 1,
          sellMultiplier: 1,
          reason: 'BB upper + EMA bullish → hold (no aggressive sell)',
        };
      }
      // EMA bearish or neutral — sell aggressively
      return {
        buyLevelShift: -shift,
        buyMultiplier: 1,
        sellMultiplier: this.config.bollingerSellMultiplier,
        reason: 'BB upper + EMA not bullish → aggressive sell',
      };
    }

    // Price below middle — slightly more buy-biased
    if (ind.pricePosition === 'below_middle') {
      return {
        buyLevelShift: Math.floor(shift / 2),
        buyMultiplier: 1,
        sellMultiplier: 1,
        reason: 'BB below middle → slight buy bias',
      };
    }

    return neutral;
  }

  // RSI + EMA filter: should we allow grid buy orders?
  isBuyAllowed(symbol: string): { allowed: boolean; reason: string } {
    const ind = this.lastIndicators.get(symbol);
    if (!ind) return { allowed: true, reason: 'no indicators yet' };

    // Skip buy if RSI overbought
    const rsiThreshold = this.config.rsiOverboughtThreshold;
    if (ind.rsi > rsiThreshold) {
      return { allowed: false, reason: 'overbought' };
    }

    // Skip buy if EMA is bearish (fast < slow = downtrend)
    // Note: emaCrossover only fires on the crossing candle; we check persistent state instead
    if (this.config.useEmaFilter && ind.emaFast < ind.emaSlow) {
      return { allowed: false, reason: 'EMA bearish' };
    }

    return { allowed: true, reason: 'ok' };
  }

  private roundPriceForMarket(price: number, pricePrecision: number): number {
    // ccxt precision can be number of decimal places or tick size
    // For Bybit it's typically decimal places
    const factor = Math.pow(10, pricePrecision);
    return Math.round(price * factor) / factor;
  }

  private roundAmountForMarket(amount: number, amountPrecision: number): number {
    const factor = Math.pow(10, amountPrecision);
    return Math.floor(amount * factor) / factor; // floor to not exceed balance
  }

  // ----------------------------------------------------------
  // Initialize grid levels around current price
  // ----------------------------------------------------------

  /** Returns true if grid was freshly initialized this tick (placeGridOrders already called). */
  async initGrid(
    symbol: string,
    currentPrice: number,
    allocationUSDT: number,
  ): Promise<boolean> {
    if (!this.config.enabled) return false;

    // Check saved state first
    if (this.state.isGridInitialized(symbol)) {
      const savedLevels = this.state.getGridLevels(symbol);
      if (savedLevels.length > 0) {
        // If saved levels are significantly fewer than configured, reinitialize
        // (e.g. sync adopted only 2 orders but gridLevels=14)
        if (savedLevels.length < this.config.gridLevels * 0.5) {
          this.log.warn(`Grid for ${symbol}: only ${savedLevels.length}/${this.config.gridLevels} levels — reinitializing full grid`);
          await this.cancelAll(symbol);
          // Fall through to reinitialize below
        } else {
        // Check if price has drifted far from grid center — rebalance if needed
        // Use saved center price (set at init time). Fallback to level midpoint for migration.
        let gridCenter = this.state.getGridCenterPrice(symbol);
        if (gridCenter <= 0) {
          // center=0: либо forceRebalanceAll(), либо миграция старого state
          if (savedLevels.length > 0) {
            const sortedPrices = savedLevels.map(l => l.price).sort((a, b) => a - b);
            gridCenter = (sortedPrices[0] + sortedPrices[sortedPrices.length - 1]) / 2;
          }
          if (gridCenter <= 0) gridCenter = currentPrice;
          // Принудительный ребаланс — отменить все и перестроить
          this.log.info(`Grid force-rebalance for ${symbol}: center was reset`);
          this.lastRebalanceTime.set(symbol, Date.now());
          await this.cancelAll(symbol);
          // Fall through to reinitialize below
        } else {
        const driftPercent = Math.abs(currentPrice - gridCenter) / gridCenter * 100;

        if (driftPercent > this.config.rebalancePercent) {
          // Cooldown: minimum 5 minutes between rebalances to avoid thrashing
          const lastRebalance = this.lastRebalanceTime.get(symbol) ?? 0;
          const rebalanceCooldownMs = 5 * 60 * 1000;
          if (Date.now() - lastRebalance < rebalanceCooldownMs) {
            if (!this.restoredLogged.has(symbol)) {
              this.log.info(`Grid rebalance deferred for ${symbol}: cooldown active (${Math.round((rebalanceCooldownMs - (Date.now() - lastRebalance)) / 1000)}s left)`);
            }
            return false;
          }
          // Price moved beyond rebalance threshold from grid center — cancel all and reinitialize
          this.log.warn(`Grid rebalance for ${symbol}: price drifted ${driftPercent.toFixed(1)}% from center (${gridCenter.toFixed(2)} → ${currentPrice.toFixed(2)})`);
          this.lastRebalanceTime.set(symbol, Date.now());
          await this.cancelAll(symbol);
          // Fall through to reinitialize below
        } else {
          // Log only once per session, not every tick
          if (!this.restoredLogged.has(symbol)) {
            this.log.info(`Grid restored from saved state for ${symbol}`, {
              levels: savedLevels.length,
              ordersWithIds: savedLevels.filter((l) => l.orderId).length,
            });
            this.restoredLogged.add(symbol);
          }
          return false;
        }
        } // end of drift check else
        } // end of level count check else
      }
    }

    const precision = await this.getPrecision(symbol);
    const { gridLevels } = this.config;
    const { buySpacingPct, sellSpacingPct } = this.getSpacing(symbol);

    // Bollinger adaptive: shift buy/sell ratio
    const bbAdaptive = this.getBollingerAdaptive(symbol);
    const baseBuy = Math.floor(gridLevels / 2);
    const baseSell = Math.ceil(gridLevels / 2);
    const buyLevels = Math.max(1, Math.min(gridLevels - 1, baseBuy + bbAdaptive.buyLevelShift));
    const sellLevels = gridLevels - buyLevels;

    if (bbAdaptive.buyLevelShift !== 0) {
      this.log.info(`Grid Bollinger adaptive for ${symbol}: ${buyLevels}B/${sellLevels}S (${bbAdaptive.reason})`);
    }

    const buySpacing = currentPrice * (buySpacingPct / 100);
    const sellSpacing = currentPrice * (sellSpacingPct / 100);
    const levels: GridLevelState[] = [];
    const usedPrices = new Set<number>();

    // Buy levels below price
    for (let i = 1; i <= buyLevels; i++) {
      const price = this.roundPriceForMarket(currentPrice - buySpacing * i, precision.pricePrecision);
      if (usedPrices.has(price)) continue; // skip duplicate after rounding
      usedPrices.add(price);
      levels.push({ price, amount: 0, side: 'buy', filled: false }); // amount заполнится в placeGridOrders()
    }

    // Sell levels above price (using separate sell spacing)
    for (let i = 1; i <= sellLevels; i++) {
      const price = this.roundPriceForMarket(currentPrice + sellSpacing * i, precision.pricePrecision);
      if (usedPrices.has(price)) continue; // skip duplicate after rounding
      usedPrices.add(price);
      levels.push({ price, amount: 0, side: 'sell', filled: false }); // amount заполнится в placeGridOrders()
    }

    levels.sort((a, b) => a.price - b.price);

    // Save to state
    this.state.setGridLevels(symbol, levels);
    this.state.setGridInitialized(symbol, true);
    this.state.setGridCenterPrice(symbol, currentPrice);

    this.log.info(`Grid initialized for ${symbol}`, {
      levels: gridLevels,
      buySpacing: `${buySpacingPct}%`,
      sellSpacing: `${sellSpacingPct}%`,
      range: `${levels[0].price} — ${levels[levels.length - 1].price}`,
      currentPrice,
    });

    // Place initial orders
    await this.placeGridOrders(symbol, allocationUSDT, currentPrice);
    return true;  // freshly initialized — placeGridOrders already called
  }

  // ----------------------------------------------------------
  // Place grid orders on exchange
  // ----------------------------------------------------------

  private async placeGridOrders(
    symbol: string,
    allocationUSDT: number,
    currentPrice: number,
  ): Promise<void> {
    const precision = await this.getPrecision(symbol);
    const levels = this.state.getGridLevels(symbol);
    const baseOrderBudget = allocationUSDT * (this.config.orderSizePercent / 100);

    // Bollinger adaptive: adjust order sizes
    const bbAdaptive = this.getBollingerAdaptive(symbol);

    // Pre-fetch balances for buy/sell-side checks
    const base = symbol.split('/')[0]; // "BTC" from "BTC/USDT"
    let freeCrypto = 0;
    let freeUSDT = 0;
    try {
      const allBalances = await this.exchange.fetchAllBalances();
      freeCrypto = allBalances[base]?.free ?? 0;
      freeUSDT = allBalances['USDT']?.free ?? 0;
    } catch (err) {
      this.log.warn(`Failed to fetch balances for grid checks: ${sanitizeError(err)}`);
    }

    // Enforce maxOpenOrdersPerPair
    const currentOpenOrders = levels.filter(l => l.orderId).length;
    const maxNewOrders = Math.max(0, this.maxOpenOrdersPerPair - currentOpenOrders);
    let ordersPlaced = 0;

    // Sort levels by proximity to current price (closest first).
    // This ensures the most important orders get placed when balance is limited.
    const sortedLevels = [...levels].sort((a, b) =>
      Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice),
    );

    // Track skip reasons for summary log (generic keys — no volatile values like RSI or balance)
    const skipReasons: Set<string> = new Set();
    const addSkip = (reason: string) => { skipReasons.add(reason); };

    for (const level of sortedLevels) {
      if (level.orderId || level.filled) continue;
      if (ordersPlaced >= maxNewOrders) { addSkip('max orders'); break; }

      try {
        // Bollinger adaptive: apply multiplier per side
        const sideMultiplier = level.side === 'buy' ? bbAdaptive.buyMultiplier : bbAdaptive.sellMultiplier;
        const orderBudget = baseOrderBudget * sideMultiplier;
        let amount = this.roundAmountForMarket(orderBudget / level.price, precision.amountPrecision);

        // Bump up to exchange minimum if too small, but don't exceed budget
        if (amount < precision.minAmount) {
          if (precision.minAmount * level.price > orderBudget * 1.5) {
            addSkip('budget too small');
            continue;
          }
          amount = precision.minAmount;
        }
        if (amount * level.price < precision.minCost) {
          const minAmountForCost = Math.ceil((precision.minCost / level.price) * Math.pow(10, precision.amountPrecision)) / Math.pow(10, precision.amountPrecision);
          if (minAmountForCost * level.price > orderBudget * 1.5) {
            addSkip('below minCost');
            continue;
          }
          amount = Math.max(amount, minAmountForCost);
        }

        if (level.side === 'buy' && level.price < currentPrice) {
          // Block new buy orders during market protection (panic / BTC watchdog)
          if (this._marketProtectionActive) {
            addSkip('market protection');
            continue;
          }
          // RSI + EMA filter
          const buyCheck = this.isBuyAllowed(symbol);
          if (!buyCheck.allowed) {
            addSkip(buyCheck.reason);
            continue;
          }
          const orderCost = amount * level.price;
          if (freeUSDT < orderCost) {
            addSkip('low USDT');
            continue;
          }
          const order = await this.exchange.withRetry(
            () => this.exchange.createLimitBuy(symbol, amount, level.price, 'grid'),
            `Grid buy ${symbol} @ ${level.price}`,
          );
          level.orderId = order.id;
          level.amount = amount;
          freeUSDT -= orderCost;
          ordersPlaced++;
        } else if (level.side === 'sell' && level.price > currentPrice) {
          // Check if we have enough free crypto to place this sell
          if (freeCrypto < amount) {
            addSkip(`low ${base}`);
            continue;
          }
          const order = await this.exchange.withRetry(
            () => this.exchange.createLimitSell(symbol, amount, level.price, 'grid'),
            `Grid sell ${symbol} @ ${level.price}`,
          );
          level.orderId = order.id;
          level.amount = amount;
          // Subtract placed amount from tracked free balance (for subsequent sell levels)
          freeCrypto -= amount;
          ordersPlaced++;
        }
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes('InsufficientFunds') || errStr.includes('Insufficient balance')) {
          addSkip('insufficient balance');
          break; // no point trying remaining levels if balance is depleted
        }
        this.log.error(`Failed to place grid order: ${err}`, { symbol });
      }
    }

    // Log skip summary — only when reasons change from last tick
    if (skipReasons.size > 0) {
      const summary = [...skipReasons].sort().join(', ');
      const prevSummary = this.lastSkipSummary.get(symbol);
      if (summary !== prevSummary) {
        this.log.info(`Grid skip ${symbol}: ${summary}`);
        this.lastSkipSummary.set(symbol, summary);
      }
    } else if (this.lastSkipSummary.has(symbol)) {
      // Was skipping, now all orders placed — log resume
      this.log.info(`Grid orders resumed for ${symbol} — all levels placed`);
      this.lastSkipSummary.delete(symbol);
    }

    // Save updated order IDs
    this.state.setGridLevels(symbol, levels);
  }

  // ----------------------------------------------------------
  // Evaluate — called each tick
  // ----------------------------------------------------------

  async evaluate(
    symbol: string,
    ticker: Ticker,
    indicators: IndicatorSnapshot,
    allocationUSDT: number,
    marketProtectionActive: boolean = false,
  ): Promise<StrategyDecision[]> {
    if (!this.config.enabled) return [];

    // Store latest indicators for buy filter
    this.lastIndicators.set(symbol, indicators);

    // When market protection is active, skip grid init/rebalance (which places buy orders)
    // but still process fills and counter-orders below
    this._marketProtectionActive = marketProtectionActive;
    const freshlyInitialized = marketProtectionActive
      ? false
      : await this.initGrid(symbol, ticker.last, allocationUSDT);

    const decisions: StrategyDecision[] = [];
    const levels = this.state.getGridLevels(symbol);
    // Track crypto committed to counter-sell orders this tick to avoid double-selling with orphan-sell
    let counterSellCommittedThisTick = 0;

    // Check if any orders have filled
    try {
      const openOrders = await this.exchange.fetchOpenOrders(symbol);
      const openIds = new Set(openOrders.map((o) => o.id));

      let levelsChanged = false;
      const processedOrderIds = new Set<string>(); // prevent processing same orderId twice

      for (const level of levels) {
        if (level.orderId && !openIds.has(level.orderId) && !processedOrderIds.has(level.orderId)) {
          processedOrderIds.add(level.orderId);
          const precision = await this.getPrecision(symbol);
          const filledSide = level.side;
          const filledPrice = level.price;

          // BUG #14 fix: check actual fill status — could be partial fill + cancel
          const orderInfo = await this.exchange.fetchOrder(level.orderId, symbol);

          // Check cancel/purge with no fill FIRST (most common disappearance reason)
          if ((orderInfo.status === 'canceled' || orderInfo.status === 'cancelled' || orderInfo.status === 'purged') && orderInfo.filled === 0) {
            this.log.warn(`Grid ${filledSide} at ${filledPrice} was ${orderInfo.status} (no fill), resetting level`, { symbol });
            level.orderId = undefined;
            level.filled = false;
            levelsChanged = true;
            continue;
          }

          // Use actual filled amount from exchange — no guessing
          const filledAmount = orderInfo.filled;
          if (filledAmount <= 0) {
            this.log.warn(`Grid ${filledSide} at ${filledPrice}: filled=0, status=${orderInfo.status} — skipping`, { symbol });
            level.orderId = undefined;
            level.filled = false;
            levelsChanged = true;
            continue;
          }
          // CRITICAL: never use price=0 — fallback to the level's limit price
          const actualPrice = orderInfo.price > 0 ? orderInfo.price : filledPrice;
          if (actualPrice <= 0) {
            this.log.error(`Grid fill for ${symbol} has price=0! Skipping to avoid position corruption.`);
            level.orderId = undefined;
            level.filled = false;
            levelsChanged = true;
            continue;
          }

          const isPartialFill = orderInfo.filled > 0 && orderInfo.remaining > 0;
          if (isPartialFill) {
            this.log.warn(`Grid ${filledSide} at ${filledPrice} PARTIALLY filled: ${orderInfo.filled} (remaining: ${orderInfo.remaining})`, { symbol });
          }

          levelsChanged = true;
          this.log.info(`Grid ${filledSide} filled at ${actualPrice}`, { symbol, amount: filledAmount });

          // Record filled trade with actual amounts
          const tradeCost = filledAmount * actualPrice;
          this.state.addTrade({
            timestamp: Date.now(),
            symbol,
            side: filledSide,
            amount: filledAmount,
            price: actualPrice,
            cost: tradeCost,
            fee: tradeCost * 0.001,  // Bybit spot fee ~0.1%
            strategy: 'grid',
          });

          // Track position for stop-loss / take-profit
          if (filledSide === 'buy') {
            this.state.addToPosition(symbol, filledAmount, filledAmount * actualPrice);
          } else {
            this.state.reducePosition(symbol, filledAmount);
          }

          // Check if pair was halted by SL/TP — fill is already recorded above, skip counter-order only
          if (this.state.isPairHalted(symbol)) {
            this.log.warn(`Grid: fill recorded for ${symbol}, but skipping counter-order — pair halted by SL/TP`);
            level.orderId = undefined;
            level.filled = false;
            levelsChanged = true;
            continue;
          }

          // Calculate counter-order from grid level price (maintains consistent spacing)
          // buy filled → sell counter uses sellSpacing; sell filled → buy counter uses buySpacing
          const { buySpacingPct: counterBuyPct, sellSpacingPct: counterSellPct } = this.getSpacing(symbol);
          const rawCounterPrice = filledSide === 'buy'
            ? filledPrice * (1 + counterSellPct / 100)
            : filledPrice * (1 - counterBuyPct / 100);
          const counterPrice = this.roundPriceForMarket(rawCounterPrice, precision.pricePrecision);
          const counterSide: 'buy' | 'sell' = filledSide === 'buy' ? 'sell' : 'buy';

          // BUG #3 fix: use the SAME amount from the filled order, rounded to market precision
          let counterAmount = this.roundAmountForMarket(filledAmount, precision.amountPrecision);

          // Skip counter-order if below exchange minimums — flip level to counter-side
          // so it doesn't re-buy at the original price indefinitely
          const counterValue = counterAmount * counterPrice;
          if (counterAmount < precision.minAmount || counterValue < precision.minCost) {
            this.log.debug(`Grid counter-order too small for ${symbol}: ${counterAmount} @ ${counterPrice} = ${counterValue.toFixed(2)} USDT (min: ${precision.minAmount} / ${precision.minCost} USDT) — retiring level`);
            level.side = counterSide;
            level.price = counterPrice;
            level.orderId = undefined;
            level.filled = false;
            levelsChanged = true;
            continue;
          }

          // BUG #7 fix: execute counter-order HERE, and only update state AFTER success
          try {
            let counterOrderId: string | undefined;
            if (counterSide === 'sell') {
              // Check free crypto balance before placing sell counter-order
              // Use available balance if slightly less than needed (fee consumed some)
              try {
                const balances = await this.exchange.fetchAllBalances();
                const base = symbol.split('/')[0];
                const freeBal = balances[base]?.free ?? 0;
                if (freeBal < counterAmount * 0.99) {
                  // Significantly less than needed — skip
                  this.log.warn(`Grid counter-sell skipped for ${symbol}: free ${base}=${freeBal.toFixed(8)} < needed ${counterAmount}`);
                  level.orderId = undefined;
                  level.filled = false;
                  levelsChanged = true;
                  continue;
                }
                if (freeBal < counterAmount) {
                  // Slightly less (fee consumed some) — adjust amount down
                  const adjusted = this.roundAmountForMarket(freeBal, precision.amountPrecision);
                  this.log.info(`Grid counter-sell adjusted for ${symbol}: ${counterAmount} → ${adjusted} (fee consumed ${(counterAmount - freeBal).toFixed(8)} ${base})`);
                  counterAmount = adjusted;
                }
              } catch (balErr) {
                this.log.warn(`Failed to check balance for counter-sell, proceeding anyway: ${sanitizeError(balErr)}`);
              }
              const order = await this.exchange.withRetry(
                () => this.exchange.createLimitSell(symbol, counterAmount, counterPrice, 'grid'),
                `Grid counter-sell ${symbol} @ ${counterPrice}`,
              );
              counterOrderId = order.id;
              counterSellCommittedThisTick += counterAmount;
            } else {
              // Counter-buy is part of grid cycle — no RSI/EMA filter (only initial buys are filtered)
              // Check free USDT before placing buy counter-order
              const counterCost = counterAmount * counterPrice;
              try {
                const usdtBal = await this.exchange.fetchBalance('USDT');
                if (usdtBal.free < counterCost) {
                  this.log.warn(`Grid counter-buy skipped for ${symbol}: free USDT=${usdtBal.free.toFixed(2)} < needed ${counterCost.toFixed(2)}`);
                  level.orderId = undefined;
                  level.filled = false;
                  levelsChanged = true;
                  continue;
                }
              } catch (balErr) {
                this.log.warn(`Failed to check USDT balance for counter-buy, proceeding anyway: ${balErr}`);
              }
              const order = await this.exchange.withRetry(
                () => this.exchange.createLimitBuy(symbol, counterAmount, counterPrice, 'grid'),
                `Grid counter-buy ${symbol} @ ${counterPrice}`,
              );
              counterOrderId = order.id;
            }

            this.log.info(`Grid counter-order placed: ${counterSide} ${counterAmount} @ ${counterPrice}`, { symbol });

            // Only update level state AFTER counter-order confirmed placed
            level.orderId = counterOrderId;
            level.amount = counterAmount;
            level.filled = false;
            level.side = counterSide;
            level.price = counterPrice;

            decisions.push({
              strategy: 'grid',
              signal: 'hold', // signal=hold so combo-manager doesn't re-execute
              symbol,
              reason: `Grid counter-order placed: ${filledSide} filled at ${filledPrice}, ${counterSide} at ${counterPrice}`,
            });
          } catch (err) {
            this.log.error(`Failed to place grid counter-order: ${err}`, { symbol, counterSide, counterPrice });
            // Flip level to counter-side so next tick retries counter-order, NOT original side
            level.side = counterSide;
            level.price = counterPrice;
            level.orderId = undefined;
            level.filled = false;
          }

          // Partial fill: create a new level for the remaining unfilled portion
          // so the bot retries the original side at the original price (e.g. buy 7 more SUI)
          if (isPartialFill) {
            const remainingLevel: GridLevelState = {
              price: filledPrice,
              amount: orderInfo.remaining ?? 0,
              side: filledSide,
              orderId: undefined,
              filled: false,
            };
            levels.push(remainingLevel);
            this.log.info(`Grid partial fill: added retry level for remaining ${orderInfo.remaining} ${filledSide} @ ${filledPrice}`, { symbol });
          }
        }
      }

      if (levelsChanged) {
        this.state.setGridLevels(symbol, levels);
      }
    } catch (err) {
      this.log.error(`Error checking grid orders: ${err}`, { symbol });
    }

    // Re-place any levels that don't have an orderId (e.g. sell levels on fresh start
    // that failed because no crypto balance, or orders that were cancelled).
    // Skip if grid was freshly initialized this tick — placeGridOrders already ran.
    if (!freshlyInitialized) {
      const unplacedLevels = levels.filter((l) => !l.orderId && !l.filled);
      if (unplacedLevels.length > 0) {
        await this.placeGridOrders(symbol, allocationUSDT, ticker.last);
      }
    }

    // Orphan position check: free crypto not locked in sell orders = uncovered position
    // Use actual free balance instead of estimating sell order amounts (which can be wrong
    // due to Bollinger multiplier, fee adjustments, minAmount bumps, etc.)
    // Cap: don't exceed maxOpenOrdersPerPair total
    const position = this.state.getPosition(symbol);
    if (position.amount > 0) {
      const precision = await this.getPrecision(symbol);
      try {
        const balances = await this.exchange.fetchAllBalances();
        const base = symbol.split('/')[0];
        // Subtract crypto already committed to counter-sell orders this tick
        // (API balance may not reflect these yet since they were just placed)
        const rawFreeBal = balances[base]?.free ?? 0;
        const freeBal = Math.max(0, rawFreeBal - counterSellCommittedThisTick);
        // Free balance = crypto not in any sell order = uncovered
        this.log.debug(`Orphan check ${symbol}: pos=${position.amount.toFixed(4)}, free ${base}=${rawFreeBal.toFixed(4)} (counter-committed: ${counterSellCommittedThisTick.toFixed(4)}, effective: ${freeBal.toFixed(4)})`);

        const currentOrderCount = levels.filter(l => l.orderId).length;
        if (freeBal > 0 && freeBal * ticker.last >= precision.minCost && currentOrderCount < this.maxOpenOrdersPerPair) {
          // Place sells in chunks of orderSize at increasing price levels
          const orphanOrderBudget = this.maxOpenOrdersPerPair - currentOrderCount;
          const orderAmount = allocationUSDT * this.config.orderSizePercent / 100 / ticker.last;
          if (orderAmount <= 0) {
            this.log.warn(`Orphan-sell skipped for ${symbol}: orderAmount <= 0`);
          } else {
          let remaining = freeBal;
          let priceStep = 1;
          let orphanPlaced = 0;

          while (remaining > 0 && orphanPlaced < orphanOrderBudget) {
            const { sellSpacingPct: orphanSellPct } = this.getSpacing(symbol);
            const entryBased = position.avgEntryPrice * (1 + orphanSellPct * priceStep / 100);
            const priceBased = ticker.last * (1 + orphanSellPct * priceStep / 100);
            const sellPrice = this.roundPriceForMarket(
              Math.max(entryBased, priceBased),
              precision.pricePrecision,
            );

            // Check if this price level already has a sell level (with or without orderId)
            // Without this, cancelled sell orders leave orphan levels that keep spawning duplicates
            const existsAtPrice = levels.some((l) => l.side === 'sell' && Math.abs(l.price - sellPrice) < sellPrice * 0.001);
            if (existsAtPrice) { priceStep++; continue; }

            let sellAmount = this.roundAmountForMarket(
              Math.min(remaining, orderAmount),
              precision.amountPrecision,
            );
            // If chunk is below minCost, use all remaining
            if (sellAmount * sellPrice < precision.minCost) {
              sellAmount = this.roundAmountForMarket(remaining, precision.amountPrecision);
            }
            if (sellAmount <= 0 || sellAmount < precision.minAmount || sellAmount * sellPrice < precision.minCost) break;

            const order = await this.exchange.withRetry(
              () => this.exchange.createLimitSell(symbol, sellAmount, sellPrice, 'grid'),
              `Grid orphan-sell ${symbol} @ ${sellPrice}`,
            );
            levels.push({ price: sellPrice, amount: sellAmount, side: 'sell', orderId: order.id, filled: false });
            orphanPlaced++;
            this.log.info(`Grid orphan-sell placed for ${symbol}: ${sellAmount} @ ${sellPrice} (uncovered position)`);
            remaining -= sellAmount;
            priceStep++;

            // Safety: max 5 orphan sells per tick
            if (priceStep > 5) break;
          }
          levels.sort((a, b) => a.price - b.price);
          this.state.setGridLevels(symbol, levels);
          }
        }
      } catch (err) {
        this.log.warn(`Failed to place orphan-sell for ${symbol}: ${sanitizeError(err)}`);
      }
    }

    if (indicators.emaCrossover === 'bearish') {
      decisions.push({
        strategy: 'grid',
        signal: 'hold',
        symbol,
        reason: 'EMA bearish crossover — consider tightening grid or pausing sells',
      });
    }

    return decisions;
  }

  // ----------------------------------------------------------
  // Cleanup
  // ----------------------------------------------------------

  async cancelAll(symbol: string): Promise<void> {
    await this.exchange.cancelAllOrders(symbol);
    this.state.setGridLevels(symbol, []);
    this.state.setGridInitialized(symbol, false);
  }
}

// Old hardcoded roundPrice/roundAmount removed — replaced by market-aware methods in GridStrategy class
