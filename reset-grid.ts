// Запуск: taskkill //F //IM node.exe && npx ts-node reset-grid.ts && npx ts-node src/index.ts

import fs from 'fs';
import path from 'path';
import ccxt from 'ccxt';
import dotenv from 'dotenv';
dotenv.config();

const STATE_PATH = path.resolve(__dirname, 'bot-state.json');

async function main() {
  // 1. Cancel all orders on Bybit
  const exchange = new ccxt.bybit({
    apiKey: process.env.BYBIT_API_KEY,
    secret: process.env.BYBIT_API_SECRET,
    options: { defaultType: 'spot' },
  });

  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  const symbols = Object.keys(state.pairs);

  console.log('Cancelling orders on Bybit...');
  for (const sym of symbols) {
    try {
      const orders = await exchange.fetchOpenOrders(sym);
      if (orders.length > 0) {
        await exchange.cancelAllOrders(sym);
        console.log(`  ${sym}: ${orders.length} orders cancelled`);
      } else {
        console.log(`  ${sym}: no open orders`);
      }
    } catch (e: any) {
      console.error(`  ${sym}: error — ${e.message}`);
    }
  }

  // 2. Reset grid in bot-state.json (keep everything else)
  for (const sym of symbols) {
    const pair = state.pairs[sym];
    pair.gridLevels = [];
    pair.gridInitialized = false;
    pair.gridCenterPrice = 0;
    pair.lastDcaBuyTime = 0;
    pair.dcaTotalInvested = 0;
    pair.dcaTotalBought = 0;
  }

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  console.log(`\nGrid reset for ${symbols.length} pairs. State saved.`);
  console.log('Kept: peakCapital, startingCapital, recentTrades, totalTicks, telegramUpdateId');
}

main().catch((e) => { console.error(e); process.exit(1); });
