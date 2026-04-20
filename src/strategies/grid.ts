// ============================================================
// Bybit Combo Bot — Grid Trading Strategy (with persistence)
// ============================================================

import {
  BotConfig, GridConfig, PairConfig, Ticker, IndicatorSnapshot,
  StrategyDecision, Logger, sanitizeError, GRID_SELL_LEVELS,
} from '../types';
import { BybitExchange } from '../exchange';
import { StateManager, GridLevelState } from '../state';
import { TelegramNotifier } from '../telegram';

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
  private lastSkipSummary: Map<string, string> = new Map(); // combined skip log (buy+sell)
  private lastBuySkipSummary: Map<string, string> = new Map(); // skip reasons for BUY side only
  private lastSellSkipSummary: Map<string, string> = new Map(); // skip reasons for SELL side only
  private lastEmaCrossover: Map<string, 'bearish' | 'bullish' | 'neutral'> = new Map(); // dedup EMA crossover logs
  private lastRebalanceTime: Map<string, number> = new Map(); // cooldown between rebalances
  private _marketProtectionActive: boolean = false;
  private autoSpacingMap: Map<string, { buy: number; sell: number }> = new Map();
  private telegram: TelegramNotifier | null = null;

  private maxOpenOrdersPerPair: number;
  private parallelOrders: number;

  constructor(config: BotConfig, exchange: BybitExchange, log: Logger, state: StateManager) {
    this.config = config.grid;
    this.pairsConfig = config.pairs;
    this.maxOpenOrdersPerPair = config.risk.maxOpenOrdersPerPair;
    this.parallelOrders = Math.max(1, config.parallelPairs || 1);
    this.exchange = exchange;
    this.log = log;
    this.state = state;
  }

  /** Allow ComboManager to inject telegram for fill-time notifications (sellgrid auto-exit) */
  setTelegram(tg: TelegramNotifier): void {
    this.telegram = tg;
  }

  /** Get current skip reason for a pair (from last tick), or undefined if not skipping */
  getSkipReason(symbol: string): string | undefined {
    return this.lastSkipSummary.get(symbol);
  }

  /** Skip reason for BUY-side placement (from last tick) */
  getBuySkipReason(symbol: string): string | undefined {
    return this.lastBuySkipSummary.get(symbol);
  }

  /** Skip reason for SELL-side placement (from last tick) */
  getSellSkipReason(symbol: string): string | undefined {
    return this.lastSellSkipSummary.get(symbol);
  }

  /** Hot-reload: обновить конфиг без перестроения сетки. Новые параметры применятся к новым ордерам. */
  updateConfig(config: BotConfig): void {
    const wasAutoOn = this.config.autoSpacingPriority !== 'off';
    this.config = config.grid;
    this.pairsConfig = config.pairs;
    this.maxOpenOrdersPerPair = config.risk.maxOpenOrdersPerPair;
    this.parallelOrders = Math.max(1, config.parallelPairs || 1);
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

  /** Принудительный ребаланс одной пары на следующем тике (сброс center → drift 100%) */
  forceRebalance(symbol: string): void {
    if (this.state.isGridInitialized(symbol)) {
      this.state.setGridCenterPrice(symbol, 0);
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

  /**
   * Округление цены ВВЕРХ к шагу биржи.
   * Используется когда критически важно, чтобы результат был >= input (напр. raise-to-break-even):
   * Math.round может округлить вниз и увести sell-ордер ниже безубыточной цены.
   */
  private roundPriceUpForMarket(price: number, pricePrecision: number): number {
    const factor = Math.pow(10, pricePrecision);
    return Math.ceil(price * factor) / factor;
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
        // (e.g. sync adopted only 2 orders but full grid = gridLevels buy + GRID_SELL_LEVELS sell)
        const expectedFullGrid = this.config.gridLevels + GRID_SELL_LEVELS;
        if (savedLevels.length < expectedFullGrid * 0.5) {
          this.log.warn(`Grid for ${symbol}: only ${savedLevels.length}/${expectedFullGrid} levels — reinitializing full grid`);
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
          // Принудительный ребаланс — отменить все и перестроить, сохранив counter-sell metadata
          this.log.info(`Grid force-rebalance for ${symbol}: center was reset`);
          this.lastRebalanceTime.set(symbol, Date.now());
          await this.cancelAllPreserveCounterSellMeta(symbol);
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
          // Price moved beyond rebalance threshold from grid center
          const driftDown = currentPrice < gridCenter;
          this.log.warn(`Grid rebalance ${driftDown ? 'DOWN' : 'UP'} for ${symbol}: price drifted ${driftPercent.toFixed(1)}% from center (${gridCenter.toFixed(2)} → ${currentPrice.toFixed(2)})`);
          this.lastRebalanceTime.set(symbol, Date.now());

          if (driftDown) {
            // Split rebalance: keep sell orders, rebuild only buy side
            await this.cancelBuySide(symbol);
            // Counter-sell midpoint-halving: step 1-2 of спецификации
            try {
              await this.initCounterSellTrailing(symbol, currentPrice);
            } catch (err) {
              this.log.warn(`initCounterSellTrailing failed for ${symbol}: ${sanitizeError(err)}`);
            }
          } else {
            // Full rebalance UP: cancel all but preserve sell metadata across rebuild
            await this.cancelAllPreserveCounterSellMeta(symbol);
          }
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

    // gridLevels из config определяет ТОЛЬКО количество buy-уровней.
    // Количество sell-уровней — фиксированная константа GRID_SELL_LEVELS (50) и не зависит от config.
    // Bollinger adaptive сдвигает buyLevels: при bearish +shift (больше покупки), при bullish -shift.
    const bbAdaptive = this.getBollingerAdaptive(symbol);
    const buyLevels = Math.max(1, gridLevels + bbAdaptive.buyLevelShift);
    const sellLevels = GRID_SELL_LEVELS;

    if (bbAdaptive.buyLevelShift !== 0) {
      this.log.info(`Grid Bollinger adaptive for ${symbol}: ${buyLevels}B/${sellLevels}S (${bbAdaptive.reason})`);
    }

    const buySpacing = currentPrice * (buySpacingPct / 100);
    const sellSpacing = currentPrice * (sellSpacingPct / 100);

    // Check if we have preserved sell levels from split rebalance
    const existingSells = this.state.getGridLevels(symbol).filter(l => l.side === 'sell');
    const usedPrices = new Set<number>(existingSells.map(l => l.price));

    const levels: GridLevelState[] = [...existingSells]; // keep existing sells

    // Buy levels below price
    for (let i = 1; i <= buyLevels; i++) {
      const price = this.roundPriceForMarket(currentPrice - buySpacing * i, precision.pricePrecision);
      if (usedPrices.has(price)) continue;
      usedPrices.add(price);
      levels.push({ price, amount: 0, side: 'buy', filled: false });
    }

    // Sell levels above price — only if no preserved sells from split rebalance
    // Cap accumulated sells to prevent unbounded growth from repeated split rebalances.
    // Condition: trim when preserved sells exceed the sell portion of the grid (sellLevels),
    // not maxOpenOrdersPerPair — otherwise buy levels can never be placed (max orders hit).
    if (existingSells.length > sellLevels) {
      const excess = existingSells.length - sellLevels;
      // Sort descending: highest-priced sells first (farthest from current price)
      levels.sort((a, b) => b.price - a.price);
      // Cancel the farthest sell orders on exchange before removing from state
      // to prevent silent fills of untracked orders
      const toCancel = levels.filter(l => l.side === 'sell').slice(0, excess);
      for (const s of toCancel) {
        if (s.orderId) {
          try {
            await this.exchange.cancelOrder(s.orderId, symbol);
            this.log.info(`Grid trim excess sell: cancelled ${symbol} @ ${s.price} (reducing ${existingSells.length} → ${sellLevels} sells)`);
          } catch (err) {
            this.log.warn(`Grid trim excess sell: cancel failed for ${symbol} @ ${s.price}: ${sanitizeError(err)}`);
          }
        }
      }
      levels.splice(0, excess);
      levels.sort((a, b) => a.price - b.price);
    }
    // Ladder строится от max(currentPrice, break-even), НЕ от maxExistingSellPrice.
    // Две цели:
    //   1. Исправить «stuck ladder»: раньше ладдер строился выше max preserved, застревая на старых ценах.
    //   2. Не создавать слоты ниже break-even: raise-to-break-even (placeGridOrders) слепил бы их все
    //      в одну цену, создавая 2-3 дубликата на break-even уровне (баг при currentPrice << avgEntry).
    // Preserved counter-sells сосуществуют через fuzzy-проверку (если preserved в пределах 0.5×sellSpacing
    // от ladder-слота — слот считается занятым).
    const pos = this.state.getPosition(symbol);
    const minSellPrice = pos.avgEntryPrice > 0
      ? pos.avgEntryPrice * (1 + this.config.minSellProfitPercent / 100)
      : 0;
    const ladderStart = Math.max(currentPrice, minSellPrice);
    const fuzzyEpsilon = sellSpacing * 0.5;
    let laddersPlaced = 0;
    for (let i = 1; i <= sellLevels; i++) {
      if (existingSells.length + laddersPlaced >= sellLevels) break;
      const price = this.roundPriceForMarket(ladderStart + sellSpacing * i, precision.pricePrecision);
      if (usedPrices.has(price)) continue;
      // Fuzzy: не дублируем слот, если preserved уже рядом
      if (existingSells.some(l => Math.abs(l.price - price) < fuzzyEpsilon)) continue;
      usedPrices.add(price);
      levels.push({ price, amount: 0, side: 'sell', filled: false, sellSource: 'initial' });
      laddersPlaced++;
    }
    if (existingSells.length > 0 || minSellPrice > currentPrice) {
      this.log.info(`Grid ladder for ${symbol}: start=${ladderStart.toFixed(6)} (max(currentPrice=${currentPrice.toFixed(6)}, break-even=${minSellPrice.toFixed(6)})) — ${existingSells.length} preserved counter-sells + ${laddersPlaced} new ladder = ${existingSells.length + laddersPlaced} total`);
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

    // Per-pair USDT budget for BUYS: fair-share based on allocationPercent.
    // Prevents one pair hogging all USDT when multiple pairs compete for limited cash.
    // Pool = freeUSDT + all USDT currently locked in buy orders across active pairs.
    // Fair share = pair.allocationPercent / totalActiveAlloc × pool.
    // Available budget = max(0, fairShare - thisPairAlreadyLockedInBuys), clamped to freeUSDT.
    const thisPair = this.pairsConfig.find(p => p.symbol === symbol);
    let pairBuyBudget = freeUSDT; // fallback
    if (thisPair) {
      const activePairs = this.pairsConfig.filter(p =>
        p.state !== 'deleted' && !this.state.isBuyBlocked(p.symbol.split('/')[0]),
      );
      const totalActiveAlloc = activePairs.reduce((s, p) => s + p.allocationPercent, 0);
      if (totalActiveAlloc > 0 && activePairs.some(p => p.symbol === symbol)) {
        let totalLockedInBuys = 0;
        let thisPairLockedInBuys = 0;
        for (const p of this.pairsConfig) {
          const pLevels = this.state.getGridLevels(p.symbol);
          const locked = pLevels
            .filter(l => l.side === 'buy' && l.orderId && l.amount > 0)
            .reduce((s, l) => s + l.price * l.amount, 0);
          totalLockedInBuys += locked;
          if (p.symbol === symbol) thisPairLockedInBuys = locked;
        }
        const pool = freeUSDT + totalLockedInBuys;
        const fairShare = (thisPair.allocationPercent / totalActiveAlloc) * pool;
        pairBuyBudget = Math.min(freeUSDT, Math.max(0, fairShare - thisPairLockedInBuys));
      } else if (!activePairs.some(p => p.symbol === symbol)) {
        // This pair is not active (deleted or buy-blocked) — no budget
        pairBuyBudget = 0;
      }
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

    // Track skip reasons per side (buy/sell) for visible summary markers
    const buySkipReasons: Set<string> = new Set();
    const sellSkipReasons: Set<string> = new Set();
    const addSkip = (reason: string, side: 'buy' | 'sell') => {
      if (side === 'buy') buySkipReasons.add(reason);
      else sellSkipReasons.add(reason);
    };

    // Pass 1: compute eligible orders sequentially (no API calls).
    // Reserves balance (freeUSDT / freeCrypto) and mutates level.price for midpoint sells.
    type PendingOrder = { level: GridLevelState; side: 'buy' | 'sell'; amount: number };
    const pendingOrders: PendingOrder[] = [];

    for (const level of sortedLevels) {
      if (level.orderId || level.filled) continue;
      if (pendingOrders.length >= maxNewOrders) { addSkip('max orders', level.side); break; }

      const sideMultiplier = level.side === 'buy' ? bbAdaptive.buyMultiplier : bbAdaptive.sellMultiplier;
      const orderBudget = baseOrderBudget * sideMultiplier;
      let amount = this.roundAmountForMarket(orderBudget / level.price, precision.amountPrecision);

      if (amount < precision.minAmount) {
        if (precision.minAmount * level.price > orderBudget * 1.5) { addSkip('budget too small', level.side); continue; }
        amount = precision.minAmount;
      }
      if (amount * level.price < precision.minCost) {
        const minAmountForCost = Math.ceil((precision.minCost / level.price) * Math.pow(10, precision.amountPrecision)) / Math.pow(10, precision.amountPrecision);
        if (minAmountForCost * level.price > orderBudget * 1.5) { addSkip('below minCost', level.side); continue; }
        amount = Math.max(amount, minAmountForCost);
      }

      if (level.side === 'buy' && level.price < currentPrice) {
        if (this.state.isBuyBlocked(base)) { addSkip('buy frozen', 'buy'); continue; }
        if (this._marketProtectionActive) { addSkip('BTC watchdog occured', 'buy'); continue; }
        const buyCheck = this.isBuyAllowed(symbol);
        if (!buyCheck.allowed) { addSkip(buyCheck.reason, 'buy'); continue; }
        let orderCost = amount * level.price;
        if (pairBuyBudget < orderCost) {
          const availableAmount = this.roundAmountForMarket(pairBuyBudget / level.price, precision.amountPrecision);
          const availableCost = availableAmount * level.price;
          if (availableAmount >= precision.minAmount && availableCost >= precision.minCost) {
            this.log.info(`[grid] ${symbol}  buy  reduced   ${amount} → ${availableAmount}  (${(availableAmount/amount*100).toFixed(0)}% of target, budget=$${pairBuyBudget.toFixed(2)})`);
            amount = availableAmount;
            orderCost = availableCost;
          } else {
            addSkip('low USDT (pair budget)', 'buy');
            continue;
          }
        }
        pairBuyBudget -= orderCost;
        freeUSDT -= orderCost;
        this.exchange.deductCachedBalance('USDT', orderCost);
        pendingOrders.push({ level, side: 'buy', amount });

      } else if (level.side === 'sell' && level.price > currentPrice) {
        // Grid Sell Guard: не продавать ниже безубыточной цены (avgEntry × (1 + minSellProfitPercent/100)).
        // Если level.price ниже break-even — ПОДНИМАЕМ цену ордера до break-even, ордер всё равно ставим.
        // originalPlannedSellPrice сохраняется с ПЕРВОНАЧАЛЬНОЙ цены (до подъёма) — halving использует её как старт сползания.
        const pos = this.state.getPosition(symbol);
        const breakEvenMult = 1 + (this.config.minSellProfitPercent / 100);
        const minSellPrice = pos.avgEntryPrice * breakEvenMult;
        const originalLevelPrice = level.price;
        if (pos.avgEntryPrice > 0 && level.price < minSellPrice) {
          // Округляем ВВЕРХ чтобы гарантировать price >= break-even (Math.round мог бы увести ниже).
          const raised = this.roundPriceUpForMarket(minSellPrice, precision.pricePrecision);
          if (raised !== level.price) {
            this.log.info(`Grid sell raised to break-even: ${level.price} → ${raised} (avgEntry=${pos.avgEntryPrice.toFixed(6)}, break-even=${minSellPrice.toFixed(6)})`, { symbol });
            level.price = raised;
          }
        }
        // Anchors и маркер источника. sellSource='initial' означает position-level break-even anchor
        // (не привязан к конкретной покупке). Preserve при force-rebalance игнорирует такие уровни.
        if (pos.avgEntryPrice > 0 && !level.oldBreakEven) {
          level.oldBreakEven = minSellPrice;
          level.originalPlannedSellPrice = originalLevelPrice;
          if (!level.sellSource) level.sellSource = 'initial';
        }
        if (freeCrypto < amount) {
          const availableAmount = this.roundAmountForMarket(freeCrypto, precision.amountPrecision);
          if (availableAmount >= precision.minAmount && availableAmount * level.price >= precision.minCost) {
            this.log.info(`Sell reduced (low ${base}): ${amount} → ${availableAmount} (${(availableAmount/amount*100).toFixed(0)}% of target)`, { symbol });
            amount = availableAmount;
          } else {
            addSkip(`low ${base}`, 'sell');
            continue;
          }
        }
        freeCrypto -= amount;
        this.exchange.deductCachedBalance(base, amount);
        pendingOrders.push({ level, side: 'sell', amount });
      }
    }

    // Pass 2: fire API calls in parallel batches of parallelOrders.
    for (let i = 0; i < pendingOrders.length; i += this.parallelOrders) {
      const batch = pendingOrders.slice(i, i + this.parallelOrders);
      await Promise.all(batch.map(async (pending) => {
        try {
          const order = pending.side === 'buy'
            ? await this.exchange.withRetry(
                () => this.exchange.createLimitBuy(symbol, pending.amount, pending.level.price, 'grid'),
                `Grid buy ${symbol} @ ${pending.level.price}`,
              )
            : await this.exchange.withRetry(
                () => this.exchange.createLimitSell(symbol, pending.amount, pending.level.price, 'grid'),
                `Grid sell ${symbol} @ ${pending.level.price}`,
              );
          pending.level.orderId = order.id;
          pending.level.amount = pending.amount;
          if (pending.side === 'sell') pending.level.placedAt = Date.now();
          this.log.info(`[grid] ${symbol}  ${pending.side === 'buy' ? 'buy ' : 'sell'}  placed   ${pending.amount} @ ${pending.level.price}  (grid-init)`);
          ordersPlaced++;
        } catch (err) {
          const errStr = String(err);
          if (errStr.includes('InsufficientFunds') || errStr.includes('Insufficient balance')) {
            addSkip('insufficient balance', pending.side);
          } else {
            this.log.error(`Failed to place grid order: ${err}`, { symbol });
          }
        }
      }));
    }

    // Skip reasons are surfaced in BOT SUMMARY (per-pair line "skip buy:/skip sell:!").
    // Per-tick skip log was too noisy; only log transitions (skip→resumed).
    const buySummary  = buySkipReasons.size  > 0 ? [...buySkipReasons].sort().join(', ')  : '';
    const sellSummary = sellSkipReasons.size > 0 ? [...sellSkipReasons].sort().join(', ') : '';
    const combinedParts: string[] = [];
    if (buySummary)  combinedParts.push(`buy: ${buySummary}`);
    if (sellSummary) combinedParts.push(`sell: ${sellSummary}`);

    if (combinedParts.length > 0) {
      this.lastSkipSummary.set(symbol, combinedParts.join(' | '));
    } else if (this.lastSkipSummary.has(symbol)) {
      this.log.info(`Grid orders resumed for ${symbol} — all levels placed`);
      this.lastSkipSummary.delete(symbol);
    }

    if (buySummary) this.lastBuySkipSummary.set(symbol, buySummary);
    else this.lastBuySkipSummary.delete(symbol);
    if (sellSummary) this.lastSellSkipSummary.set(symbol, sellSummary);
    else this.lastSellSkipSummary.delete(symbol);

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
          this.log.info(`[grid] ${symbol}  ${filledSide === 'buy' ? 'buy ' : 'sell'}  filled   ${filledAmount} @ ${actualPrice}`);

          // Record filled trade with actual amounts
          const tradeCost = filledAmount * actualPrice;
          this.state.addTrade({
            timestamp: Date.now(),
            symbol,
            side: filledSide,
            amount: filledAmount,
            price: actualPrice,
            cost: tradeCost,
            fee: orderInfo.fee > 0 ? orderInfo.fee : tradeCost * 0.001,
            strategy: 'grid',
          });

          // Track position for stop-loss / take-profit
          if (filledSide === 'buy') {
            this.state.addToPosition(symbol, filledAmount, filledAmount * actualPrice);
          } else {
            this.state.reducePosition(symbol, filledAmount);
            // Sellgrid auto-exit: if position is now too small to sell and sellgrid active → disable + notify
            const baseSym = symbol.split('/')[0];
            if (this.state.isSellGridActive(baseSym)) {
              try {
                const pos = this.state.getPosition(symbol);
                const precision = await this.getPrecision(symbol);
                if (pos.amount < precision.minAmount || pos.amount * actualPrice < precision.minCost) {
                  this.state.removeSellGridBase(baseSym);
                  this.state.removeBlockedBuyBase(baseSym);
                  this.log.info(`Sellgrid auto-exit for ${baseSym}: position depleted (${pos.amount.toFixed(8)}). Sellgrid and freeze removed.`);
                  this.telegram?.sendAlert(`🔻 <b>Sellgrid завершён: ${baseSym}</b>\nКрипта распродана (позиция: ${pos.amount.toFixed(6)}). Sellgrid и freeze сняты автоматически.`);
                }
              } catch (err) {
                this.log.warn(`Sellgrid auto-exit check failed for ${baseSym}: ${sanitizeError(err)} — will retry on next fill`);
              }
            }
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
          let counterPrice = this.roundPriceForMarket(rawCounterPrice, precision.pricePrecision);
          let counterSide: 'buy' | 'sell' = filledSide === 'buy' ? 'sell' : 'buy';
          let counterOrderLabel = 'counter-order';

          // Sellgrid mode: after a sell fill, place a NEW SELL higher (ladder), not counter-buy.
          // Overrides buy-freeze skip below. Sellgrid ~= freeze + ladder-up.
          const base = symbol.split('/')[0];
          if (counterSide === 'buy' && this.state.isSellGridActive(base)) {
            counterSide = 'sell';
            counterPrice = this.roundPriceForMarket(filledPrice * (1 + counterSellPct / 100), precision.pricePrecision);
            counterOrderLabel = 'sellgrid-ladder';
          }

          // Buy-freeze: skip counter-buy when base is frozen; retire the level to sell-side so it doesn't retry.
          if (counterSide === 'buy' && this.state.isBuyBlocked(base)) {
            this.log.info(`Grid counter-buy skipped for ${symbol} (base frozen) — retiring level`);
            level.side = 'buy'; // keep price so that unfreeze restores it naturally
            level.orderId = undefined;
            level.filled = false;
            levelsChanged = true;
            continue;
          }

          // Counter-Sell Guard: не продавать ниже безубыточной цены.
          // Если counterPrice ниже break-even — ПОДНИМАЕМ до break-even, ордер всё равно ставим (не skip).
          // originalCounterPrice сохраняется с ПЕРВОНАЧАЛЬНОЙ (до подъёма) цены — будет записана в originalPlannedSellPrice
          // для halving (осмысленный «старт сползания» от изначально запланированной spacing-цены).
          const originalCounterPrice = counterPrice;
          if (counterSide === 'sell') {
            const pos = this.state.getPosition(symbol);
            const breakEvenMult = 1 + (this.config.minSellProfitPercent / 100);
            const minSellPrice = pos.avgEntryPrice * breakEvenMult;
            if (pos.avgEntryPrice > 0 && counterPrice < minSellPrice) {
              // Округляем ВВЕРХ чтобы гарантировать counterPrice >= break-even.
              const raised = this.roundPriceUpForMarket(minSellPrice, precision.pricePrecision);
              if (raised !== counterPrice) {
                this.log.info(`Counter-sell raised to break-even: ${counterPrice} → ${raised} (spacing-price=${counterPrice}, avgEntry=${pos.avgEntryPrice.toFixed(6)}, break-even=${minSellPrice.toFixed(6)})`, { symbol });
                counterPrice = raised;
              }
            }
          }

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
              this.exchange.deductCachedBalance(symbol.split('/')[0], counterAmount);
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
              this.exchange.deductCachedBalance('USDT', counterCost);
            }

            this.log.info(`[grid] ${symbol}  ${counterSide === 'buy' ? 'buy ' : 'sell'}  placed   ${counterAmount} @ ${counterPrice}  (${counterOrderLabel})`);

            // Only update level state AFTER counter-order confirmed placed
            level.orderId = counterOrderId;
            level.amount = counterAmount;
            level.filled = false;
            level.side = counterSide;
            level.price = counterPrice;
            level.placedAt = Date.now();
            // Counter-sell trailing anchors (used by halving at split rebalance DOWN):
            //   oldBreakEven              — цена конкретной покупки + minSellProfitPercent (нижняя граница halving)
            //   originalPlannedSellPrice  — ПЕРВОНАЧАЛЬНО рассчитанная (до подъёма до break-even) цена — верхняя точка отсчёта для halving
            //   sellSource='counter'      — маркер: это counter-sell от конкретной покупки, preserve при force-rebalance
            if (counterSide === 'sell') {
              level.oldBreakEven = actualPrice * (1 + this.config.minSellProfitPercent / 100);
              level.originalPlannedSellPrice = originalCounterPrice;
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
            if (counterSide === 'sell') {
              level.oldBreakEven = actualPrice * (1 + this.config.minSellProfitPercent / 100);
              level.originalPlannedSellPrice = originalCounterPrice;
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
              // Наследуем counter-sell metadata для продолжения trailing + sellSource для preserve-логики
              oldBreakEven: filledSide === 'sell' ? level.oldBreakEven : undefined,
              originalPlannedSellPrice: filledSide === 'sell' ? level.originalPlannedSellPrice : undefined,
              virtualNewSellPrice: filledSide === 'sell' ? level.virtualNewSellPrice : undefined,
              nextStepAt: filledSide === 'sell' ? level.nextStepAt : undefined,
              sellSource: filledSide === 'sell' ? level.sellSource : undefined,
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
            // Orphan-sell формула — floor по абсолютной ЦЕНЕ (безубытка), а не по проценту:
            //   targetMarkupPct — целевая наценка от текущей цены (spacing × priceStep)
            //   pricePrediction — что получилось бы по чистому spacing-расчёту от ticker.last
            //   breakEvenPrice  — минимальная безубыточная цена (avgEntry × (1 + minSellProfitPercent/100))
            //   sellPrice = max(pricePrediction, breakEvenPrice) — floor защищает от убытка
            const targetMarkupPct = orphanSellPct * priceStep;
            const pricePrediction = ticker.last * (1 + targetMarkupPct / 100);
            const breakEvenPrice = position.avgEntryPrice * (1 + this.config.minSellProfitPercent / 100);
            const rawSellPrice = Math.max(pricePrediction, breakEvenPrice);
            // Всегда округляем ВВЕРХ: гарантирует sellPrice >= rawSellPrice >= breakEvenPrice.
            // Math.round (round-nearest) мог бы увести цену ниже breakEvenPrice из-за floating-point
            // даже когда pricePrediction выиграл max — edge-case когда pricePrediction чуть выше breakEvenPrice.
            const sellPrice = this.roundPriceUpForMarket(rawSellPrice, precision.pricePrecision);
            const floorActivated = breakEvenPrice >= pricePrediction;
            if (floorActivated) {
              this.log.info(`[grid] ${symbol}  orphan-sell floor activated: pricePrediction=${pricePrediction.toFixed(6)} <= breakEvenPrice=${breakEvenPrice.toFixed(6)} (avgEntry=${position.avgEntryPrice.toFixed(6)}, minSellProfitPercent=${this.config.minSellProfitPercent}%) → using ${sellPrice}`);
            }

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
            // Anchors для диагностики (halving не активируется на orphan-sells — sellSource !== 'counter').
            // sellSource='orphan' — маркер: position-level break-even, НЕ preserve при force-rebalance.
            levels.push({
              price: sellPrice,
              amount: sellAmount,
              side: 'sell',
              orderId: order.id,
              filled: false,
              placedAt: Date.now(),
              oldBreakEven: breakEvenPrice,
              originalPlannedSellPrice: pricePrediction,
              sellSource: 'orphan',
            });
            this.exchange.deductCachedBalance(base, sellAmount);
            orphanPlaced++;
            this.log.info(`[grid] ${symbol}  sell  placed   ${sellAmount} @ ${sellPrice}  (orphan-sell)`);
            remaining -= sellAmount;
            priceStep++;

            // Safety: max N orphan sells per tick (from config, hot-reloadable)
            if (priceStep > this.config.orphanSellMaxPerTick) break;
          }
          levels.sort((a, b) => a.price - b.price);
          this.state.setGridLevels(symbol, levels);
          }
        }
      } catch (err) {
        this.log.warn(`Failed to place orphan-sell for ${symbol}: ${sanitizeError(err)}`);
      }
    }

    // EMA crossover is one-tick event — spams on whipsaw when emaFast≈emaSlow.
    // Current trend is in BOT SUMMARY (EMA col: bull/bear/flat) and in skip buy marker, so no separate log needed.

    // ⏳ HALVING (шаги 3+) — midpoint-halving trailing counter-sell после split rebalance DOWN.
    // Тикает каждый тик для sell-уровней с обоими runtime-полями (virtualNewSellPrice + nextStepAt).
    // На каждом истёкшем nextStepAt делим пополам расстояние между текущей ценой ордера и virtualNewSellPrice.
    // Защита oldBreakEven: halving не уводит цену ниже сохранённой безубыточной (см. max(oldBreakEven, midpoint)).
    if (this.config.counterSellTrailStepHours === 0) {
      // Отключено: для каждого level с незавершённым halving — прыгаем сразу на virtualNewSellPrice.
      const flushLevels = this.state.getGridLevels(symbol);
      let flushChanged = false;
      for (const level of flushLevels) {
        if (level.side !== 'sell' || level.amount <= 0) continue;
        if (!level.virtualNewSellPrice || level.virtualNewSellPrice <= 0) continue;
        const target = level.virtualNewSellPrice;
        if (level.price <= target) {
          level.nextStepAt = undefined;
          level.virtualNewSellPrice = undefined;
          flushChanged = true;
          continue;
        }
        if (level.orderId) {
          try {
            const orderStatus = await this.exchange.fetchOrder(level.orderId, symbol);
            if (orderStatus.filled > 0) {
              level.nextStepAt = undefined;
              level.virtualNewSellPrice = undefined;
              flushChanged = true;
              continue;
            }
            await this.exchange.cancelOrder(level.orderId, symbol);
            const order = await this.exchange.withRetry(
              () => this.exchange.createLimitSell(symbol, level.amount, target, 'grid'),
              `Counter-sell trail flush ${symbol} @ ${target}`,
            );
            this.log.info(`[grid] ${symbol}  sell  trailed  ${level.price.toFixed(6)} → ${target.toFixed(6)}  (counter-sell, direct)`);
            level.price = target;
            level.orderId = order.id;
            level.placedAt = Date.now();
          } catch (err) {
            this.log.warn(`Counter-sell trail flush failed for ${symbol}: ${sanitizeError(err)}`);
            level.orderId = undefined;
            level.price = target;
          }
        } else {
          level.price = target;
        }
        level.nextStepAt = undefined;
        level.virtualNewSellPrice = undefined;
        flushChanged = true;
      }
      if (flushChanged) this.state.setGridLevels(symbol, flushLevels);
    } else if (this.config.counterSellTrailStepHours > 0) {
      const trailingLevels = this.state.getGridLevels(symbol);
      let trailingChanged = false;
      const stepMs = this.config.counterSellTrailStepHours * 3600000;
      for (const level of trailingLevels) {
        if (level.side !== 'sell' || !level.orderId || level.amount <= 0) continue;
        if (!level.nextStepAt || !level.virtualNewSellPrice || level.virtualNewSellPrice <= 0) continue;
        if (Date.now() < level.nextStepAt) continue;

        const v = level.virtualNewSellPrice;
        const diff = Math.abs(level.price - v) / v;
        let newPrice: number;
        let finish = false;
        if (diff <= 0.05) {
          newPrice = v;
          finish = true;
        } else {
          const precision = await this.getPrecision(symbol);
          const midpoint = (level.price + v) / 2;
          newPrice = this.roundPriceForMarket(midpoint, precision.pricePrecision);
        }
        if (newPrice >= level.price) {
          // Защита от случая v >= текущей цены (не должно быть при DOWN, но на всякий)
          level.nextStepAt = undefined;
          level.virtualNewSellPrice = undefined;
          trailingChanged = true;
          continue;
        }

        try {
          const orderStatus = await this.exchange.fetchOrder(level.orderId, symbol);
          if (orderStatus.filled > 0) {
            this.log.info(`Counter-sell trail skipped: ${symbol} order already filled`, { symbol });
            continue;
          }
          await this.exchange.cancelOrder(level.orderId, symbol);
          const order = await this.exchange.withRetry(
            () => this.exchange.createLimitSell(symbol, level.amount, newPrice, 'grid'),
            `Counter-sell trail ${symbol} @ ${newPrice}`,
          );
          this.log.info(`[grid] ${symbol}  sell  trailed  ${level.price.toFixed(6)} → ${newPrice.toFixed(6)}  (counter-sell, ${finish ? 'halving done' : `halving, goal=${v.toFixed(6)}`})`);
          level.price = newPrice;
          level.orderId = order.id;
          level.placedAt = Date.now();
          if (finish) {
            level.nextStepAt = undefined;
            level.virtualNewSellPrice = undefined;
          } else {
            level.nextStepAt = Date.now() + stepMs;
          }
          trailingChanged = true;
        } catch (err) {
          this.log.warn(`Counter-sell trail failed for ${symbol}: ${sanitizeError(err)}`);
          level.orderId = undefined;
          level.price = newPrice;
          if (finish) {
            level.nextStepAt = undefined;
            level.virtualNewSellPrice = undefined;
          } else {
            level.nextStepAt = Date.now() + stepMs;
          }
          trailingChanged = true;
        }
      }
      if (trailingChanged) {
        this.state.setGridLevels(symbol, trailingLevels);
      }
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

  /**
   * Cancel all orders on exchange, but preserve ТОЛЬКО counter-sells (sellSource='counter').
   * Initial-grid-sells и orphan-sells НЕ preserve — они пересобираются от текущей цены.
   * Это решает проблему «stuck ladder»: когда старые ladder-sells на высоких ценах
   * застревают в state после падения цены и тянут новый ладдер вверх.
   *
   * Legacy-детект: для sells без sellSource (созданных до этой правки) считаем counter-sell,
   * если oldBreakEven заметно отличается от position break-even (avgEntry × 1.005) —
   * значит это не синтетический position-level anchor, а реальный от конкретной покупки.
   */
  private async cancelAllPreserveCounterSellMeta(symbol: string): Promise<void> {
    const levels = this.state.getGridLevels(symbol);
    const pos = this.state.getPosition(symbol);
    const positionBreakEven = pos.avgEntryPrice > 0
      ? pos.avgEntryPrice * (1 + this.config.minSellProfitPercent / 100)
      : 0;
    const isRealCounterSell = (l: GridLevelState): boolean => {
      if (l.side !== 'sell') return false;
      if (l.sellSource === 'counter') return true;
      if (l.sellSource === 'initial' || l.sellSource === 'orphan') return false;
      // Legacy: без sellSource. Реальный counter-sell имеет oldBreakEven, отличающийся от position-level.
      if (!l.oldBreakEven || positionBreakEven === 0) return false;
      const epsilon = positionBreakEven * 0.0005; // 0.05% tolerance
      return Math.abs(l.oldBreakEven - positionBreakEven) > epsilon;
    };
    const preserved: GridLevelState[] = levels
      .filter(isRealCounterSell)
      .map(l => ({
        ...l,
        orderId: undefined,
        filled: false,
        virtualNewSellPrice: undefined,
        nextStepAt: undefined,
        sellSource: 'counter' as const, // проставляем явный маркер для legacy
      }));
    await this.exchange.cancelAllOrders(symbol);
    this.state.setGridLevels(symbol, preserved);
    this.state.setGridInitialized(symbol, false);
    if (preserved.length > 0) {
      this.log.info(`[grid] ${symbol}  preserved ${preserved.length} counter-sell level(s) across rebalance (ladder will rebuild from currentPrice)`);
    }
  }

  /** Cancel only buy-side orders, keep sell orders intact (for split rebalance down) */
  private async cancelBuySide(symbol: string): Promise<void> {
    const levels = this.state.getGridLevels(symbol);
    for (const level of levels) {
      if (level.side === 'buy' && level.orderId) {
        try {
          await this.exchange.cancelOrder(level.orderId, symbol);
        } catch { /* already cancelled */ }
      }
    }
    // Keep only sell levels (with and without orderId)
    const sellLevels = levels.filter(l => l.side === 'sell');
    this.state.setGridLevels(symbol, sellLevels);
    this.log.info(`Split rebalance: kept ${sellLevels.length} sell levels, cancelled buy side`, { symbol });
  }

  /**
   * ⏳ HALVING (шаг 1-2 инициализации) — midpoint-halving trailing counter-sell после split rebalance DOWN.
   *
   * Запускается только из split rebalance DOWN (auto-rebalance DOWN в initGrid).
   * Заполняет runtime-поля halving для каждого counter-sell с anchors (oldBreakEven + originalPlannedSellPrice):
   *   • virtualNewSellPrice = currentPrice × (1 + sellSpacing/100) — новая целевая (низкая) цель halving
   *   • nextStepAt          = Date.now() + counterSellTrailStepHours × 3600000 — таймер следующего шага
   * Сразу же выполняет шаг 1 halving (новая цена = max(oldBreakEven, midpoint(originalPlannedSellPrice, virtualNewSellPrice))).
   * Дальнейшие шаги halving тикают на каждом тике в `placeGridOrders` (см. «HALVING (шаги 3+)» ниже).
   */
  private async initCounterSellTrailing(symbol: string, currentPrice: number): Promise<void> {
    if (this.config.counterSellTrailStepHours < 0) return;
    const levels = this.state.getGridLevels(symbol);
    const { sellSpacingPct } = this.getSpacing(symbol);
    const precision = await this.getPrecision(symbol);
    const virtualNewSellPrice = this.roundPriceForMarket(
      currentPrice * (1 + sellSpacingPct / 100),
      precision.pricePrecision,
    );
    const stepMs = this.config.counterSellTrailStepHours * 3600000;
    const halvingDisabled = this.config.counterSellTrailStepHours === 0;
    let changed = false;

    for (const level of levels) {
      if (level.side !== 'sell' || level.amount <= 0) continue;
      if (!level.originalPlannedSellPrice || !level.oldBreakEven) continue;
      // Только ордера выше virtualNewSellPrice имеет смысл спускать
      if (level.price <= virtualNewSellPrice) continue;

      level.virtualNewSellPrice = virtualNewSellPrice;

      if (!halvingDisabled && virtualNewSellPrice < level.oldBreakEven) {
        // Шаг 2 halving (первый шаг сползания): новая цена = max(oldBreakEven, midpoint(originalPlanned, virtualNew)).
        // Здесь oldBreakEven — жёсткий floor (только для Step 2), округляем ВВЕРХ чтобы rounding не увёл на 1 тик ниже.
        // На последующих шагах (Step 3+) floor oldBreakEven отсутствует по дизайну — halving может сползать ниже безубытка.
        const midpoint = (level.originalPlannedSellPrice + virtualNewSellPrice) / 2;
        const newPrice = this.roundPriceUpForMarket(
          Math.max(level.oldBreakEven, midpoint),
          precision.pricePrecision,
        );
        if (newPrice >= level.price) {
          // ордер уже стоит ниже/равно — ничего не делаем, но запускаем таймер для дальнейших шагов
          level.nextStepAt = Date.now() + stepMs;
          changed = true;
          continue;
        }
        if (level.orderId) {
          try {
            const orderStatus = await this.exchange.fetchOrder(level.orderId, symbol);
            if (orderStatus.filled > 0) {
              this.log.info(`Counter-sell trail init skipped: ${symbol} filled`, { symbol });
              continue;
            }
            await this.exchange.cancelOrder(level.orderId, symbol);
            const order = await this.exchange.withRetry(
              () => this.exchange.createLimitSell(symbol, level.amount, newPrice, 'grid'),
              `Counter-sell trail init ${symbol} @ ${newPrice}`,
            );
            this.log.info(`[grid] ${symbol}  sell  trailed  ${level.price.toFixed(6)} → ${newPrice.toFixed(6)}  (counter-sell, protected halving, goal=${virtualNewSellPrice.toFixed(6)})`);
            level.price = newPrice;
            level.orderId = order.id;
            level.placedAt = Date.now();
            level.nextStepAt = Date.now() + stepMs;
            changed = true;
          } catch (err) {
            this.log.warn(`Counter-sell trail init failed for ${symbol}: ${sanitizeError(err)}`);
            // Сбрасываем orderId чтобы следующий тик не обратился к отменённому ордеру
            level.orderId = undefined;
            level.price = newPrice;
            level.nextStepAt = Date.now() + stepMs;
            changed = true;
          }
        } else {
          // Нет orderId — обновляем target, placeGridOrders поставит на новой цене
          level.price = newPrice;
          level.nextStepAt = Date.now() + stepMs;
          changed = true;
        }
      } else {
        // Шаг 3: virtualNewSellPrice >= oldBreakEven → сразу ставим на virtualNewSellPrice, halving не нужен
        if (level.orderId) {
          try {
            const orderStatus = await this.exchange.fetchOrder(level.orderId, symbol);
            if (orderStatus.filled > 0) continue;
            await this.exchange.cancelOrder(level.orderId, symbol);
            const order = await this.exchange.withRetry(
              () => this.exchange.createLimitSell(symbol, level.amount, virtualNewSellPrice, 'grid'),
              `Counter-sell trail step3 ${symbol} @ ${virtualNewSellPrice}`,
            );
            this.log.info(`[grid] ${symbol}  sell  trailed  ${level.price.toFixed(6)} → ${virtualNewSellPrice.toFixed(6)}  (counter-sell, direct)`);
            level.price = virtualNewSellPrice;
            level.orderId = order.id;
            level.placedAt = Date.now();
            level.nextStepAt = undefined;
            level.virtualNewSellPrice = undefined;
            changed = true;
          } catch (err) {
            this.log.warn(`Counter-sell trail step3 failed for ${symbol}: ${sanitizeError(err)}`);
            level.orderId = undefined;
            level.price = virtualNewSellPrice;
            level.nextStepAt = undefined;
            level.virtualNewSellPrice = undefined;
            changed = true;
          }
        } else {
          level.price = virtualNewSellPrice;
          level.nextStepAt = undefined;
          level.virtualNewSellPrice = undefined;
          changed = true;
        }
      }
    }

    if (changed) this.state.setGridLevels(symbol, levels);
  }
}

// Old hardcoded roundPrice/roundAmount removed — replaced by market-aware methods in GridStrategy class
