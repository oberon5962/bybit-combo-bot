// ============================================================
// Bybit Combo Bot — DCA Strategy with RSI Filter (with persistence)
// ============================================================

import {
  BotConfig, DCAConfig, Ticker, IndicatorSnapshot,
  StrategyDecision, Logger, sanitizeError,
} from '../types';
import { BybitExchange } from '../exchange';
import { StateManager } from '../state';

export class DCAStrategy {
  private config: DCAConfig;
  private exchange: BybitExchange;
  private log: Logger;
  private state: StateManager;
  private precisionCache: Map<string, { amountPrecision: number; minAmount: number; minCost: number }> = new Map();

  constructor(config: BotConfig, exchange: BybitExchange, log: Logger, state: StateManager) {
    this.config = config.dca;
    this.exchange = exchange;
    this.log = log;
    this.state = state;
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

    const now = Date.now();
    const lastBuy = this.state.getLastDcaBuyTime(symbol);
    const timeSinceLastBuy = now - lastBuy;

    if (timeSinceLastBuy < this.config.intervalSec * 1000) {
      return [];
    }

    const decisions: StrategyDecision[] = [];
    const baseOrderUSDT = allocationUSDT * (this.config.baseOrderPercent / 100);

    // RSI-based decision
    if (indicators.rsi > this.config.rsiSkipThreshold) {
      decisions.push({
        strategy: 'dca',
        signal: 'hold',
        symbol,
        reason: `DCA SKIP: RSI=${indicators.rsi.toFixed(1)} > ${this.config.rsiSkipThreshold} (overbought). Waiting for better entry.`,
      });
      // НЕ обновляем lastDcaBuyTime — при skip бот попробует снова на следующем тике
      return decisions;
    }

    let orderUSDT = baseOrderUSDT;
    let reason = '';

    if (indicators.rsi < this.config.rsiBoostThreshold) {
      orderUSDT = baseOrderUSDT * this.config.rsiBoostMultiplier;
      reason = `DCA BOOST BUY: RSI=${indicators.rsi.toFixed(1)} < ${this.config.rsiBoostThreshold} (oversold). Buying ${this.config.rsiBoostMultiplier}x at ${ticker.last}`;
    } else {
      reason = `DCA NORMAL BUY: RSI=${indicators.rsi.toFixed(1)} in neutral zone. Buying at ${ticker.last}`;
    }

    // Bollinger adjustment
    if (indicators.pricePosition === 'below_lower') {
      orderUSDT *= 1.25;
      reason += ' + Bollinger bonus (below lower band)';
    } else if (indicators.pricePosition === 'above_upper') {
      orderUSDT *= 0.5;
      reason += ' + Bollinger reduction (above upper band)';
    }

    const rawAmount = orderUSDT / ticker.last;

    // Use market precision instead of hardcoded 5 decimals
    let cached = this.precisionCache.get(symbol);
    if (!cached) {
      try {
        const mp = await this.exchange.getMarketPrecision(symbol);
        cached = { amountPrecision: mp.amountPrecision, minAmount: mp.minAmount, minCost: mp.minCost };
        this.precisionCache.set(symbol, cached);
      } catch (err) {
        this.log.warn(`Failed to get precision for ${symbol}, using fallback: ${sanitizeError(err)}`);
        cached = { amountPrecision: 5, minAmount: 0, minCost: 0 };
      }
    }
    const factor = Math.pow(10, cached.amountPrecision);
    const amount = Math.floor(rawAmount * factor) / factor; // floor to not exceed balance

    // Skip if order is below exchange minimums
    if (amount < cached.minAmount) {
      this.log.debug(`DCA order too small for ${symbol}: ${amount} < minAmount ${cached.minAmount}`);
      return [];
    }
    if (amount * ticker.last < cached.minCost) {
      this.log.debug(`DCA order value too small for ${symbol}: ${(amount * ticker.last).toFixed(2)} USDT < minCost ${cached.minCost}`);
      return [];
    }

    decisions.push({
      strategy: 'dca',
      signal: indicators.rsi < this.config.rsiBoostThreshold ? 'strong_buy' : 'buy',
      symbol,
      suggestedAmount: amount,
      suggestedPrice: ticker.last,
      reason,
    });

    // NOTE: lastDcaBuyTime is set by combo-manager AFTER successful execution,
    // not here — if executeDecision skips (EMA filter, max orders), DCA retries next tick.
    return decisions;
  }

  // ----------------------------------------------------------
  // Stats (from persistent state)
  // ----------------------------------------------------------

  getStats(symbol: string): { totalInvested: number; totalBought: number; avgPrice: number } {
    const stats = this.state.getDcaStats(symbol);
    return {
      ...stats,
      avgPrice: stats.totalBought > 0 ? stats.totalInvested / stats.totalBought : 0,
    };
  }
}
