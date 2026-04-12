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
      { symbol: 'BTC/USDT', allocationPercent: 40 },
      { symbol: 'ETH/USDT', allocationPercent: 35 },
      { symbol: 'XRP/USDT', allocationPercent: 25 },
    ],

    // -------------------------------------------------------
    // Risk Management
    // -------------------------------------------------------
    risk: {
      maxDrawdownPercent: 15,        // HALT если портфель упал на 15% от пика
      maxOpenOrdersPerPair: 12,      // Запас под 10 grid-уровней + контр-ордера
      stopLossPercent: 8,            // Стоп-лосс на позицию (шире для высокой волатильности)
      takeProfitPercent: 10,          // Тейк-профит (поменьше, чтобы чаще фиксировать)
      portfolioTakeProfitPercent: 30, // Продать ВСЁ когда портфель вырос на 30% от старта
                                      // Было 300 USDT → стало 450 USDT → продаём все монеты
    },

    // -------------------------------------------------------
    // Grid Strategy
    // -------------------------------------------------------
    grid: {
      enabled: true,
      gridLevels: 10,                // 5 buy + 5 sell (плотная сетка, чаще ловит колебания)
      gridSpacingPercent: 0.5,       // 0.5% между уровнями (реагирует на мелкие движения)
      orderSizePercent: 15,          // Каждый ордер = 15% от аллокации пары
    },

    // -------------------------------------------------------
    // DCA Strategy
    // -------------------------------------------------------
    dca: {
      enabled: false,
      intervalMs: 3 * 60 * 60 * 1000,  // Каждые 3 часа
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
    // Bot Tick Interval
    // -------------------------------------------------------
    tickIntervalMs: 60 * 1000,       // Проверка каждые 60 секунд (реже = меньше нагрузка на API)
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
    if (config.dca.intervalMs < 60000) errors.push('DCA interval must be >= 1 minute');
    if (config.dca.rsiBoostMultiplier <= 0) errors.push('rsiBoostMultiplier must be > 0');
    if (config.dca.rsiSkipThreshold <= config.dca.rsiBoostThreshold) {
      errors.push('rsiSkipThreshold must be > rsiBoostThreshold');
    }
  }

  // Tick
  if (config.tickIntervalMs < 10000) errors.push('tickIntervalMs must be >= 10 seconds');

  if (errors.length > 0) {
    throw new Error('Config validation failed:\n  - ' + errors.join('\n  - '));
  }
}
