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
  private lastIndicators: Map<string, IndicatorSnapshot> = new Map();
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

  // RSI + EMA filter: should we allow grid buy orders?
  isBuyAllowed(symbol: string): { allowed: boolean; reason: string } {
    const ind = this.lastIndicators.get(symbol);
    if (!ind) return { allowed: true, reason: 'no indicators yet' };

    // Skip buy if RSI overbought
    const rsiThreshold = this.config.rsiOverboughtThreshold;
    if (ind.rsi > rsiThreshold) {
      return { allowed: false, reason: `RSI=${ind.rsi.toFixed(0)} > ${rsiThreshold} (overbought)` };
    }

    // Skip buy if bearish EMA crossover
    if (this.config.useEmaFilter && ind.emaCrossover === 'bearish') {
      return { allowed: false, reason: `EMA bearish crossover (fast ${ind.emaFast.toFixed(2)} < slow ${ind.emaSlow.toFixed(2)})` };
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
        // Check if price has drifted far from grid center — rebalance if needed
        const lowestPrice = savedLevels[0].price;
        const highestPrice = savedLevels[savedLevels.length - 1].price;
        const gridCenter = (lowestPrice + highestPrice) / 2;
        const driftPercent = Math.abs(currentPrice - gridCenter) / gridCenter * 100;

        if (driftPercent > 5) {
          // Price moved >5% from grid center — cancel all and reinitialize
          this.log.warn(`Grid rebalance for ${symbol}: price drifted ${driftPercent.toFixed(1)}% from center (${gridCenter.toFixed(2)} → ${currentPrice.toFixed(2)})`);
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
      }
    }

    const precision = await this.getPrecision(symbol);
    const { gridLevels, gridSpacingPercent } = this.config;
    const buyLevels = Math.floor(gridLevels / 2);
    const sellLevels = Math.ceil(gridLevels / 2);
    const spacing = currentPrice * (gridSpacingPercent / 100);
    const levels: GridLevelState[] = [];
    const usedPrices = new Set<number>();

    // Buy levels below price
    for (let i = 1; i <= buyLevels; i++) {
      const price = this.roundPriceForMarket(currentPrice - spacing * i, precision.pricePrecision);
      if (usedPrices.has(price)) continue; // skip duplicate after rounding
      usedPrices.add(price);
      levels.push({ price, side: 'buy', filled: false });
    }

    // Sell levels above price
    for (let i = 1; i <= sellLevels; i++) {
      const price = this.roundPriceForMarket(currentPrice + spacing * i, precision.pricePrecision);
      if (usedPrices.has(price)) continue; // skip duplicate after rounding
      usedPrices.add(price);
      levels.push({ price, side: 'sell', filled: false });
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

    // Pre-fetch balances for buy/sell-side checks
    const base = symbol.split('/')[0]; // "BTC" from "BTC/USDT"
    let freeCrypto = 0;
    let freeUSDT = 0;
    try {
      const allBalances = await this.exchange.fetchAllBalances();
      freeCrypto = allBalances[base]?.free ?? 0;
      freeUSDT = allBalances['USDT']?.free ?? 0;
    } catch (err) {
      this.log.warn(`Failed to fetch balances for grid checks: ${err}`);
    }

    for (const level of levels) {
      if (level.orderId || level.filled) continue;

      try {
        let amount = this.roundAmountForMarket(orderBudget / level.price, precision.amountPrecision);

        // Bump up to exchange minimum if too small, but don't exceed budget
        if (amount < precision.minAmount) {
          if (precision.minAmount * level.price > orderBudget * 1.5) {
            this.log.debug(`Grid order for ${symbol} at ${level.price}: min amount costs ${(precision.minAmount * level.price).toFixed(2)} but budget is ${orderBudget.toFixed(2)}. Skipping.`);
            continue;
          }
          amount = precision.minAmount;
          this.log.debug(`Grid order bumped to minAmount for ${symbol}: ${amount}`);
        }
        if (amount * level.price < precision.minCost) {
          const minAmountForCost = Math.ceil((precision.minCost / level.price) * Math.pow(10, precision.amountPrecision)) / Math.pow(10, precision.amountPrecision);
          if (minAmountForCost * level.price > orderBudget * 1.5) {
            this.log.debug(`Grid order for ${symbol} at ${level.price}: minCost requires ${(minAmountForCost * level.price).toFixed(2)} but budget is ${orderBudget.toFixed(2)}. Skipping.`);
            continue;
          }
          amount = Math.max(amount, minAmountForCost);
          this.log.debug(`Grid order bumped to minCost for ${symbol}: ${amount} (~${(amount * level.price).toFixed(2)} USDT)`);
        }

        if (level.side === 'buy' && level.price < currentPrice) {
          // RSI + EMA filter
          const buyCheck = this.isBuyAllowed(symbol);
          if (!buyCheck.allowed) {
            this.log.debug(`Grid buy skipped for ${symbol} at ${level.price}: ${buyCheck.reason}`);
            continue;
          }
          const orderCost = amount * level.price;
          if (freeUSDT < orderCost) {
            this.log.debug(`Grid buy skipped for ${symbol}: free USDT=${freeUSDT.toFixed(2)} < needed ${orderCost.toFixed(2)}`);
            continue;
          }
          const order = await this.exchange.withRetry(
            () => this.exchange.createLimitBuy(symbol, amount, level.price, 'grid'),
            `Grid buy ${symbol} @ ${level.price}`,
          );
          level.orderId = order.id;
          freeUSDT -= orderCost;
        } else if (level.side === 'sell' && level.price > currentPrice) {
          // Check if we have enough free crypto to place this sell
          if (freeCrypto < amount) {
            this.log.debug(`Grid sell skipped for ${symbol}: free ${base}=${freeCrypto.toFixed(8)} < needed ${amount}`);
            continue;
          }
          const order = await this.exchange.withRetry(
            () => this.exchange.createLimitSell(symbol, amount, level.price, 'grid'),
            `Grid sell ${symbol} @ ${level.price}`,
          );
          level.orderId = order.id;
          // Subtract placed amount from tracked free balance (for subsequent sell levels)
          freeCrypto -= amount;
        }
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes('InsufficientFunds') || errStr.includes('Insufficient balance')) {
          this.log.debug(`Grid order skipped (insufficient balance) for ${symbol} at ${level.price}`);
          break; // no point trying remaining levels if balance is depleted
        }
        this.log.error(`Failed to place grid order: ${err}`, { symbol });
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

    // Store latest indicators for buy filter
    this.lastIndicators.set(symbol, indicators);

    const freshlyInitialized = await this.initGrid(symbol, ticker.last, allocationUSDT);

    const decisions: StrategyDecision[] = [];
    const levels = this.state.getGridLevels(symbol);

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
          const expectedAmount = this.roundAmountForMarket(
            (allocationUSDT * this.config.orderSizePercent / 100) / filledPrice,
            precision.amountPrecision,
          );

          // Determine actual filled amount
          const filledAmount = orderInfo.filled > 0 ? orderInfo.filled : expectedAmount;
          // CRITICAL: never use price=0 — fallback to the level's limit price
          const actualPrice = orderInfo.price > 0 ? orderInfo.price : filledPrice;
          if (actualPrice <= 0) {
            this.log.error(`Grid fill for ${symbol} has price=0! Skipping to avoid position corruption.`);
            level.orderId = undefined;
            level.filled = false;
            levelsChanged = true;
            continue;
          }

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

          // Check if pair was halted by SL/TP — fill is already recorded above, skip counter-order only
          if (this.state.isPairHalted(symbol)) {
            this.log.warn(`Grid: fill recorded for ${symbol}, but skipping counter-order — pair halted by SL/TP`);
            level.orderId = undefined;
            level.filled = false;
            levelsChanged = true;
            continue;
          }

          // Calculate counter-order with proper precision
          const rawCounterPrice = filledSide === 'buy'
            ? filledPrice * (1 + this.config.gridSpacingPercent / 100)
            : filledPrice * (1 - this.config.gridSpacingPercent / 100);
          const counterPrice = this.roundPriceForMarket(rawCounterPrice, precision.pricePrecision);
          const counterSide: 'buy' | 'sell' = filledSide === 'buy' ? 'sell' : 'buy';

          // BUG #3 fix: use the SAME amount from the filled order, rounded to market precision
          const counterAmount = this.roundAmountForMarket(filledAmount, precision.amountPrecision);

          // Skip counter-order if below exchange minimums
          const counterValue = counterAmount * counterPrice;
          if (counterAmount < precision.minAmount || counterValue < precision.minCost) {
            this.log.debug(`Grid counter-order too small for ${symbol}: ${counterAmount} @ ${counterPrice} = ${counterValue.toFixed(2)} USDT (min: ${precision.minAmount} / ${precision.minCost} USDT)`);
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
              try {
                const balances = await this.exchange.fetchAllBalances();
                const base = symbol.split('/')[0];
                const freeBal = balances[base]?.free ?? 0;
                if (freeBal < counterAmount) {
                  this.log.warn(`Grid counter-sell skipped for ${symbol}: free ${base}=${freeBal.toFixed(8)} < needed ${counterAmount}`);
                  level.orderId = undefined;
                  level.filled = false;
                  levelsChanged = true;
                  continue;
                }
              } catch (balErr) {
                this.log.warn(`Failed to check balance for counter-sell, proceeding anyway: ${balErr}`);
              }
              const order = await this.exchange.withRetry(
                () => this.exchange.createLimitSell(symbol, counterAmount, counterPrice, 'grid'),
                `Grid counter-sell ${symbol} @ ${counterPrice}`,
              );
              counterOrderId = order.id;
            } else {
              // RSI + EMA filter for counter-buy
              const buyCheck = this.isBuyAllowed(symbol);
              if (!buyCheck.allowed) {
                this.log.debug(`Grid counter-buy skipped for ${symbol}: ${buyCheck.reason}`);
                level.orderId = undefined;
                level.filled = false;
                levelsChanged = true;
                continue;
              }
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
