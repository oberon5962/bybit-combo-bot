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
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const telegramChatId = process.env.TELEGRAM_CHAT_ID ?? '';

  if (!apiKey || !apiSecret) {
    throw new Error(
      'Missing BYBIT_API_KEY or BYBIT_API_SECRET. ' +
      'Copy .env.example to .env and fill in your credentials.',
    );
  }

  const gridLevels = 14;

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
      // { symbol: 'BTC/USDT', allocationPercent: 35 },
      // { symbol: 'ETH/USDT', allocationPercent: 35 },
      { symbol: 'SUI/USDT', allocationPercent: 30 },
      { symbol: 'SOL/USDT', allocationPercent: 30 },
      { symbol: 'XRP/USDT', allocationPercent: 40 },
    ],

    // -------------------------------------------------------
    // Risk Management
    // -------------------------------------------------------
    risk: {
      maxDrawdownPercent: 15,        // HALT если портфель упал на 15% от пика
      maxOpenOrdersPerPair: gridLevels + 4, // Запас под grid-уровни + контр-ордера + orphan sells
      stopLossPercent: 10,            // Стоп-лосс на позицию (шире для высокой волатильности)
      takeProfitPercent: 12,          // Тейк-профит (поменьше, чтобы чаще фиксировать)
      portfolioTakeProfitPercent: 100, // Продать ВСЁ когда портфель вырос на 100% от старта
                                      // Было 200 USDT → стало 400 USDT → продаём все монеты

      // Cooldown после StopLess (SL): пауза 2 часа, после 3  подряд — полный halt
      cooldownAfterSLSec: 30 * 60,       // 30 минут пауза после SL
      cooldownMaxSL: 3,                  // 3 SL подряд → halt до ручного вмешательства

      // Trailing SL: SL двигается вверх за ценой
      trailingSLPercent: 5,              // продаём если цена упала на 5% от пика
      trailingSLActivationPercent: 3,    // trailing включается после +3% от entry
    },

    // -------------------------------------------------------
    // Grid Strategy
    // -------------------------------------------------------
    grid: {
      enabled: true,
      gridLevels,                    // 10 buy + 10 sell (покрытие ±5% от центра)
      gridSpacingPercent: 0.6,       // 0.6% между buy-уровнями
      gridSpacingSellPercent: 1.0,   // 1.2% между sell-уровнями (выше маржа при продаже)
      orderSizePercent: 10,          // Каждый ордер = 10% от аллокации пары
      rebalancePercent: 3,             // Перестроить сетку если цена ушла >3% от центра (~5 из 7 уровней сработают)
      rsiOverboughtThreshold: 70,    // Пропускаем grid-buy при RSI > 70 (100 = отключить)
      useEmaFilter: false,           // Отключен: grid торгует всегда, RSI overbought (70) остаётся как защита

      // Bollinger Bands адаптивный grid (false = отключить)
      // Когда цена у нижней полосы — больше buy уровней + увеличенный orderSize
      // Когда цена у верхней полосы + EMA bearish — больше sell уровней + увеличенный orderSize
      // Когда цена у верхней полосы + EMA bullish — не усиливаем sell (тренд сильный)
      useBollingerAdaptive: true,
      bollingerBuyMultiplier: 1.5,   // orderSize * 1.5 при покупке у нижней полосы
      bollingerSellMultiplier: 1.5,  // orderSize * 1.5 при продаже у верхней полосы (только EMA bearish)
      bollingerShiftLevels: 2,       // перекинуть 2 уровня: напр. 7/7 → 9/5 buy/sell (или 5/9)
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
      rsiPeriod: 14,              // RSI (Relative Strength Index) — период 14 свечей
                                  // RSI < 30 = перепроданность (хорошо покупать)
                                  // RSI > 70 = перекупленность (grid-buy блокируется)
                                  // Используется в grid (rsiOverboughtThreshold) и DCA (rsiBoostThreshold)

      emaFastPeriod: 9,           // EMA быстрая (9 свечей) — реагирует на цену быстрее
      emaSlowPeriod: 21,          // EMA медленная (21 свеча) — показывает тренд
                                  // Когда fast < slow = bearish crossover → grid-buy блокируется
                                  // Когда fast > slow = bullish → покупки разрешены
                                  // Управляется флагом useEmaFilter (false = отключить)

      bollingerPeriod: 20,        // Bollinger Bands — период скользящей средней (20 свечей)
      bollingerStdDev: 2,         // Bollinger Bands — ширина полос (2 стандартных отклонения)
                                  // Пока не используется в торговой логике, подготовлено для
                                  // будущей стратегии: покупать у нижней полосы, продавать у верхней
    },

    // -------------------------------------------------------
    // Meta-Signal — комбинированные сигналы индикаторов
    // -------------------------------------------------------
    metaSignal: {
      enabled: false,                // false = отключить meta-signal (рыночные ордера по RSI+BB+EMA)
      buyRsiThreshold: 35,           // покупка при RSI < 35 + цена ниже BB middle
      strongBuyRsiThreshold: 25,     // сильная покупка при RSI < 25 + bullish EMA + ниже BB lower
      sellRsiThreshold: 75,          // продажа при RSI > 70 + цена выше BB upper
      strongSellRsiThreshold: 80,    // сильная продажа при RSI > 80 + bearish EMA + выше BB upper
      orderSizeMultiplier: 1.0,      // обычный ордер = grid.orderSizePercent * 1.0 (сейчас 10%*1.0=10%)
      strongOrderSizeMultiplier: 1.5, // сильный ордер = grid.orderSizePercent * 1.5 (сейчас 10%*1.5=15%)
    },

    // -------------------------------------------------------
    // Market Protection — защита от рыночной паники
    // -------------------------------------------------------
    marketProtection: {
      panicBearishPairsThreshold: 999,  // У сколько пар должно быть bearish одновременно, при 999 отключено
      btcWatchdogEnabled: true,         // следить за BTC как индикатором рынка (false = отключить)
      btcDropThresholdPercent: 3,       // BTC упал на 3% за час → пауза покупок пока btc не устаканится
      btcCheckIntervalSec: 300,         // проверять BTC каждые 5 минут
    },

    // -------------------------------------------------------
    // Telegram Notifications
    // -------------------------------------------------------
    telegram: {
      enabled: !!telegramToken && !!telegramChatId,
      botToken: telegramToken,
      chatId: telegramChatId,
      sendSummary: true,            // summary в Telegram
      sendFills: true,              // уведомления о сделках
      sendAlerts: true,             // SL/TP/halt/panic
      summaryIntervalTicks: 60,     // summary раз в 60 тиков (~10 мин)
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
  if (config.risk.cooldownAfterSLSec < 0) {
    errors.push('cooldownAfterSLSec must be >= 0 (0 = halt forever)');
  }
  if (config.risk.cooldownMaxSL < 1) {
    errors.push('cooldownMaxSL must be >= 1');
  }
  if (config.risk.trailingSLPercent <= 0 || config.risk.trailingSLPercent > 50) {
    errors.push('trailingSLPercent must be between 0 and 50');
  }
  if (config.risk.trailingSLActivationPercent < 0) {
    errors.push('trailingSLActivationPercent must be >= 0');
  }
  if (config.risk.trailingSLActivationPercent >= config.risk.takeProfitPercent) {
    errors.push('trailingSLActivationPercent must be < takeProfitPercent (otherwise TP fires first)');
  }

  // Grid
  if (config.grid.enabled) {
    if (config.grid.gridSpacingPercent <= 0) errors.push('gridSpacingPercent (buy) must be > 0');
    if (config.grid.gridSpacingSellPercent <= 0) errors.push('gridSpacingSellPercent must be > 0');
    if (config.grid.gridLevels < 2) errors.push('gridLevels must be >= 2');
    if (config.grid.orderSizePercent <= 0) errors.push('grid.orderSizePercent must be > 0');
    if (config.grid.rebalancePercent <= 0 || config.grid.rebalancePercent > 50) errors.push('grid.rebalancePercent must be between 0 and 50');
    if (config.grid.rsiOverboughtThreshold < 50 || config.grid.rsiOverboughtThreshold > 100) {
      errors.push('grid.rsiOverboughtThreshold must be between 50 and 100');
    }
    if (config.grid.useBollingerAdaptive) {
      if (config.grid.bollingerBuyMultiplier < 1 || config.grid.bollingerBuyMultiplier > 3) {
        errors.push('bollingerBuyMultiplier must be between 1 and 3');
      }
      if (config.grid.bollingerSellMultiplier < 1 || config.grid.bollingerSellMultiplier > 3) {
        errors.push('bollingerSellMultiplier must be between 1 and 3');
      }
      if (config.grid.bollingerShiftLevels < 0 || config.grid.bollingerShiftLevels > Math.floor(config.grid.gridLevels / 2)) {
        errors.push(`bollingerShiftLevels must be between 0 and ${Math.floor(config.grid.gridLevels / 2)}`);
      }
    }
  }

  // DCA
  if (config.dca.enabled) {
    if (config.dca.intervalSec < 60) errors.push('DCA intervalSec must be >= 60 seconds');
    if (config.dca.rsiBoostMultiplier <= 0) errors.push('rsiBoostMultiplier must be > 0');
    if (config.dca.rsiSkipThreshold <= config.dca.rsiBoostThreshold) {
      errors.push('rsiSkipThreshold must be > rsiBoostThreshold');
    }
  }

  // Market Protection
  if (config.marketProtection.panicBearishPairsThreshold < 1) {
    errors.push('panicBearishPairsThreshold must be >= 1');
  }
  if (config.marketProtection.btcWatchdogEnabled) {
    if (config.marketProtection.btcDropThresholdPercent <= 0 || config.marketProtection.btcDropThresholdPercent > 50) {
      errors.push('btcDropThresholdPercent must be between 0 and 50');
    }
    if (config.marketProtection.btcCheckIntervalSec < 60) {
      errors.push('btcCheckIntervalSec must be >= 60 seconds');
    }
  }

  // Tick & Sync
  if (config.tickIntervalSec < 10) errors.push('tickIntervalSec must be >= 10 seconds');
  if (config.syncIntervalSec < 0) errors.push('syncIntervalSec must be >= 0 (0 = disabled)');

  if (errors.length > 0) {
    throw new Error('Config validation failed:\n  - ' + errors.join('\n  - '));
  }
}
