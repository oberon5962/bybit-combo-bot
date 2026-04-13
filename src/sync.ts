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

import { BotConfig, Logger } from './types';
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
        this.log.error(`Failed to fetch open orders for ${symbol}: ${err}`);
        continue;
      }

      const exchangeOrderIds = new Set(exchangeOrders.map((o) => o.id));

      // Get saved grid levels
      const savedLevels = this.state.getGridLevels(symbol);
      if (savedLevels.length === 0) {
        this.log.info(`[sync] ${symbol}: no saved grid levels`);
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
            // Order NOT on exchange — was filled or cancelled
            this.log.info(`[sync] ${symbol}: order ${level.orderId} at ${level.price} (${level.side}) not found on Bybit — removing from state`);
            level.orderId = undefined;
            level.filled = false;
            removedCount++;
          }
        }
      }

      // Check if exchange has orders we don't know about
      const knownIds = new Set(savedLevels.map((l) => l.orderId).filter(Boolean));
      const unknownOrders = exchangeOrders.filter((o) => !knownIds.has(o.id));

      // BUG #9 fix: cancel zombie orders (on exchange but not in bot state)
      if (unknownOrders.length > 0) {
        this.log.warn(`[sync] ${symbol}: found ${unknownOrders.length} unknown orders on Bybit — cancelling zombies:`);
        for (const o of unknownOrders) {
          this.log.warn(`  → cancelling ${o.side} ${o.amount} @ ${o.price} (id: ${o.id})`);
          try {
            await this.exchange.withRetry(
              () => this.exchange.cancelOrder(o.id, symbol),
              `Cancel zombie ${o.id} on ${symbol}`,
            );
          } catch (cancelErr) {
            this.log.error(`  → FAILED to cancel zombie order ${o.id} after retries: ${cancelErr}. Manual cancellation required on Bybit.`);
          }
        }
      }

      // Save cleaned state
      this.state.setGridLevels(symbol, savedLevels);

      this.log.info(`[sync] ${symbol}: ${validCount} orders confirmed, ${removedCount} stale removed, ${unknownOrders.length} unknown on exchange`);
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
          this.log.error(`Failed to get price for ${base}: ${err}`);
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
        this.log.error(`[sync] Failed to fetch open orders for ${pair.symbol} during portfolio build: ${err}`);
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
