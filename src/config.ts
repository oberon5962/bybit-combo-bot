// ============================================================
// Bybit Combo Bot — Configuration
// ============================================================
//
// Edit these values to match your trading preferences.
// Start with TESTNET=true and small amounts!
// ============================================================

import { BotConfig } from './types';
import dotenv from 'dotenv';
dotenv.config();

export function loadConfig(): BotConfig {
  const apiKey = process.env.BYBIT_API_KEY ?? '';
  const apiSecret = process.env.BYBIT_API_SECRET ?? '';
  const testnet = (process.env.USE_TESTNET ?? 'true') === 'true';

  if (!apiKey || !apiSecret) {
    throw new Error(
      'Missing BYBIT_API_KEY or BYBIT_API_SECRET. ' +
      'Copy .env.example to .env and fill in your credentials.',
    );
  }

  const gridLevels = 10;

  const config: BotConfig = {
    // API
    apiKey,
    apiSecret,
    testnet,

    // -------------------------------------------------------
    // Trading Pairs & Allocation
    // -------------------------------------------------------
    // При маленьком капитале (100-500 USDT) лучше 2 пары, а не 3,
    // чтобы ордера не были слишком мелкими (Bybit имеет минимумы).
    // BTC — надёжная база, ETH — потенциал роста.
    // Если капитал > 500 USDT, можно добавить SOL.
    pairs: [
      { symbol: 'BTC/USDT', allocationPercent: 35 },
      { symbol: 'ETH/USDT', allocationPercent: 35 },
      { symbol: 'XRP/USDT', allocationPercent: 30 },
    ],

    // -------------------------------------------------------
    // Risk Management
    // -------------------------------------------------------
    risk: {
      maxDrawdownPercent: 15,        // HALT если портфель упал на 15% от пика
      maxOpenOrdersPerPair: gridLevels + 2, // Запас под grid-уровни + контр-ордера
      stopLossPercent: 14,            // Стоп-лосс на позицию (шире для высокой волатильности)
      takeProfitPercent: 12,          // Тейк-профит (поменьше, чтобы чаще фиксировать)
      portfolioTakeProfitPercent: 100, // Продать ВСЁ когда портфель вырос на 30% от старта
                                      // Было 300 USDT → стало 450 USDT → продаём все монеты
    },

    // -------------------------------------------------------
    // Grid Strategy
    // -------------------------------------------------------
    grid: {
      enabled: true,
      gridLevels,                    // 6 buy + 6 sell (сетка под малый капитал)
      gridSpacingPercent: 0.3,       // 0.3% между уровнями (покрытие 2.5% в каждую сторону)
      orderSizePercent: 14,          // Каждый ордер = 18% от аллокации пары
    },

    // -------------------------------------------------------
    // DCA Strategy
    // -------------------------------------------------------
    dca: {
      enabled: false,
      intervalSec: 3 * 60 * 60,         // Каждые 3 часа (10800 сек)
      baseOrderPercent: 5,              // 5% от аллокации пары за одну DCA-покупку
      rsiBoostThreshold: 28,            // Покупаем 1.5x когда RSI < 28
      rsiBoostMultiplier: 1.7,          // 1.7x при перепроданности
      rsiSkipThreshold: 70,             // Пропускаем покупку при RSI > 70
    },

    // -------------------------------------------------------
    // Technical Indicators
    // -------------------------------------------------------
    indicators: {
      rsiPeriod: 14,
      emaFastPeriod: 9,
      emaSlowPeriod: 21,
      bollingerPeriod: 20,
      bollingerStdDev: 2,
    },

    // -------------------------------------------------------
    // Bot Intervals
    // -------------------------------------------------------
    tickIntervalSec: 10,             // Проверка каждые 10 секунд
    syncIntervalSec: 6 * 60 * 60,   // Полный sync с Bybit каждые 6 часов (4 раза в сутки)
  };

  validateConfig(config);
  return config;
}


// ----------------------------------------------------------
// Validation — crash early on bad config
// ----------------------------------------------------------

function validateConfig(config: BotConfig): void {
  const errors: string[] = [];

  // Pairs allocation
  const totalAlloc = config.pairs.reduce((s, p) => s + p.allocationPercent, 0);
  if (totalAlloc > 100) {
    errors.push(`Total pair allocation is ${totalAlloc}% — must be <= 100%`);
  }
  if (config.pairs.length === 0) {
    errors.push('No trading pairs configured');
  }

  // Risk
  if (config.risk.maxDrawdownPercent <= 0 || config.risk.maxDrawdownPercent > 100) {
    errors.push('maxDrawdownPercent must be between 0 and 100');
  }
  if (config.risk.portfolioTakeProfitPercent <= 0) {
    errors.push('portfolioTakeProfitPercent must be > 0');
  }
  if (config.risk.stopLossPercent <= 0 || config.risk.stopLossPercent > 50) {
    errors.push('stopLossPercent must be between 0 and 50');
  }
  if (config.risk.takeProfitPercent <= 0 || config.risk.takeProfitPercent > 100) {
    errors.push('takeProfitPercent must be between 0 and 100');
  }

  // Grid
  if (config.grid.enabled) {
    if (config.grid.gridSpacingPercent <= 0) errors.push('gridSpacingPercent must be > 0');
    if (config.grid.gridLevels < 2) errors.push('gridLevels must be >= 2');
    if (config.grid.orderSizePercent <= 0) errors.push('grid.orderSizePercent must be > 0');
  }

  // DCA
  if (config.dca.enabled) {
    if (config.dca.intervalSec < 60) errors.push('DCA intervalSec must be >= 60 seconds');
    if (config.dca.rsiBoostMultiplier <= 0) errors.push('rsiBoostMultiplier must be > 0');
    if (config.dca.rsiSkipThreshold <= config.dca.rsiBoostThreshold) {
      errors.push('rsiSkipThreshold must be > rsiBoostThreshold');
    }
  }

  // Tick & Sync
  if (config.tickIntervalSec < 10) errors.push('tickIntervalSec must be >= 10 seconds');
  if (config.syncIntervalSec < 0) errors.push('syncIntervalSec must be >= 0 (0 = disabled)');

  if (errors.length > 0) {
    throw new Error('Config validation failed:\n  - ' + errors.join('\n  - '));
  }
}
