// ============================================================
// Bybit Combo Bot — Exchange Module (Bybit via ccxt)
// ============================================================

import ccxt, { Exchange, Order } from 'ccxt';
import {
  BotConfig, OHLCV, Ticker, Balance, BotOrder, Logger, sanitizeError
} from './types';

export class BybitExchange {
  private exchange: Exchange;
  private log: Logger;
  private marketsLoaded: boolean = false;

  constructor(config: BotConfig, log: Logger) {
    this.log = log;

    this.exchange = new ccxt.bybit({
      apiKey: config.apiKey,
      secret: config.apiSecret,
      enableRateLimit: true,
      options: {
        defaultType: 'spot',
        adjustForTimeDifference: true,
      },
    });

    if (config.testnet) {
      this.exchange.setSandboxMode(true);
      this.log.info('Exchange initialized in TESTNET mode');
    } else {
      this.log.info('Exchange initialized in LIVE mode — be careful!');
    }
  }

  // ----------------------------------------------------------
  // Market Data
  // ----------------------------------------------------------

  async fetchTicker(symbol: string): Promise<Ticker> {
    const t = await this.exchange.fetchTicker(symbol);
    return {
      symbol,
      last: t.last ?? 0,
      bid: t.bid ?? 0,
      ask: t.ask ?? 0,
      volume24h: t.quoteVolume ?? 0,
    };
  }

  async fetchOHLCV(
    symbol: string,
    timeframe: string = '5m',
    limit: number = 100,
  ): Promise<OHLCV[]> {
    const raw = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    return raw.map(([timestamp, open, high, low, close, volume]) => ({
      timestamp: timestamp as number,
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
      volume: volume as number,
    }));
  }

  // Raw OHLCV for volatility analysis (returns number[][] for CandleFetcher compatibility)
  async fetchOHLCVRaw(
    symbol: string,
    timeframe: string,
    since: number,
    limit: number,
  ): Promise<number[][]> {
    const raw = await this.exchange.fetchOHLCV(symbol, timeframe, since, limit);
    return raw as unknown as number[][];
  }

  // ----------------------------------------------------------
  // Account
  // ----------------------------------------------------------

  async fetchBalance(currency: string = 'USDT'): Promise<Balance> {
    const bal = await this.exchange.fetchBalance();
    const entry = bal[currency] ?? { free: 0, used: 0, total: 0 };
    return {
      free: entry.free ?? 0,
      used: entry.used ?? 0,
      total: entry.total ?? 0,
    };
  }

  async fetchAllBalances(): Promise<Record<string, Balance>> {
    const bal = await this.exchange.fetchBalance();
    return this.parseBalances(bal);
  }

  // Fetch both USDT balance and all balances in a single API call
  async fetchBalanceAndAll(currency: string = 'USDT'): Promise<{ single: Balance; all: Record<string, Balance> }> {
    const bal = await this.exchange.fetchBalance();
    const entry = bal[currency] ?? { free: 0, used: 0, total: 0 };
    return {
      single: {
        free: entry.free ?? 0,
        used: entry.used ?? 0,
        total: entry.total ?? 0,
      },
      all: this.parseBalances(bal),
    };
  }

  private parseBalances(bal: Record<string, any>): Record<string, Balance> {
    const result: Record<string, Balance> = {};
    for (const [currency, entry] of Object.entries(bal)) {
      if (typeof entry === 'object' && entry !== null && 'free' in entry) {
        const b = entry as { free?: number; used?: number; total?: number };
        if ((b.total ?? 0) > 0) {
          result[currency] = {
            free: b.free ?? 0,
            used: b.used ?? 0,
            total: b.total ?? 0,
          };
        }
      }
    }
    return result;
  }

  // ----------------------------------------------------------
  // Orders
  // ----------------------------------------------------------

  async createLimitBuy(
    symbol: string,
    amount: number,
    price: number,
    strategy: BotOrder['strategy'],
  ): Promise<BotOrder> {
    this.log.info(`LIMIT BUY ${symbol}: ${amount} @ ${price}`, { strategy });
    const order = await this.exchange.createLimitBuyOrder(symbol, amount, price);
    return this.mapOrder(order, strategy);
  }

  async createLimitSell(
    symbol: string,
    amount: number,
    price: number,
    strategy: BotOrder['strategy'],
  ): Promise<BotOrder> {
    this.log.info(`LIMIT SELL ${symbol}: ${amount} @ ${price}`, { strategy });
    const order = await this.exchange.createLimitSellOrder(symbol, amount, price);
    return this.mapOrder(order, strategy);
  }

  async createMarketBuy(
    symbol: string,
    amount: number,
    strategy: BotOrder['strategy'],
  ): Promise<BotOrder> {
    this.log.info(`MARKET BUY ${symbol}: ${amount}`, { strategy });
    const order = await this.exchange.createMarketBuyOrder(symbol, amount);
    return this.mapOrder(order, strategy);
  }

  async createMarketSell(
    symbol: string,
    amount: number,
    strategy: BotOrder['strategy'],
  ): Promise<BotOrder> {
    this.log.info(`MARKET SELL ${symbol}: ${amount}`, { strategy });
    const order = await this.exchange.createMarketSellOrder(symbol, amount);
    return this.mapOrder(order, strategy);
  }

  async cancelOrder(orderId: string, symbol: string): Promise<void> {
    this.log.info(`CANCEL order ${orderId} on ${symbol}`);
    await this.exchange.cancelOrder(orderId, symbol);
  }

  async fetchOpenOrders(symbol: string): Promise<BotOrder[]> {
    const orders = await this.exchange.fetchOpenOrders(symbol);
    return orders.map((o) => this.mapOrder(o, 'grid'));
  }

  // BUG #14: fetch a specific order to check fill status (partial fills)
  // BUG #audit-3: fallback to closedOrders when order is purged from active history
  async fetchOrder(orderId: string, symbol: string): Promise<{ filled: number; remaining: number; status: string; price: number }> {
    try {
      const order = await this.exchange.fetchOrder(orderId, symbol);
      return {
        filled: order.filled ?? 0,
        remaining: order.remaining ?? 0,
        status: order.status ?? 'unknown',
        price: order.average ?? order.price ?? 0,
      };
    } catch (err) {
      // Order not found — try closed orders as fallback (Bybit purges old orders from active query)
      this.log.debug(`fetchOrder ${orderId} failed, trying closed orders: ${sanitizeError(err)}`);
      try {
        const closed = await this.exchange.fetchClosedOrders(symbol, undefined, 50);
        const match = closed.find((o) => o.id === orderId);
        if (match) {
          return {
            filled: match.filled ?? 0,
            remaining: match.remaining ?? 0,
            status: match.status ?? 'closed',
            price: match.average ?? match.price ?? 0,
          };
        }
      } catch (err2) {
        this.log.debug(`fetchClosedOrders fallback also failed: ${sanitizeError(err2)}`);
      }
      // Neither found — return purged status so caller can handle safely
      return { filled: 0, remaining: 0, status: 'purged', price: 0 };
    }
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    const open = await this.exchange.fetchOpenOrders(symbol);
    for (const o of open) {
      await this.exchange.cancelOrder(o.id, symbol);
    }
    this.log.info(`Cancelled all ${open.length} open orders on ${symbol}`);
  }

  // ----------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------

  private mapOrder(order: Order, strategy: BotOrder['strategy']): BotOrder {
    return {
      id: order.id,
      symbol: order.symbol ?? '',
      side: order.side as 'buy' | 'sell',
      type: order.type as 'limit' | 'market',
      price: order.price ?? 0,
      amount: order.amount ?? 0,
      filled: order.filled ?? 0,
      status: order.status === 'closed' ? 'filled'
        : order.status === 'canceled' ? 'cancelled'
        : 'open',
      strategy,
      timestamp: order.timestamp ?? Date.now(),
    };
  }

  // ----------------------------------------------------------
  // Market info — precision for price/amount rounding
  // ----------------------------------------------------------

  async getMarketPrecision(symbol: string): Promise<{ pricePrecision: number; amountPrecision: number; minAmount: number; minCost: number }> {
    // Only load markets once — ccxt caches internally but still makes HTTP calls periodically
    if (!this.marketsLoaded) {
      await this.exchange.loadMarkets();
      this.marketsLoaded = true;
    }
    const market = this.exchange.markets[symbol];
    if (!market) {
      throw new Error(`Market ${symbol} not found`);
    }

    // ccxt for Bybit uses TICK_SIZE precision mode:
    //   market.precision.price  = 0.01   (tick size, NOT decimal places)
    //   market.precision.amount = 0.000001 (tick size, NOT decimal places)
    // Our rounding code expects decimal places (e.g. 2, 6), so we convert here.
    const rawPrice = market.precision?.price ?? 0.01;
    const rawAmount = market.precision?.amount ?? 0.00001;

    return {
      pricePrecision: this.tickSizeToDecimalPlaces(rawPrice),
      amountPrecision: this.tickSizeToDecimalPlaces(rawAmount),
      minAmount: market.limits?.amount?.min ?? 0,
      minCost: market.limits?.cost?.min ?? 0,
    };
  }

  /**
   * Convert a tick-size value to the number of decimal places.
   * E.g. 0.000001 → 6, 0.01 → 2, 0.1 → 1, 1 → 0, 10 → 0.
   * If the value is already an integer >= 1, it's likely already decimal places — return as-is.
   */
  private tickSizeToDecimalPlaces(tickSize: number): number {
    if (tickSize >= 1) return 0;  // step=1 or larger → 0 decimal places
    return Math.max(0, Math.round(-Math.log10(tickSize)));
  }

  getExchange(): Exchange {
    return this.exchange;
  }

  // ----------------------------------------------------------
  // Retry wrapper for transient API errors (timeout, network)
  // ----------------------------------------------------------

  async withRetry<T>(fn: () => Promise<T>, label: string, maxRetries: number = 2): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const isTimeout = err?.constructor?.name === 'RequestTimeout'
          || (err?.message && /timeout|ETIMEDOUT/i.test(err.message));
        const isTransient = isTimeout
          || err?.constructor?.name === 'NetworkError'
          || err?.constructor?.name === 'ExchangeNotAvailable'
          || err?.constructor?.name === 'RateLimitExceeded'
          || (err?.message && /ECONNRESET|rate.?limit/i.test(err.message));

        // NEVER retry order placement on transient errors — order may already exist on exchange
        // NetworkError / ECONNRESET can happen AFTER Bybit accepted the order (response lost on the way back)
        const isOrderPlacement = /\b(buy|sell)\b/i.test(label);
        if (isTransient && isOrderPlacement) {
          this.log.error(`${label}: transient error on order placement — NOT retrying (order may exist on exchange). Manual check required.`);
          throw err;
        }

        if (isTransient && attempt < maxRetries) {
          const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s (exponential)
          this.log.warn(`${label}: transient error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${sanitizeError(err.message || err)}`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`${label}: unreachable`);
  }
}
