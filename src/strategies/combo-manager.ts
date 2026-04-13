// ============================================================
// Bybit Combo Bot — Combo Strategy Manager (with persistence)
// ============================================================

import {
  BotConfig, PairConfig, Ticker, IndicatorSnapshot,
  StrategyDecision, Logger, sanitizeError,
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

  // Market protection state
  private marketPanic: boolean = false;
  private btcPaused: boolean = false;
  private lastBtcCheck: number = 0;
  private lastIndicatorsPerPair: Map<string, IndicatorSnapshot> = new Map();
  private lastTickPortfolioValue: number = 0;

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
          this.log.error(`Failed to fetch ${pair.symbol} price during init: ${sanitizeError(err)}`);
        }
      }
    }

    if (this.state.startingCapital === 0) {
      this.state.startingCapital = totalPortfolioValue;
    }
    if (this.state.peakCapital === 0 || totalPortfolioValue > this.state.peakCapital) {
      this.state.peakCapital = totalPortfolioValue;
    }

    // On restart: cooldown pairs resume, hard-halted pairs (max SL exceeded) stay halted
    for (const pair of this.config.pairs) {
      const sym = pair.symbol;
      // Clear expired cooldowns
      if (this.state.getCooldownUntil(sym) > 0) {
        if (Date.now() >= this.state.getCooldownUntil(sym)) {
          this.log.info(`Cooldown expired for ${sym}, resuming`);
          this.state.clearCooldown(sym);
        } else {
          const minLeft = Math.ceil((this.state.getCooldownUntil(sym) - Date.now()) / 60000);
          this.log.info(`${sym} in cooldown, ${minLeft} min remaining`);
        }
      }
      // Hard-halted pairs (consecutiveSL >= max) stay halted
      if (this.state.isPairHalted(sym)) {
        const reason = this.state.getHaltReason(sym) ?? '';
        this.log.warn(`Pair ${sym} remains HALTED (${reason}). Edit bot-state.json to resume.`);
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
          this.log.error(`Failed to fetch ticker for ${pair.symbol} during portfolio calc: ${sanitizeError(err)}`);
        }
      }
    }

    // Deposit/withdrawal detection: compare with previous tick value
    let skipGlobalChecks = false;
    if (this.lastTickPortfolioValue > 0) {
      const jumpPercent = ((totalPortfolioUSDT - this.lastTickPortfolioValue) / this.lastTickPortfolioValue) * 100;
      if (Math.abs(jumpPercent) > 20) {
        // Check if any trades happened recently (within last 2 tick intervals)
        const trades = this.state.getRecentTrades();
        const cutoff = Date.now() - this.config.tickIntervalSec * 2000;
        const hasRecentTrades = trades.length > 0 && trades[trades.length - 1].timestamp > cutoff;

        if (!hasRecentTrades) {
          const change = totalPortfolioUSDT - this.lastTickPortfolioValue;
          if (change > 0) {
            // Deposit
            this.state.startingCapital += change;
            this.state.peakCapital = Math.max(this.state.peakCapital, totalPortfolioUSDT);
            this.log.info(`DEPOSIT DETECTED: +${change.toFixed(2)} USDT → new startingCapital: ${this.state.startingCapital.toFixed(2)}`);
          } else {
            // Withdrawal — adjust startingCapital and peakCapital down
            this.state.startingCapital += change; // change is negative
            this.state.peakCapital = Math.max(totalPortfolioUSDT, this.state.startingCapital);
            this.log.info(`WITHDRAWAL DETECTED: ${change.toFixed(2)} USDT → new startingCapital: ${this.state.startingCapital.toFixed(2)}`);
          }
        } else {
          // Trades + huge jump → suspicious, freeze global checks this tick
          skipGlobalChecks = true;
          this.log.warn(`Portfolio spike ${jumpPercent > 0 ? '+' : ''}${jumpPercent.toFixed(0)}% with recent trades — freezing peak/drawdown/TP this tick`);
        }
      }
    }
    this.lastTickPortfolioValue = totalPortfolioUSDT;

    if (!skipGlobalChecks) {
      // Update peak capital
      if (totalPortfolioUSDT > this.state.peakCapital) {
        this.state.peakCapital = totalPortfolioUSDT;
      }
    }

    // Check MAX DRAWDOWN — halt if portfolio drops too much
    if (!skipGlobalChecks) {
      const drawdown = this.state.peakCapital > 0
        ? ((this.state.peakCapital - totalPortfolioUSDT) / this.state.peakCapital) * 100
        : 0;
      if (drawdown > this.config.risk.maxDrawdownPercent) {
        this.log.error(`MAX DRAWDOWN EXCEEDED: ${drawdown.toFixed(1)}% > ${this.config.risk.maxDrawdownPercent}%`);
        this.log.error('HALTING ALL TRADING.');
        this.state.halted = true;
        return;
      }
    }

    // Check PORTFOLIO TAKE PROFIT — sell everything if target reached
    if (this.state.startingCapital <= 0) {
      this.log.warn('startingCapital not set, skipping take profit check');
    }
    const profitPercent = this.state.startingCapital > 0
      ? ((totalPortfolioUSDT - this.state.startingCapital) / this.state.startingCapital) * 100
      : 0;
    if (!skipGlobalChecks && this.state.startingCapital > 0 && profitPercent >= this.config.risk.portfolioTakeProfitPercent) {
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

    // Market protection checks (uses indicators from previous tick — panic state carries over)
    await this.checkMarketPanic();
    await this.checkBtcWatchdog();

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
        this.log.error(`Error processing ${pair.symbol}: ${sanitizeError(err)}`);
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

    // Skip halted pairs (max consecutive SL exceeded)
    if (this.state.isPairHalted(symbol)) {
      this.log.debug(`Skipping ${symbol} — pair is halted`);
      return;
    }

    // Cooldown check — pair is paused after SL, waiting to resume
    const cooldownUntil = this.state.getCooldownUntil(symbol);
    if (cooldownUntil > 0) {
      if (Date.now() < cooldownUntil) {
        const minLeft = Math.ceil((cooldownUntil - Date.now()) / 60000);
        this.log.debug(`Skipping ${symbol} — cooldown, ${minLeft} min left`);
        return;
      }
      // Cooldown expired — resume
      this.state.clearCooldown(symbol);
      this.log.info(`${symbol} cooldown expired, resuming trading`);
    }

    // Use TOTAL USDT for allocation — free balance fluctuates as grid locks funds in orders.
    // Grid internally checks free balance before placing sells, so over-allocation is safe.
    const allocationUSDT = totalUSDT * (pair.allocationPercent / 100);

    const [ticker, candles] = await Promise.all([
      this.exchange.fetchTicker(symbol),
      this.exchange.fetchOHLCV(symbol, '5m', 100),
    ]);

    // Guard: skip pair if ticker price is zero or invalid
    if (!ticker.last || ticker.last <= 0 || !isFinite(ticker.last)) {
      this.log.error(`${symbol}: ticker.last is invalid (${ticker.last}), skipping pair this tick`);
      return;
    }

    // Pre-cache amount precision for this symbol (used by evaluateMetaSignal)
    if (!this.marketPrecisionCache.has(symbol)) {
      try {
        const mp = await this.exchange.getMarketPrecision(symbol);
        this.marketPrecisionCache.set(symbol, { amountPrecision: mp.amountPrecision, minAmount: mp.minAmount, minCost: mp.minCost });
      } catch (err) {
        this.log.warn(`Failed to get precision for ${symbol}: ${sanitizeError(err)}`);
      }
    }

    const indicators = computeIndicators(candles, this.config.indicators);

    // Store latest indicators for market panic detection
    this.lastIndicatorsPerPair.set(symbol, indicators);

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
    const protectionActive = this.isMarketProtectionActive();

    if (protectionActive) {
      // Market protection active — only check grid fills (to process existing orders,
      // counter-sells, etc.) but don't place new buy orders.
      // Grid.evaluate still runs to detect fills and place counter-SELL orders.
      // We pass indicators so grid can track state, but grid.isBuyAllowed() plus
      // the EMA filter will naturally block new buys when bearish.
      // However, to be safe, we skip DCA and meta-signal entirely.
      const gridDecisions = await this.grid.evaluate(symbol, ticker, indicators, allocationUSDT);
      // Only keep non-buy decisions from grid (sells, holds)
      allDecisions.push(...gridDecisions);

      this.log.debug(`${symbol}: market protection active (panic=${this.marketPanic}, btcPaused=${this.btcPaused}) — skipping DCA/meta buys`);
    } else {
      const gridDecisions = await this.grid.evaluate(symbol, ticker, indicators, allocationUSDT);
      allDecisions.push(...gridDecisions);

      const dcaDecisions = await this.dca.evaluate(symbol, ticker, indicators, allocationUSDT);
      allDecisions.push(...dcaDecisions);

      const metaSignal = this.evaluateMetaSignal(indicators, ticker, allocationUSDT);
      if (metaSignal) {
        allDecisions.push(metaSignal);
      }
    }

    for (const decision of allDecisions) {
      // When market protection is active, block buy executions but allow sells
      if (protectionActive && (decision.signal === 'buy' || decision.signal === 'strong_buy')) {
        this.log.debug(`${symbol}: blocking ${decision.signal} from ${decision.strategy} — market protection active`);
        continue;
      }
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

    const { stopLossPercent, takeProfitPercent, trailingSLPercent, trailingSLActivationPercent,
            cooldownAfterSLSec, cooldownMaxSL } = this.config.risk;
    const pnlPercent = ((currentPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100;

    // --- 1. HARD STOP-LOSS: price crashed from entry ---
    if (pnlPercent <= -stopLossPercent) {
      this.log.warn('='.repeat(60));
      this.log.warn(`STOP-LOSS TRIGGERED for ${symbol}!`);
      this.log.warn(`Entry avg: ${position.avgEntryPrice.toFixed(2)} | Current: ${currentPrice.toFixed(2)} | PnL: ${pnlPercent.toFixed(1)}%`);
      this.log.warn('='.repeat(60));

      const sold = await this.closePosition(symbol, position.amount, currentPrice, 'stop-loss');
      if (!sold) {
        this.log.warn(`${symbol} SL: closePosition failed — keeping position in state`);
        return false;
      }
      await this.handlePostSL(symbol, position.avgEntryPrice, currentPrice, pnlPercent, cooldownAfterSLSec, cooldownMaxSL);
      return true;
    }

    // --- 2. TRAILING STOP-LOSS: price retreated from peak ---
    if (pnlPercent >= trailingSLActivationPercent) {
      // Update peak price
      this.state.updateTrailingPeak(symbol, currentPrice);
    }

    const trailingPeak = this.state.getTrailingPeak(symbol);
    if (trailingPeak > 0) {
      const dropFromPeak = ((trailingPeak - currentPrice) / trailingPeak) * 100;
      if (dropFromPeak >= trailingSLPercent) {
        const trailingPnl = ((currentPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100;
        this.log.info('='.repeat(60));
        this.log.info(`TRAILING STOP-LOSS TRIGGERED for ${symbol}!`);
        this.log.info(`Entry: ${position.avgEntryPrice.toFixed(2)} | Peak: ${trailingPeak.toFixed(2)} | Current: ${currentPrice.toFixed(2)}`);
        this.log.info(`Drop from peak: -${dropFromPeak.toFixed(1)}% | PnL from entry: ${trailingPnl >= 0 ? '+' : ''}${trailingPnl.toFixed(1)}%`);
        this.log.info('='.repeat(60));

        const sold = await this.closePosition(symbol, position.amount, currentPrice, 'trailing-stop');
        if (!sold) {
          this.log.warn(`${symbol} trailing SL: closePosition failed — keeping position in state`);
          return false;
        }
        // closePosition already called reducePosition — only reset if fully sold
        const trailRemaining = this.state.getPosition(symbol);
        if (trailRemaining.amount < 1e-12) {
          this.state.resetPosition(symbol);
        } else {
          this.log.warn(`${symbol} trailing SL: partial sell, ${trailRemaining.amount} still held — position kept`);
        }
        this.state.resetTrailingPeak(symbol);
        this.state.setGridInitialized(symbol, false);

        if (trailingPnl < 0) {
          await this.handlePostSL(symbol, position.avgEntryPrice, currentPrice, trailingPnl, cooldownAfterSLSec, cooldownMaxSL);
          this.log.info(`${symbol} trailing SL done (loss). Cooldown applied.`);
        } else {
          this.state.resetConsecutiveSL(symbol);
          this.log.info(`${symbol} trailing SL done (profit). Grid will rebuild on next tick.`);
        }
        return true;
      }
    }

    // --- 3. TAKE-PROFIT: price reached target ---
    if (pnlPercent >= takeProfitPercent) {
      this.log.info('='.repeat(60));
      this.log.info(`TAKE-PROFIT TRIGGERED for ${symbol}!`);
      this.log.info(`Entry avg: ${position.avgEntryPrice.toFixed(2)} | Current: ${currentPrice.toFixed(2)} | PnL: +${pnlPercent.toFixed(1)}%`);
      this.log.info('='.repeat(60));

      const sold = await this.closePosition(symbol, position.amount, currentPrice, 'take-profit');
      if (!sold) {
        this.log.warn(`${symbol} TP: closePosition failed — keeping position in state`);
        return false;
      }
      // closePosition already called reducePosition — only reset if fully sold
      const tpRemaining = this.state.getPosition(symbol);
      if (tpRemaining.amount < 1e-12) {
        this.state.resetPosition(symbol);
      } else {
        this.log.warn(`${symbol} TP: partial sell, ${tpRemaining.amount} still held — position kept`);
      }
      this.state.resetTrailingPeak(symbol);
      this.state.resetConsecutiveSL(symbol);
      this.state.setGridInitialized(symbol, false);
      this.log.info(`${symbol} take-profit done. Grid will rebuild on next tick.`);
      return true;
    }

    return false;
  }

  private async handlePostSL(
    symbol: string,
    entryPrice: number,
    exitPrice: number,
    pnlPercent: number,
    cooldownSec: number,
    maxConsecutive: number,
  ): Promise<void> {
    const count = this.state.incrementConsecutiveSL(symbol);
    // closePosition already called reducePosition — only reset if fully sold
    const remaining = this.state.getPosition(symbol);
    if (remaining.amount < 1e-12) {
      this.state.resetPosition(symbol);
    } else {
      this.log.warn(`${symbol} SL: partial sell, ${remaining.amount} still held — position kept in state`);
    }
    this.state.resetTrailingPeak(symbol);
    this.state.setGridInitialized(symbol, false);

    const reason = `stop-loss: entry ${entryPrice.toFixed(2)}, exit ${exitPrice.toFixed(2)}, PnL ${pnlPercent.toFixed(1)}%`;

    if (count >= maxConsecutive) {
      // Too many SL in a row — full halt
      this.state.haltPair(symbol, `${reason} [${count}x SL — halted]`);
      this.log.warn(`${symbol} HALTED — ${count} consecutive stop-losses. Edit bot-state.json to resume.`);
    } else if (cooldownSec > 0) {
      // Cooldown — pause and resume later
      const until = Date.now() + cooldownSec * 1000;
      this.state.setCooldown(symbol, until);
      const hours = (cooldownSec / 3600).toFixed(1);
      this.log.warn(`${symbol} cooldown ${hours}h after SL (${count}/${maxConsecutive}). Will resume at ${new Date(until).toLocaleTimeString()}`);
    } else {
      // cooldownSec = 0 — halt forever (old behavior)
      this.state.haltPair(symbol, reason);
      this.log.warn(`${symbol} HALTED after stop-loss. Edit bot-state.json to resume.`);
    }
  }

  private async closePosition(
    symbol: string,
    amount: number,
    currentPrice: number,
    reason: 'stop-loss' | 'take-profit' | 'trailing-stop',
  ): Promise<boolean> {
    try {
      // Cancel all open grid orders for this pair first
      await this.grid.cancelAll(symbol);
      this.log.info(`Cancelled grid orders for ${symbol} before ${reason} sell`);

      // Poll for free balance to appear (cancellations may take time to settle)
      const base = symbol.split('/')[0];
      let sellAmount = 0;
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const allBalances = await this.exchange.fetchAllBalances();
        const held = allBalances[base];
        sellAmount = held && held.free > 0 ? Math.min(held.free, amount) : 0;
        if (sellAmount > 0) break;
        this.log.debug(`${reason}: waiting for ${base} balance to free up (attempt ${attempt + 1}/5)`);
      }

      if (sellAmount <= 0) {
        this.log.warn(`${reason}: No free ${base} balance to sell after 5 attempts`);
        return false;
      }

      // Round to market precision to avoid exchange rejection
      try {
        const mp = await this.exchange.getMarketPrecision(symbol);
        const factor = Math.pow(10, mp.amountPrecision);
        sellAmount = Math.floor(sellAmount * factor) / factor;
        if (sellAmount <= 0 || sellAmount < mp.minAmount) {
          this.log.warn(`${reason}: Sell amount ${sellAmount} below minimum ${mp.minAmount} for ${symbol}`);
          return false;
        }
        if (sellAmount * currentPrice < mp.minCost) {
          this.log.warn(`${reason}: Sell cost ${(sellAmount * currentPrice).toFixed(2)} below minCost ${mp.minCost} for ${symbol}`);
          return false;
        }
      } catch (precErr) {
        this.log.warn(`${reason}: Failed to get precision for ${symbol}, using raw amount: ${precErr}`);
      }

      const order = await this.exchange.createMarketSell(symbol, sellAmount, 'risk');
      const fillPrice = order.price || currentPrice;

      const slCost = sellAmount * fillPrice;
      this.state.addTrade({
        timestamp: Date.now(),
        symbol,
        side: 'sell',
        amount: sellAmount,
        price: fillPrice,
        cost: slCost,
        fee: slCost * 0.001,
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
      return true;
    } catch (err) {
      this.log.error(`${reason} execution failed for ${symbol}: ${sanitizeError(err)}`);
      return false;
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
        const buyCost = suggestedAmount * buyPrice;
        this.state.addTrade({
          timestamp: Date.now(), symbol, side: 'buy',
          amount: suggestedAmount, price: buyPrice,
          cost: buyCost, fee: buyCost * 0.001, strategy,
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
        const sellCost = suggestedAmount * sellPrice;
        this.state.addTrade({
          timestamp: Date.now(), symbol, side: 'sell',
          amount: suggestedAmount, price: sellPrice,
          cost: sellCost, fee: sellCost * 0.001, strategy,
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
        this.log.error(`Failed to cancel orders for ${pair.symbol}: ${sanitizeError(err)}`);
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
          const tpPrice = order.price || ticker.last;
          const tpCost = roundedSellAmount * tpPrice;
          this.state.addTrade({
            timestamp: Date.now(),
            symbol: pair.symbol,
            side: 'sell',
            amount: roundedSellAmount,
            price: tpPrice,
            cost: tpCost,
            fee: tpCost * 0.001,
            strategy: 'portfolio-take-profit',
          });

          this.log.info(`SOLD ${base}: ${roundedSellAmount} @ ~${(order.price || ticker.last).toFixed(2)}`);

          // Reset position tracking after full sell
          this.state.resetPosition(pair.symbol);
        } catch (err) {
          this.log.error(`Failed to sell ${base}: ${sanitizeError(err)}`);
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
  // Market Protection — panic detector & BTC watchdog
  // ----------------------------------------------------------

  private async checkMarketPanic(): Promise<void> {
    const threshold = this.config.marketProtection.panicBearishPairsThreshold;
    const total = this.config.pairs.length;
    let bearishCount = 0;

    for (const pair of this.config.pairs) {
      const ind = this.lastIndicatorsPerPair.get(pair.symbol);
      if (ind && ind.emaCrossover === 'bearish') {
        bearishCount++;
      }
    }

    if (bearishCount >= threshold) {
      if (!this.marketPanic) {
        this.marketPanic = true;
        this.log.warn(`MARKET PANIC: ${bearishCount}/${total} pairs bearish — all grid buys cancelled`);
        await this.cancelAllBuyOrders();
      }
    } else {
      if (this.marketPanic) {
        this.marketPanic = false;
        this.log.info(`Market panic cleared — ${bearishCount}/${total} pairs bearish, resuming buys`);
      }
    }
  }

  private async cancelAllBuyOrders(): Promise<void> {
    for (const pair of this.config.pairs) {
      try {
        const openOrders = await this.exchange.fetchOpenOrders(pair.symbol);
        const buyOrders = openOrders.filter(o => o.side === 'buy');
        const cancelledIds = new Set<string>();
        for (const order of buyOrders) {
          await this.exchange.cancelOrder(order.id, pair.symbol);
          cancelledIds.add(order.id);
        }
        // Clear stale orderId from grid state so levels can be re-placed later
        if (cancelledIds.size > 0) {
          const levels = this.state.getGridLevels(pair.symbol);
          for (const level of levels) {
            if (level.orderId && cancelledIds.has(level.orderId)) {
              level.orderId = undefined;
            }
          }
          this.state.setGridLevels(pair.symbol, levels);
          this.log.info(`Market panic: cancelled ${cancelledIds.size} buy orders for ${pair.symbol}, grid state cleaned`);
        }
      } catch (err) {
        this.log.error(`Market panic: failed to cancel buy orders for ${pair.symbol}: ${sanitizeError(err)}`);
      }
    }
  }

  private async checkBtcWatchdog(): Promise<void> {
    if (!this.config.marketProtection.btcWatchdogEnabled) return;

    const now = Date.now();
    const intervalMs = this.config.marketProtection.btcCheckIntervalSec * 1000;
    if (now - this.lastBtcCheck < intervalMs) return;
    this.lastBtcCheck = now;

    try {
      const candles = await this.exchange.fetchOHLCV('BTC/USDT', '15m', 4);
      if (candles.length < 2) {
        this.log.warn('BTC WATCHDOG: not enough candles to evaluate');
        return;
      }

      const firstOpen = candles[0].open;
      const lastClose = candles[candles.length - 1].close;
      const changePercent = ((lastClose - firstOpen) / firstOpen) * 100;

      if (changePercent <= -this.config.marketProtection.btcDropThresholdPercent) {
        if (!this.btcPaused) {
          this.log.warn(`BTC WATCHDOG: BTC dropped ${changePercent.toFixed(2)}% in 1h — pausing all buys`);
        }
        this.btcPaused = true;
      } else {
        if (this.btcPaused) {
          this.log.info(`BTC WATCHDOG: BTC recovered (${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}% in 1h) — resuming buys`);
        }
        this.btcPaused = false;
      }
    } catch (err) {
      this.log.error(`BTC WATCHDOG: failed to fetch BTC candles: ${sanitizeError(err)}`);
    }
  }

  /** Returns true if market protection is active and buys should be blocked. */
  private isMarketProtectionActive(): boolean {
    return this.marketPanic || this.btcPaused;
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
    const totalFees = trades.reduce((s, t) => s + (t.fee || 0), 0);

    // PnL
    const pnl = currentCapital - this.state.startingCapital;
    const pnlPct = this.state.startingCapital > 0 ? (pnl / this.state.startingCapital) * 100 : 0;
    const drawdown = this.state.peakCapital > 0
      ? ((this.state.peakCapital - currentCapital) / this.state.peakCapital) * 100
      : 0;

    this.log.info('=== BOT SUMMARY ===', {
      totalTicks: this.state.totalTicks,
      currentCapital: currentCapital.toFixed(2),
      startingCapital: this.state.startingCapital.toFixed(2),
      peakCapital: this.state.peakCapital.toFixed(2),
      PnL: `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
      drawdown: `${drawdown.toFixed(1)}%`,
      totalTrades: trades.length,
      buys: buys.length,
      sells: sells.length,
      totalSpent: totalSpent.toFixed(2),
      totalEarned: totalEarned.toFixed(2),
      totalFees: totalFees.toFixed(4),
      marketPanic: this.marketPanic ? 'YES — buys blocked' : 'no',
      btcWatchdog: this.btcPaused ? 'PAUSED — BTC drop detected' : 'ok',
    });

    // Per-pair summary line
    for (const pair of this.config.pairs) {
      const sym = pair.symbol;
      const pairTrades = trades.filter((t) => t.symbol === sym);
      const position = this.state.getPosition(sym);
      const isHalted = this.state.isPairHalted(sym);
      const haltReason = this.state.getHaltReason(sym);

      const pairBuys = pairTrades.filter((t) => t.side === 'buy');
      const pairSells = pairTrades.filter((t) => t.side === 'sell');
      const slTrades = pairTrades.filter((t) => t.strategy === 'stop-loss');
      const tpTrades = pairTrades.filter((t) => t.strategy === 'take-profit');
      const tslTrades = pairTrades.filter((t) => t.strategy === 'trailing-stop');

      // Build compact status line
      const parts: string[] = [];

      // Trades count
      parts.push(`${pairBuys.length}B/${pairSells.length}S`);

      // Position
      if (position.amount > 0 && position.avgEntryPrice > 0) {
        parts.push(`pos ${position.amount.toFixed(6)} @ ${position.avgEntryPrice.toFixed(2)} (${position.costBasis.toFixed(2)} USDT)`);
      } else {
        parts.push('no position');
      }

      // SL / Trailing SL / TP
      if (slTrades.length > 0) {
        const slCost = slTrades.reduce((s, t) => s + t.cost, 0);
        parts.push(`SL: ${slTrades.length}x ${slCost.toFixed(2)} USDT`);
      }
      if (tslTrades.length > 0) {
        const tslCost = tslTrades.reduce((s, t) => s + t.cost, 0);
        parts.push(`TSL: ${tslTrades.length}x ${tslCost.toFixed(2)} USDT`);
      }
      if (tpTrades.length > 0) {
        const tpCost = tpTrades.reduce((s, t) => s + t.cost, 0);
        parts.push(`TP: ${tpTrades.length}x ${tpCost.toFixed(2)} USDT`);
      }

      // Status
      const cooldownUntil = this.state.getCooldownUntil(sym);
      if (isHalted) {
        parts.push(`HALTED — ${haltReason ?? 'unknown'}`);
      } else if (cooldownUntil > 0 && Date.now() < cooldownUntil) {
        const minLeft = Math.ceil((cooldownUntil - Date.now()) / 60000);
        parts.push(`COOLDOWN — ${minLeft} min left`);
      }

      const level = (isHalted || cooldownUntil > Date.now()) ? 'warn' : 'info';
      this.log[level](`  ${sym}: ${parts.join(' | ')}`);
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
