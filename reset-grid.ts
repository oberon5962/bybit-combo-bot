// ============================================================
// Reset Grid — сброс сетки ордеров и перестроение с нуля
// ============================================================
//
// Запуск (из директории bybit-combo-bot):
//   1. Остановить бота:  taskkill //F //IM node.exe
//   2. Сбросить сетку:   npx ts-node reset-grid.ts
//   3. Запустить бота:   npx ts-node src/index.ts
//   Или одной командой:  taskkill //F //IM node.exe && npx ts-node reset-grid.ts && npx ts-node src/index.ts
//
// Что делает:
//   1. Подключается к Bybit API (ключи из .env)
//   2. Читает bot-state.json — берёт список торгуемых пар
//   3. Для каждой пары отменяет ВСЕ открытые ордера на бирже (fetchOpenOrders → cancelAllOrders)
//   4. Обнуляет grid-состояние в bot-state.json:
//      - gridLevels = []           — удаляет все уровни сетки
//      - gridInitialized = false   — бот заново построит сетку при старте
//      - gridCenterPrice = 0       — центр сетки пересчитается по текущей цене
//      - lastDcaBuyTime = 0        — сбрасывает таймер DCA
//      - dcaTotalInvested = 0      — обнуляет DCA-счётчики
//      - dcaTotalBought = 0
//   5. Сохраняет обновлённый state на диск
//
// Что НЕ трогает (сохраняется между сбросами):
//   - peakCapital, startingCapital — для расчёта drawdown и PnL
//   - recentTrades — история сделок
//   - totalTicks — счётчик тиков
//   - telegramUpdateId — чтобы не обрабатывать старые команды повторно
//
// Когда использовать:
//   - После изменения gridSpacingPercent / gridSpacingSellPercent в config.jsonc
//   - Если ордера рассинхронизировались с биржей
//   - Если нужно перестроить сетку вокруг новой цены
//   - После добавления/удаления торговых пар
// ============================================================

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
