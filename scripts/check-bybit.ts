// Quick check of Bybit state: open orders, balances, recent trades
import { loadConfig } from '../src/config';
import { BybitExchange } from '../src/exchange';
import { createLogger } from '../src/logger';

async function main() {
  const log = createLogger('info');
  const config = loadConfig();
  const exchange = new BybitExchange(config, log);

  console.log('\n=== BALANCES ===');
  const { all } = await exchange.fetchBalanceAndAll('USDT');
  for (const [currency, bal] of Object.entries(all)) {
    if (bal.total > 0) {
      console.log(`  ${currency}: free=${bal.free} used=${bal.used} total=${bal.total}`);
    }
  }

  console.log('\n=== OPEN ORDERS ===');
  for (const pair of config.pairs) {
    const orders = await exchange.fetchOpenOrders(pair.symbol);
    const buys = orders.filter(o => o.side === 'buy');
    const sells = orders.filter(o => o.side === 'sell');
    console.log(`\n  ${pair.symbol}: ${orders.length} orders (${buys.length}B/${sells.length}S)`);
    for (const o of orders) {
      console.log(`    ${o.side.toUpperCase()} ${o.amount} @ ${o.price} [${o.id}]`);
    }
  }

  console.log('\n=== TICKERS ===');
  for (const pair of config.pairs) {
    const ticker = await exchange.fetchTicker(pair.symbol);
    console.log(`  ${pair.symbol}: ${ticker.last}`);
  }

  // Check recent closed orders for fills
  console.log('\n=== RECENT CLOSED ORDERS (last 10 per pair) ===');
  const ex = exchange.getExchange();
  for (const pair of config.pairs) {
    try {
      const closed = await ex.fetchClosedOrders(pair.symbol, undefined, 10);
      const recent = closed.filter(o => o.filled && o.filled > 0);
      if (recent.length > 0) {
        console.log(`\n  ${pair.symbol}:`);
        for (const o of recent) {
          const time = new Date(o.timestamp ?? 0).toISOString();
          console.log(`    ${time} ${o.side?.toUpperCase()} ${o.filled}/${o.amount} @ ${o.average ?? o.price} [${o.status}]`);
        }
      }
    } catch (err) {
      console.log(`  ${pair.symbol}: error — ${err}`);
    }
  }
}

main().catch(console.error);
