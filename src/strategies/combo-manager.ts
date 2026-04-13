// ============================================================
// Bybit Combo Bot — Combo Strategy Manager (with persistence)
// ============================================================

import {
  BotConfig, PairConfig, Ticker, IndicatorSnapshot,
  StrategyDecision, Logger,
} from '../types';
import { BybitExchange } from '../exchange';
import { computeIndicators } from '../indicators';
import { GridStrategy } from './grid';
import { DCAStrategy } from './dca';
import { StateManager } from '../state';

export class ComboManager {
  private config: BotConfig;
  private exchange: BybitExchange;
  private log: Logger;
  private grid: GridStrategy;
  private dca: DCAStrategy;
  private state: StateManager;
  private marketPrecisionCache: Map<string, { amountPrecision: number; minAmount: number; minCost: number }> = new Map();

  constructor(config: BotConfig, exchange: BybitExchange, log: Logger, state: StateManager) {
    this.config = config;
    this.exchange = exchange;
    this.log = log;
    this.state = state;
    this.grid = new GridStrategy(config, exchange, log, state);
    this.dca = new DCAStrategy(config, exchange, log, state);
  }

  // ----------------------------------------------------------
  // Initialize
  // ----------------------------------------------------------

  async init(): Promise<void> {
    // Calculate TOTAL portfolio value (USDT + crypto holdings) for accurate capital tracking
    const { single: balance, all: allBalances } = await this.exchange.fetchBalanceAndAll('USDT');
    let totalPortfolioValue = balance.total;

    for (const pair of this.config.pairs) {
      const base = pair.symbol.split('/')[0];
      const held = allBalances[base];
      if (held && held.total > 0) {
        try {
          const ticker = await this.exchange.fetchTicker(pair.symbol);
          totalPortfolioValue += held.total * ticker.last;
        } catch (err) {
          this.log.error(`Failed to fetch ${pair.symbol} price during init: ${err}`);
        }
      }
    }

    if (this.state.startingCapital === 0) {
      this.state.startingCapital = totalPortfolioValue;
    }
    if (this.state.peakCapital === 0 || totalPortfolioValue > this.state.peakCapital) {
      this.state.peakCapital = totalPortfolioValue;
    }

    // Auto-reset per-pair halts on restart — restart IS the manual intervention
    for (const pair of this.config.pairs) {
      if (this.state.isPairHalted(pair.symbol)) {
        this.log.info(`Auto-resuming halted pair ${pair.symbol} (bot restart = manual review)`);
        this.state.resetPairHalt(pair.symbol);
      }
    }

    const trades = this.state.getRecentTrades();
    this.log.info('ComboManager initialized', {
      usdtBalance: balance.total,
      totalPortfolioValue: totalPortfolioValue.toFixed(2),
      pairs: this.config.pairs.map((p) => p.symbol),
      savedTrades: trades.length,
      totalTicks: this.state.totalTicks,
      resumed: this.state.totalTicks > 0 ? 'YES — continuing from saved state' : 'NO — fresh start',
    });
  }

  // ----------------------------------------------------------
  // Main tick
  // ----------------------------------------------------------

  async tick(): Promise<void> {
    if (this.state.halted) {
      const haltedPairs = this.config.pairs
        .filter(p => this.state.isPairHalted(p.symbol))
        .map(p => {
          const reason = this.state.getHaltReason(p.symbol) ?? 'unknown';
          return `${p.symbol} (${reason})`;
        });
      const pairInfo = haltedPairs.length > 0
        ? ` Halted pairs: ${haltedPairs.join(', ')}`
        : '';
      this.log.warn(`Bot is HALTED due to drawdown limit.${pairInfo} Manual intervention required.`);
      return;
    }

    // Fetch USDT + all balances in ONE API call (instead of two)
    const { single: currentBalance, all: allBalances } = await this.exchange.fetchBalanceAndAll('USDT');
    let totalPortfolioUSDT = currentBalance.total;

    // Add value of held crypto to portfolio total
    for (const pair of this.config.pairs) {
      const base = pair.symbol.split('/')[0]; // "BTC" from "BTC/USDT"
      const held = allBalances[base];
      if (held && held.total > 0) {
        try {
          const ticker = await this.exchange.fetchTicker(pair.symbol);
          totalPortfolioUSDT += held.total * ticker.last;
        } catch (err) {
          this.log.error(`Failed to fetch ticker for ${pair.symbol} during portfolio calc: ${err}`);
        }
      }
    }

    // Update peak capital
    if (totalPortfolioUSDT > this.state.peakCapital) {
      this.state.peakCapital = totalPortfolioUSDT;
    }

    // Check MAX DRAWDOWN — halt if portfolio drops too much
    const drawdown = this.state.peakCapital > 0
      ? ((this.state.peakCapital - totalPortfolioUSDT) / this.state.peakCapital) * 100
      : 0;
    if (drawdown > this.config.risk.maxDrawdownPercent) {
      this.log.error(`MAX DRAWDOWN EXCEEDED: ${drawdown.toFixed(1)}% > ${this.config.risk.maxDrawdownPercent}%`);
      this.log.error('HALTING ALL TRADING.');
      this.state.halted = true;
      return;
    }

    // Check PORTFOLIO TAKE PROFIT — sell everything if target reached
    if (this.state.startingCapital <= 0) {
      this.log.warn('startingCapital not set, skipping take profit check');
    }
    const profitPercent = this.state.startingCapital > 0
      ? ((totalPortfolioUSDT - this.state.startingCapital) / this.state.startingCapital) * 100
      : 0;
    if (this.state.startingCapital > 0 && profitPercent >= this.config.risk.portfolioTakeProfitPercent) {
      this.log.info('='.repeat(60));
      this.log.info(`PORTFOLIO TAKE PROFIT TRIGGERED!`);
      this.log.info(`Started with: ${this.state.startingCapital.toFixed(2)} USDT`);
      this.log.info(`Current value: ${totalPortfolioUSDT.toFixed(2)} USDT (+${profitPercent.toFixed(1)}%)`);
      this.log.info(`Target was: +${this.config.risk.portfolioTakeProfitPercent}%`);
      this.log.info('Selling all positions...');
      this.log.info('='.repeat(60));

      await this.sellEverything();
      this.state.halted = true;
      this.log.info('All positions sold. Bot halted. Congratulations!');
      return;
    }

    // Record tick
    this.state.recordTick();

    // Process each trading pair
    // Use TOTAL USDT (not free) for allocation calculation — free fluctuates as grid locks funds
    for (const pair of this.config.pairs) {
      // Re-check global halted state (drawdown / portfolio TP)
      if (this.state.halted) {
        this.log.warn(`Bot halted mid-tick (global), skipping remaining pairs`);
        break;
      }
      try {
        await this.processPair(pair, currentBalance.total);
      } catch (err) {
        this.log.error(`Error processing ${pair.symbol}: ${err}`);
      }
    }

    // Log summary every 10 ticks
    if (this.state.totalTicks % 10 === 0) {
      this.logSummary(totalPortfolioUSDT);
    }
  }

  // ----------------------------------------------------------
  // Process a single pair
  // ----------------------------------------------------------

  private async processPair(pair: PairConfig, totalUSDT: number): Promise<void> {
    const { symbol } = pair;

    // Skip halted pairs (SL/TP triggered on this pair)
    if (this.state.isPairHalted(symbol)) {
      this.log.debug(`Skipping ${symbol} — pair is halted (SL/TP triggered)`);
      return;
    }

    // Use TOTAL USDT for allocation — free balance fluctuates as grid locks funds in orders.
    // Grid internally checks free balance before placing sells, so over-allocation is safe.
    const allocationUSDT = totalUSDT * (pair.allocationPercent / 100);

    const [ticker, candles] = await Promise.all([
      this.exchange.fetchTicker(symbol),
      this.exchange.fetchOHLCV(symbol, '5m', 100),
    ]);

    // Pre-cache amount precision for this symbol (used by evaluateMetaSignal)
    if (!this.marketPrecisionCache.has(symbol)) {
      try {
        const mp = await this.exchange.getMarketPrecision(symbol);
        this.marketPrecisionCache.set(symbol, { amountPrecision: mp.amountPrecision, minAmount: mp.minAmount, minCost: mp.minCost });
      } catch (err) {
        this.log.warn(`Failed to get precision for ${symbol}: ${err}`);
      }
    }

    const indicators = computeIndicators(candles, this.config.indicators);

    this.log.debug(`${symbol} | Price: ${ticker.last} | RSI: ${indicators.rsi.toFixed(1)} | EMA: ${indicators.emaCrossover} | BB: ${indicators.pricePosition}`, {
      symbol,
    });

    // ---- Per-position stop-loss / take-profit check ----
    const slTriggered = await this.checkPositionStopLossTakeProfit(symbol, ticker.last);
    if (slTriggered) {
      // Position was closed by SL/TP — skip normal strategy evaluation this tick
      return;
    }

    const allDecisions: StrategyDecision[] = [];

    const gridDecisions = await this.grid.evaluate(symbol, ticker, indicators, allocationUSDT);
    allDecisions.push(...gridDecisions);

    const dcaDecisions = await this.dca.evaluate(symbol, ticker, indicators, allocationUSDT);
    allDecisions.push(...dcaDecisions);

    const metaSignal = this.evaluateMetaSignal(indicators, ticker, allocationUSDT);
    if (metaSignal) {
      allDecisions.push(metaSignal);
    }

    for (const decision of allDecisions) {
      await this.executeDecision(decision, indicators);
    }
  }

  // ----------------------------------------------------------
  // Meta-signal
  // ----------------------------------------------------------

  private roundAmountForSymbol(amount: number, symbol: string): number {
    const cached = this.marketPrecisionCache.get(symbol);
    const precision = cached?.amountPrecision ?? 5;
    const factor = Math.pow(10, precision);
    return Math.floor(amount * factor) / factor;
  }

  private evaluateMetaSignal(
    indicators: IndicatorSnapshot,
    ticker: Ticker,
    allocationUSDT: number,
  ): StrategyDecision | null {
    const { rsi, emaCrossover, pricePosition } = indicators;
    const sym = ticker.symbol;

    // Meta-signal order size: 5% of pair allocation for regular, 8% for strong
    const regularAmount = (allocationUSDT * 0.05) / ticker.last;
    const strongAmount = (allocationUSDT * 0.08) / ticker.last;

    const cached = this.marketPrecisionCache.get(sym);
    const minAmount = cached?.minAmount ?? 0;
    const minCost = cached?.minCost ?? 0;

    // Helper: check if amount meets exchange minimums
    const isViableOrder = (amount: number): boolean => {
      if (amount < minAmount) {
        this.log.debug(`[combo-meta] ${sym}: amount ${amount} < minAmount ${minAmount}, skipping`);
        return false;
      }
      if (amount * ticker.last < minCost) {
        this.log.debug(`[combo-meta] ${sym}: cost ${(amount * ticker.last).toFixed(2)} < minCost ${minCost}, skipping`);
        return false;
      }
      return true;
    };

    if (rsi < 25 && emaCrossover === 'bullish' && pricePosition === 'below_lower') {
      const amount = this.roundAmountForSymbol(strongAmount, sym);
      if (!isViableOrder(amount)) return null;
      return {
        strategy: 'combo-meta',
        signal: 'strong_buy',
        symbol: sym,
        suggestedAmount: amount,
        reason: `STRONG BUY signal: RSI=${rsi.toFixed(0)}, bullish EMA cross, below Bollinger lower`,
      };
    }

    if (rsi > 75 && emaCrossover === 'bearish' && pricePosition === 'above_upper') {
      const pos = this.state.getPosition(sym);
      const sellAmount = pos.amount > 0 ? Math.min(this.roundAmountForSymbol(strongAmount, sym), pos.amount) : 0;
      if (sellAmount <= 0 || !isViableOrder(sellAmount)) return null;
      return {
        strategy: 'combo-meta',
        signal: 'strong_sell',
        symbol: sym,
        suggestedAmount: sellAmount,
        reason: `STRONG SELL signal: RSI=${rsi.toFixed(0)}, bearish EMA cross, above Bollinger upper`,
      };
    }

    if (rsi < 35 && pricePosition === 'below_middle') {
      const amount = this.roundAmountForSymbol(regularAmount, sym);
      if (!isViableOrder(amount)) return null;
      return {
        strategy: 'combo-meta',
        signal: 'buy',
        symbol: sym,
        suggestedAmount: amount,
        reason: `BUY signal: RSI=${rsi.toFixed(0)}, price below Bollinger middle`,
      };
    }

    if (rsi > 65 && pricePosition === 'above_upper') {
      const pos2 = this.state.getPosition(sym);
      const sellAmt = pos2.amount > 0 ? Math.min(this.roundAmountForSymbol(regularAmount, sym), pos2.amount) : 0;
      if (sellAmt <= 0 || !isViableOrder(sellAmt)) return null;
      return {
        strategy: 'combo-meta',
        signal: 'sell',
        symbol: sym,
        suggestedAmount: sellAmt,
        reason: `SELL signal: RSI=${rsi.toFixed(0)}, price above Bollinger upper`,
      };
    }

    return null;
  }

  // ----------------------------------------------------------
  // Per-position stop-loss / take-profit
  // ----------------------------------------------------------

  private async checkPositionStopLossTakeProfit(
    symbol: string,
    currentPrice: number,
  ): Promise<boolean> {
    const position = this.state.getPosition(symbol);
    if (position.amount <= 0) return false;

    // Guard: if avgEntryPrice is 0 or negative (state corruption), reset position to prevent division by zero
    if (position.avgEntryPrice <= 0) {
      this.log.error(`Invalid avgEntryPrice for ${symbol}: ${position.avgEntryPrice} with amount ${position.amount}. Resetting position.`);
      this.state.resetPosition(symbol);
      return false;
    }

    const { stopLossPercent, takeProfitPercent } = this.config.risk;
    const pnlPercent = ((currentPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100;

    // STOP-LOSS: price dropped below entry by stopLossPercent
    if (pnlPercent <= -stopLossPercent) {
      this.log.warn('='.repeat(60));
      this.log.warn(`STOP-LOSS TRIGGERED for ${symbol}!`);
      this.log.warn(`Entry avg: ${position.avgEntryPrice.toFixed(2)} | Current: ${currentPrice.toFixed(2)} | PnL: ${pnlPercent.toFixed(1)}%`);
      this.log.warn(`Selling ${position.amount} to limit losses`);
      this.log.warn('='.repeat(60));

      await this.closePosition(symbol, position.amount, currentPrice, 'stop-loss');
      // HALT only THIS PAIR — other pairs continue trading
      this.state.haltPair(symbol, `stop-loss: entry ${position.avgEntryPrice.toFixed(2)}, exit ${currentPrice.toFixed(2)}, PnL ${pnlPercent.toFixed(1)}%`);
      this.log.warn(`Pair ${symbol} HALTED after stop-loss. Other pairs continue. Restart bot to resume this pair.`);
      return true;
    }

    // TAKE-PROFIT: price rose above entry by takeProfitPercent
    if (pnlPercent >= takeProfitPercent) {
      this.log.info('='.repeat(60));
      this.log.info(`TAKE-PROFIT TRIGGERED for ${symbol}!`);
      this.log.info(`Entry avg: ${position.avgEntryPrice.toFixed(2)} | Current: ${currentPrice.toFixed(2)} | PnL: +${pnlPercent.toFixed(1)}%`);
      this.log.info(`Selling ${position.amount} to lock in profit`);
      this.log.info('='.repeat(60));

      await this.closePosition(symbol, position.amount, currentPrice, 'take-profit');
      // HALT only THIS PAIR — other pairs continue trading
      this.state.haltPair(symbol, `take-profit: entry ${position.avgEntryPrice.toFixed(2)}, exit ${currentPrice.toFixed(2)}, PnL +${pnlPercent.toFixed(1)}%`);
      this.log.info(`Pair ${symbol} HALTED after take-profit. Other pairs continue. Restart bot to resume this pair.`);
      return true;
    }

    return false;
  }

  private async closePosition(
    symbol: string,
    amount: number,
    currentPrice: number,
    reason: 'stop-loss' | 'take-profit',
  ): Promise<void> {
    try {
      // Cancel all open grid orders for this pair first
      await this.grid.cancelAll(symbol);
      this.log.info(`Cancelled grid orders for ${symbol} before ${reason} sell`);

      // Wait briefly for cancellations to settle
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check actual free balance (some may have been in orders)
      const allBalances = await this.exchange.fetchAllBalances();
      const base = symbol.split('/')[0];
      const held = allBalances[base];
      let sellAmount = held && held.free > 0 ? Math.min(held.free, amount) : 0;

      if (sellAmount <= 0) {
        this.log.warn(`${reason}: No free ${base} balance to sell (may be locked)`);
        return;
      }

      // Round to market precision to avoid exchange rejection
      try {
        const mp = await this.exchange.getMarketPrecision(symbol);
        const factor = Math.pow(10, mp.amountPrecision);
        sellAmount = Math.floor(sellAmount * factor) / factor;
        if (sellAmount <= 0 || sellAmount < mp.minAmount) {
          this.log.warn(`${reason}: Sell amount ${sellAmount} below minimum ${mp.minAmount} for ${symbol}`);
          return;
        }
        if (sellAmount * currentPrice < mp.minCost) {
          this.log.warn(`${reason}: Sell cost ${(sellAmount * currentPrice).toFixed(2)} below minCost ${mp.minCost} for ${symbol}`);
          return;
        }
      } catch (precErr) {
        this.log.warn(`${reason}: Failed to get precision for ${symbol}, using raw amount: ${precErr}`);
      }

      const order = await this.exchange.createMarketSell(symbol, sellAmount, 'risk');
      const fillPrice = order.price || currentPrice;

      this.state.addTrade({
        timestamp: Date.now(),
        symbol,
        side: 'sell',
        amount: sellAmount,
        price: fillPrice,
        cost: sellAmount * fillPrice,
        strategy: reason,
      });

      // Update position tracking
      this.state.reducePosition(symbol, sellAmount);

      const position = this.state.getPosition(symbol);
      this.log.info(`${reason.toUpperCase()} executed for ${symbol}`, {
        sold: sellAmount,
        price: fillPrice.toFixed(2),
        remainingPosition: position.amount,
      });
    } catch (err) {
      this.log.error(`${reason} execution failed for ${symbol}: ${err}`);
    }
  }

  // ----------------------------------------------------------
  // Execute decisions
  // ----------------------------------------------------------

  private async executeDecision(
    decision: StrategyDecision,
    indicators: IndicatorSnapshot,
  ): Promise<void> {
    const { signal, symbol, suggestedAmount, suggestedPrice, reason, strategy } = decision;

    this.log.info(`[${strategy}] ${signal.toUpperCase()} ${symbol}: ${reason}`);

    if (!suggestedAmount || suggestedAmount <= 0) return;
    if (signal === 'hold') return;

    if (
      (signal === 'buy' || signal === 'strong_buy') &&
      indicators.emaCrossover === 'bearish' &&
      strategy !== 'combo-meta'
    ) {
      this.log.debug(`Skipping ${strategy} buy for ${symbol} — bearish EMA crossover active`);
      // DO NOT reset DCA timer — DCA should retry when EMA turns bullish.
      // Setting the timer here would block DCA for the entire interval during downtrends,
      // which is the worst time to skip buying (DCA is designed to accumulate on dips).
      return;
    }

    // maxOpenOrders check — only relevant for limit orders (grid handles its own).
    // DCA and combo-meta decisions that reach here are always MARKET orders
    // which execute instantly and don't occupy an order slot.
    // Grid decisions never reach here (they return signal='hold').
    // So this check is skipped for market-order strategies.

    try {
      // Note: only DCA and combo-meta decisions reach here (grid returns signal='hold').
      // All orders are market orders — limit orders are handled directly by grid.ts.
      const ticker = await this.exchange.fetchTicker(symbol);
      const fallbackPrice = ticker.last;

      if (signal === 'buy' || signal === 'strong_buy') {
        const order = await this.exchange.createMarketBuy(symbol, suggestedAmount, strategy as any);
        const buyPrice = order.price || fallbackPrice;
        this.state.addTrade({
          timestamp: Date.now(), symbol, side: 'buy',
          amount: suggestedAmount, price: buyPrice,
          cost: suggestedAmount * buyPrice, strategy,
        });
        // Track position for stop-loss / take-profit
        this.state.addToPosition(symbol, suggestedAmount, suggestedAmount * buyPrice);
        // Update DCA-specific stats and timer
        if (strategy === 'dca') {
          this.state.addDcaPurchase(symbol, suggestedAmount * buyPrice, suggestedAmount);
          this.state.setLastDcaBuyTime(symbol, Date.now());
        }
      } else if (signal === 'sell' || signal === 'strong_sell') {
        const order = await this.exchange.createMarketSell(symbol, suggestedAmount, strategy as any);
        const sellPrice = order.price || fallbackPrice;
        this.state.addTrade({
          timestamp: Date.now(), symbol, side: 'sell',
          amount: suggestedAmount, price: sellPrice,
          cost: suggestedAmount * sellPrice, strategy,
        });
        // Track position for stop-loss / take-profit
        this.state.reducePosition(symbol, suggestedAmount);
      }
    } catch (err) {
      this.log.error(`Order execution failed: ${err}`, { decision });
    }
  }

  // ----------------------------------------------------------
  // Sell everything — triggered by portfolio take profit
  // ----------------------------------------------------------

  private async sellEverything(): Promise<void> {
    // 1. Cancel ALL open orders on all pairs
    for (const pair of this.config.pairs) {
      try {
        await this.grid.cancelAll(pair.symbol);
        this.log.info(`Cancelled all orders for ${pair.symbol}`);
      } catch (err) {
        this.log.error(`Failed to cancel orders for ${pair.symbol}: ${err}`);
      }
    }

    // 2. Wait for cancellations to settle on exchange
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 3. Fetch FRESH balances (after cancellations freed up crypto)
    const allBalances = await this.exchange.fetchAllBalances();
    for (const pair of this.config.pairs) {
      const base = pair.symbol.split('/')[0]; // "BTC" from "BTC/USDT"
      const held = allBalances[base];
      if (held && held.free > 0) {
        // After cancelling all orders, free should be close to total
        const sellAmount = held.free;
        if (sellAmount <= 0) {
          this.log.warn(`${base}: total=${held.total} but free=0 — some may still be locked`);
          continue;
        }
        try {
          // Round to market precision
          let roundedSellAmount = held.free;
          try {
            const mp = await this.exchange.getMarketPrecision(pair.symbol);
            const factor = Math.pow(10, mp.amountPrecision);
            roundedSellAmount = Math.floor(roundedSellAmount * factor) / factor;
            if (roundedSellAmount <= 0 || roundedSellAmount < mp.minAmount) {
              this.log.warn(`${base}: rounded amount ${roundedSellAmount} below minimum — skipping`);
              continue;
            }
          } catch (precErr) {
            this.log.warn(`Failed to get precision for ${pair.symbol}, using raw amount: ${precErr}`);
          }

          const ticker = await this.exchange.fetchTicker(pair.symbol);
          const valueUSDT = roundedSellAmount * ticker.last;
          // Check minCost before selling
          try {
            const mp = await this.exchange.getMarketPrecision(pair.symbol);
            if (valueUSDT < mp.minCost) {
              this.log.warn(`${base}: sell value ${valueUSDT.toFixed(2)} USDT below minCost ${mp.minCost} — skipping`);
              continue;
            }
          } catch { /* precision already checked above */ }
          this.log.info(`Selling ${roundedSellAmount} ${base} (~${valueUSDT.toFixed(2)} USDT)`);

          const order = await this.exchange.createMarketSell(pair.symbol, roundedSellAmount, 'risk');
          this.state.addTrade({
            timestamp: Date.now(),
            symbol: pair.symbol,
            side: 'sell',
            amount: roundedSellAmount,
            price: order.price || ticker.last,
            cost: roundedSellAmount * (order.price || ticker.last),
            strategy: 'portfolio-take-profit',
          });

          this.log.info(`SOLD ${base}: ${roundedSellAmount} @ ~${(order.price || ticker.last).toFixed(2)}`);

          // Reset position tracking after full sell
          this.state.resetPosition(pair.symbol);
        } catch (err) {
          this.log.error(`Failed to sell ${base}: ${err}`);
        }
      }
    }

    // 3. Final balance
    const finalBalance = await this.exchange.fetchBalance('USDT');
    const profit = finalBalance.total - this.state.startingCapital;
    const profitPct = (profit / this.state.startingCapital) * 100;
    this.log.info('='.repeat(60));
    this.log.info(`FINAL BALANCE: ${finalBalance.total.toFixed(2)} USDT`);
    this.log.info(`PROFIT: +${profit.toFixed(2)} USDT (+${profitPct.toFixed(1)}%)`);
    this.log.info('='.repeat(60));
  }

  // ----------------------------------------------------------
  // Summary log
  // ----------------------------------------------------------

  private logSummary(currentCapital: number): void {
    const trades = this.state.getRecentTrades();
    const buys = trades.filter((t) => t.side === 'buy');
    const sells = trades.filter((t) => t.side === 'sell');
    const totalSpent = buys.reduce((s, t) => s + t.cost, 0);
    const totalEarned = sells.reduce((s, t) => s + t.cost, 0);

    this.log.info('=== BOT SUMMARY ===', {
      totalTicks: this.state.totalTicks,
      currentCapital: currentCapital.toFixed(2),
      peakCapital: this.state.peakCapital.toFixed(2),
      startingCapital: this.state.startingCapital.toFixed(2),
      totalTrades: trades.length,
      buys: buys.length,
      sells: sells.length,
      totalSpent: totalSpent.toFixed(2),
      totalEarned: totalEarned.toFixed(2),
    });

    // Show halted pairs with reasons
    const haltedPairs = this.config.pairs.filter(p => this.state.isPairHalted(p.symbol));
    if (haltedPairs.length > 0) {
      for (const p of haltedPairs) {
        const reason = this.state.getHaltReason(p.symbol) ?? 'unknown';
        this.log.warn(`Halted: ${p.symbol} (${reason})`);
      }
    }

    // Per-pair position & DCA stats
    for (const pair of this.config.pairs) {
      const position = this.state.getPosition(pair.symbol);
      if (position.amount > 0) {
        this.log.info(`Position ${pair.symbol}`, {
          amount: position.amount.toFixed(6),
          costBasis: position.costBasis.toFixed(2),
          avgEntry: position.avgEntryPrice.toFixed(2),
        });
      }
      const dcaStats = this.dca.getStats(pair.symbol);
      if (dcaStats.totalBought > 0) {
        this.log.info(`DCA stats ${pair.symbol}`, {
          invested: dcaStats.totalInvested.toFixed(2),
          bought: dcaStats.totalBought.toFixed(6),
          avgPrice: dcaStats.avgPrice.toFixed(2),
        });
      }
    }
  }

  // ----------------------------------------------------------
  // Shutdown
  // ----------------------------------------------------------

  async shutdown(cancelOrders: boolean = false): Promise<void> {
    this.log.info('Shutting down ComboManager...');
    if (cancelOrders) {
      for (const pair of this.config.pairs) {
        await this.grid.cancelAll(pair.symbol);
      }
      this.log.info('All grid orders cancelled.');
    } else {
      this.log.info('Soft shutdown — grid orders LEFT OPEN on exchange (will be synced on next start).');
    }
    this.state.shutdown();
    this.log.info('State saved. Bot stopped.');
  }

  isHalted(): boolean {
    return this.state.halted;
  }

  resetHalt(): void {
    this.state.halted = false;
    // Also reset all per-pair halts
    for (const pair of this.config.pairs) {
      this.state.resetPairHalt(pair.symbol);
    }
    this.log.info('Halt reset (global + all pairs). Bot will resume on next tick.');
  }
}
