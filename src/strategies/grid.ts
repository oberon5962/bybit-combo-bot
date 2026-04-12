// ============================================================
// Bybit Combo Bot — Grid Trading Strategy (with persistence)
// ============================================================

import {
  BotConfig, GridConfig, Ticker, IndicatorSnapshot,
  StrategyDecision, Logger,
} from '../types';
import { BybitExchange } from '../exchange';
import { StateManager, GridLevelState } from '../state';

export class GridStrategy {
  private config: GridConfig;
  private exchange: BybitExchange;
  private log: Logger;
  private state: StateManager;
  private restoredLogged: Set<string> = new Set(); // prevent repeated "Grid restored" logs
  // BUG #12 fix: cache market precision per symbol
  private precisionCache: Map<string, { pricePrecision: number; amountPrecision: number; minAmount: number; minCost: number }> = new Map();

  constructor(config: BotConfig, exchange: BybitExchange, log: Logger, state: StateManager) {
    this.config = config.grid;
    this.exchange = exchange;
    this.log = log;
    this.state = state;
  }

  private async getPrecision(symbol: string) {
    if (!this.precisionCache.has(symbol)) {
      const p = await this.exchange.getMarketPrecision(symbol);
      this.precisionCache.set(symbol, p);
      this.log.info(`Market precision for ${symbol}: price=${p.pricePrecision}, amount=${p.amountPrecision}, minAmount=${p.minAmount}, minCost=${p.minCost}`);
    }
    return this.precisionCache.get(symbol)!;
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
    }

    const precision = await this.getPrecision(symbol);
    const { gridLevels, gridSpacingPercent } = this.config;
    const halfLevels = Math.floor(gridLevels / 2);
    const spacing = currentPrice * (gridSpacingPercent / 100);
    const levels: GridLevelState[] = [];

    // Buy levels below price
    for (let i = 1; i <= halfLevels; i++) {
      levels.push({
        price: this.roundPriceForMarket(currentPrice - spacing * i, precision.pricePrecision),
        side: 'buy',
        filled: false,
      });
    }

    // Sell levels above price
    for (let i = 1; i <= halfLevels; i++) {
      levels.push({
        price: this.roundPriceForMarket(currentPrice + spacing * i, precision.pricePrecision),
        side: 'sell',
        filled: false,
      });
    }

    levels.sort((a, b) => a.price - b.price);

    // Save to state
    this.state.setGridLevels(symbol, levels);
    this.state.setGridInitialized(symbol, true);

    this.log.info(`Grid initialized for ${symbol}`, {
      levels: gridLevels,
      spacing: `${gridSpacingPercent}%`,
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
    const orderBudget = allocationUSDT * (this.config.orderSizePercent / 100);

    // Pre-fetch free crypto balance for sell-side checks
    const base = symbol.split('/')[0]; // "BTC" from "BTC/USDT"
    let freeCrypto = 0;
    try {
      const allBalances = await this.exchange.fetchAllBalances();
      freeCrypto = allBalances[base]?.free ?? 0;
    } catch (err) {
      this.log.warn(`Failed to fetch ${base} balance for grid sell check: ${err}`);
    }

    for (const level of levels) {
      if (level.orderId || level.filled) continue;

      try {
        const amount = this.roundAmountForMarket(orderBudget / level.price, precision.amountPrecision);

        // Skip if amount is below exchange minimum
        if (amount < precision.minAmount) {
          this.log.warn(`Grid order too small for ${symbol}: ${amount} < min ${precision.minAmount}`);
          continue;
        }
        if (amount * level.price < precision.minCost) {
          this.log.warn(`Grid order value too small for ${symbol}: ${(amount * level.price).toFixed(2)} USDT < min ${precision.minCost}`);
          continue;
        }

        if (level.side === 'buy' && level.price < currentPrice) {
          const order = await this.exchange.createLimitBuy(
            symbol, amount, level.price, 'grid',
          );
          level.orderId = order.id;
        } else if (level.side === 'sell' && level.price > currentPrice) {
          // Check if we have enough free crypto to place this sell
          if (freeCrypto < amount) {
            this.log.debug(`Grid sell skipped for ${symbol}: free ${base}=${freeCrypto.toFixed(8)} < needed ${amount}`);
            continue;
          }
          const order = await this.exchange.createLimitSell(
            symbol, amount, level.price, 'grid',
          );
          level.orderId = order.id;
          // Subtract placed amount from tracked free balance (for subsequent sell levels)
          freeCrypto -= amount;
        }
      } catch (err) {
        this.log.error(`Failed to place grid order: ${err}`, { symbol, level });
      }
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
  ): Promise<StrategyDecision[]> {
    if (!this.config.enabled) return [];

    const freshlyInitialized = await this.initGrid(symbol, ticker.last, allocationUSDT);

    const decisions: StrategyDecision[] = [];
    const levels = this.state.getGridLevels(symbol);

    // Check if any orders have filled
    try {
      const openOrders = await this.exchange.fetchOpenOrders(symbol);
      const openIds = new Set(openOrders.map((o) => o.id));

      let levelsChanged = false;

      for (const level of levels) {
        if (level.orderId && !openIds.has(level.orderId)) {
          const precision = await this.getPrecision(symbol);
          const filledSide = level.side;
          const filledPrice = level.price;

          // BUG #14 fix: check actual fill status — could be partial fill + cancel
          const orderInfo = await this.exchange.fetchOrder(level.orderId, symbol);
          const expectedAmount = this.roundAmountForMarket(
            (allocationUSDT * this.config.orderSizePercent / 100) / filledPrice,
            precision.amountPrecision,
          );

          // Determine actual filled amount
          const filledAmount = orderInfo.filled > 0 ? orderInfo.filled : expectedAmount;
          const actualPrice = orderInfo.price > 0 ? orderInfo.price : filledPrice;

          if (orderInfo.status === 'canceled' && orderInfo.filled === 0) {
            // Order was cancelled without any fill — just clear it
            this.log.warn(`Grid ${filledSide} at ${filledPrice} was cancelled (no fill), resetting level`, { symbol });
            level.orderId = undefined;
            level.filled = false;
            levelsChanged = true;
            continue;
          }

          if (orderInfo.filled > 0 && orderInfo.filled < expectedAmount * 0.95) {
            this.log.warn(`Grid ${filledSide} at ${filledPrice} PARTIALLY filled: ${orderInfo.filled}/${expectedAmount}`, { symbol });
          }

          levelsChanged = true;
          this.log.info(`Grid ${filledSide} filled at ${actualPrice}`, { symbol, amount: filledAmount });

          // Record filled trade with actual amounts
          this.state.addTrade({
            timestamp: Date.now(),
            symbol,
            side: filledSide,
            amount: filledAmount,
            price: actualPrice,
            cost: filledAmount * actualPrice,
            strategy: 'grid',
          });

          // Track position for stop-loss / take-profit
          if (filledSide === 'buy') {
            this.state.addToPosition(symbol, filledAmount, filledAmount * actualPrice);
          } else {
            this.state.reducePosition(symbol, filledAmount);
          }

          // Calculate counter-order with proper precision
          const rawCounterPrice = filledSide === 'buy'
            ? filledPrice * (1 + this.config.gridSpacingPercent / 100)
            : filledPrice * (1 - this.config.gridSpacingPercent / 100);
          const counterPrice = this.roundPriceForMarket(rawCounterPrice, precision.pricePrecision);
          const counterSide: 'buy' | 'sell' = filledSide === 'buy' ? 'sell' : 'buy';

          // BUG #3 fix: use the SAME amount from the filled order, not recalculated
          const counterAmount = filledAmount;

          // BUG #7 fix: execute counter-order HERE, and only update state AFTER success
          try {
            let counterOrderId: string | undefined;
            if (counterSide === 'sell') {
              const order = await this.exchange.createLimitSell(
                symbol, counterAmount, counterPrice, 'grid',
              );
              counterOrderId = order.id;
            } else {
              const order = await this.exchange.createLimitBuy(
                symbol, counterAmount, counterPrice, 'grid',
              );
              counterOrderId = order.id;
            }

            this.log.info(`Grid counter-order placed: ${counterSide} ${counterAmount} @ ${counterPrice}`, { symbol });

            // Only update level state AFTER counter-order confirmed placed
            level.orderId = counterOrderId;
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
            // Reset level to unfilled so it will be retried next tick
            level.orderId = undefined;
            level.filled = false;
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
