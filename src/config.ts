// ============================================================
// Bybit Combo Bot — Configuration
// ============================================================
//
// API keys: .env file (BYBIT_API_KEY, BYBIT_API_SECRET, etc.)
// All other params: config.jsonc (hot-reloaded at runtime)
// ============================================================

import fs from 'fs';
import path from 'path';
import { BotConfig, GRID_SELL_LEVELS } from './types';
import dotenv from 'dotenv';
dotenv.config();

const CONFIG_PATH = path.resolve(__dirname, '..', 'config.jsonc');

export function loadConfig(): BotConfig {
  // --- .env: API keys & tokens (never hot-reloaded, restart required) ---
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

  // --- config.jsonc: all tunable parameters (hot-reloaded) ---
  // Supports // line comments in JSON
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const stripped = raw.replace(/"(?:[^"\\]|\\.)*"|\/\/.*$/gm, (m) => m.startsWith('"') ? m : '');
  const json = JSON.parse(stripped);

  const gridLevels = json.grid?.gridLevels ?? -1;
  const defaultNum = -1;
  const defaultBool = false;
  const defaultStr = '';

  const config: BotConfig = {
    apiKey,
    apiSecret,
    testnet,

    pairs: (json.pairs ?? [{ "symbol": "BTC/USDT", "allocationPercent": 50 },
                           { "symbol": "ETH/USDT", "allocationPercent": 50 }]).map((p: any) => ({
      symbol: p.symbol,
      allocationPercent: p.allocationPercent,
      ...(p.gridSpacingPercent != null && { gridSpacingPercent: p.gridSpacingPercent }),
      ...(p.gridSpacingSellPercent != null && { gridSpacingSellPercent: p.gridSpacingSellPercent }),
      ...(p.state != null && ['freezebuy', 'sellgrid', 'freeze', 'unfreeze', 'deleted'].includes(p.state) && { state: p.state }),
    })),

    risk: {
      maxDrawdownPercent: json.risk?.maxDrawdownPercent ?? defaultNum,
      maxOpenOrdersPerPair: gridLevels + GRID_SELL_LEVELS + 4,
      stopLossPercent: json.risk?.stopLossPercent ?? defaultNum,
      takeProfitPercent: json.risk?.takeProfitPercent ?? defaultNum,
      portfolioTakeProfitPercent: json.risk?.portfolioTakeProfitPercent ?? defaultNum,
      cooldownAfterSLSec: json.risk?.cooldownAfterSLSec ?? defaultNum,
      cooldownMaxSL: json.risk?.cooldownMaxSL ?? defaultNum,
      trailingSLPercent: json.risk?.trailingSLPercent ?? defaultNum,
      trailingSLActivationPercent: json.risk?.trailingSLActivationPercent ?? defaultNum,
    },

    grid: {
      enabled: json.grid?.enabled ?? defaultBool,
      gridLevels,
      gridSpacingPercent: json.grid?.gridSpacingPercent ?? defaultNum,
      gridSpacingSellPercent: json.grid?.gridSpacingSellPercent ?? defaultNum,
      orderSizePercent: json.grid?.orderSizePercent ?? defaultNum,
      rebalancePercent: json.grid?.rebalancePercent ?? defaultNum,
      rsiOverboughtThreshold: json.grid?.rsiOverboughtThreshold ?? defaultNum,
      useEmaFilter: json.grid?.useEmaFilter ?? defaultBool,
      useBollingerAdaptive: json.grid?.useBollingerAdaptive ?? defaultBool,
      bollingerBuyMultiplier: json.grid?.bollingerBuyMultiplier ?? defaultNum,
      bollingerSellMultiplier: json.grid?.bollingerSellMultiplier ?? defaultNum,
      bollingerShiftLevels: json.grid?.bollingerShiftLevels ?? defaultNum,
      counterSellTrailStepHours: json.grid?.counterSellTrailStepHours ?? defaultNum,
      minSellProfitPercent: json.grid?.minSellProfitPercent ?? defaultNum,
      maxSellLossPercent: json.grid?.maxSellLossPercent ?? defaultNum,
      orphanSellMaxPerTick: json.grid?.orphanSellMaxPerTick ?? defaultNum,
      autoSpacingIntervalMin: json.grid?.autoSpacingIntervalMin ?? defaultNum,
      autoSpacingSafetyMarginPercent: json.grid?.autoSpacingSafetyMarginPercent ?? defaultNum,
      qtySigmas: json.grid?.qtySigmas ?? defaultNum,
      autoSpacingPriority: json.grid?.autoSpacingPriority ?? defaultStr,
    },

    dca: {
      enabled: json.dca?.enabled ?? defaultBool,
      intervalSec: json.dca?.intervalSec ?? defaultNum,
      baseOrderPercent: json.dca?.baseOrderPercent ?? defaultNum,
      rsiBoostThreshold: json.dca?.rsiBoostThreshold ?? defaultNum,
      rsiBoostMultiplier: json.dca?.rsiBoostMultiplier ?? defaultNum,
      rsiSkipThreshold: json.dca?.rsiSkipThreshold ?? defaultNum,
    },

    indicators: {
      rsiPeriod: json.indicators?.rsiPeriod ?? defaultNum,
      emaFastPeriod: json.indicators?.emaFastPeriod ?? defaultNum,
      emaSlowPeriod: json.indicators?.emaSlowPeriod ?? defaultNum,
      bollingerPeriod: json.indicators?.bollingerPeriod ?? defaultNum,
      bollingerStdDev: json.indicators?.bollingerStdDev ?? defaultNum,
    },

    metaSignal: {
      enabled: json.metaSignal?.enabled ?? defaultBool,
      buyRsiThreshold: json.metaSignal?.buyRsiThreshold ?? defaultNum,
      strongBuyRsiThreshold: json.metaSignal?.strongBuyRsiThreshold ?? defaultNum,
      sellRsiThreshold: json.metaSignal?.sellRsiThreshold ?? defaultNum,
      strongSellRsiThreshold: json.metaSignal?.strongSellRsiThreshold ?? defaultNum,
      orderSizeMultiplier: json.metaSignal?.orderSizeMultiplier ?? defaultNum,
      strongOrderSizeMultiplier: json.metaSignal?.strongOrderSizeMultiplier ?? defaultNum,
    },

    marketProtection: {
      panicBearishPairsThreshold: json.marketProtection?.panicBearishPairsThreshold ?? defaultNum,
      btcWatchdogEnabled: json.marketProtection?.btcWatchdogEnabled ?? defaultBool,
      btcDropThresholdPercent: json.marketProtection?.btcDropThresholdPercent ?? defaultNum,
      btcCheckIntervalSec: json.marketProtection?.btcCheckIntervalSec ?? defaultNum,
    },

    telegram: {
      enabled: !!telegramToken && !!telegramChatId,
      botToken: telegramToken,
      chatId: telegramChatId,
      telegramApiUrl: json.telegram?.telegramApiUrl ?? defaultStr,
      sendSummary: json.telegram?.sendSummary ?? defaultBool,
      sendFills: json.telegram?.sendFills ?? defaultBool,
      sendAlerts: json.telegram?.sendAlerts ?? defaultBool,
      summaryIntervalTicks: json.telegram?.summaryIntervalTicks ?? defaultNum,
      commandPollIntervalTicks: json.telegram?.commandPollIntervalTicks ?? defaultNum,
      confirmationTimeoutSec: json.telegram?.confirmationTimeoutSec ?? defaultNum,
    },

    tickIntervalSec: json.tickIntervalSec ?? defaultNum,
    syncIntervalSec: json.syncIntervalSec ?? defaultNum,
    configReloadIntervalTicks: json.configReloadIntervalTicks ?? defaultNum,
    logSummaryIntervalTicks: json.telegram?.logSummaryIntervalTicks ?? json.logSummaryIntervalTicks ?? defaultNum,
    parallelPairs: json.parallelPairs ?? defaultNum,
    allocationPercentMode: json.allocationPercentMode ?? defaultStr,
    dustThresholdUSDT: json.dustThresholdUSDT ?? defaultNum,
  };

  validateConfig(config);
  return config;
}


// ----------------------------------------------------------
// Validation — crash early on bad config
// ----------------------------------------------------------

function validateConfig(config: BotConfig): void {
  const errors: string[] = [];

  // Pairs allocation (deleted pairs excluded from sum)
  const activePairs = config.pairs.filter(p => p.state !== 'deleted');
  const totalAlloc = activePairs.reduce((s, p) => s + p.allocationPercent, 0);
  if (totalAlloc > 100) {
    errors.push(`Total pair allocation is ${totalAlloc}% — must be <= 100%`);
  }
  if (activePairs.length === 0) {
    errors.push('No active trading pairs configured (all deleted?)');
  }
  for (const p of config.pairs) {
    if (p.state === 'deleted') continue;
    if (p.gridSpacingPercent != null && p.gridSpacingPercent <= 0) {
      errors.push(`${p.symbol}: gridSpacingPercent must be > 0`);
    }
    if (p.gridSpacingSellPercent != null && p.gridSpacingSellPercent <= 0) {
      errors.push(`${p.symbol}: gridSpacingSellPercent must be > 0`);
    }
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
  if (config.risk.trailingSLPercent <= 0) {
    errors.push('trailingSLPercent must be > 0 (use 999 to disable TSL)');
  }
  if (config.risk.trailingSLActivationPercent < 0) {
    errors.push('trailingSLActivationPercent must be >= 0 (use 999 to disable TSL)');
  }

  // Grid
  if (config.grid.enabled) {
    if (config.grid.gridSpacingPercent <= 0) errors.push('gridSpacingPercent (buy) must be > 0');
    if (config.grid.gridSpacingSellPercent <= 0) errors.push('gridSpacingSellPercent must be > 0');
    if (config.grid.gridLevels < 1) errors.push('gridLevels must be >= 1 (определяет только количество buy-уровней; sell-уровней всегда ' + GRID_SELL_LEVELS + ')');
    if (config.grid.orderSizePercent <= 0) errors.push('grid.orderSizePercent must be > 0');
    if (config.grid.rebalancePercent <= 0 || config.grid.rebalancePercent > 50) errors.push('grid.rebalancePercent must be between 0 and 50');
    if (config.grid.minSellProfitPercent <= 0 || config.grid.minSellProfitPercent > 5) errors.push('grid.minSellProfitPercent must be between 0 and 5 (typical 0.3)');
    if (config.grid.maxSellLossPercent <= 0 || config.grid.maxSellLossPercent > 10) errors.push('grid.maxSellLossPercent must be between 0 and 10 (typical 1)');
    if (config.grid.orphanSellMaxPerTick < 1 || config.grid.orphanSellMaxPerTick > 100) errors.push('grid.orphanSellMaxPerTick must be between 1 and 100');
    if (config.grid.counterSellTrailStepHours > 72) errors.push('grid.counterSellTrailStepHours must be ≤ 72 (typical 4; 0 = no halving, just snap; <0 = trailing fully off)');
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
      if (config.grid.bollingerShiftLevels < 0 || config.grid.bollingerShiftLevels >= config.grid.gridLevels) {
        errors.push(`bollingerShiftLevels must be between 0 and ${config.grid.gridLevels - 1} (shift применяется к buyLevels=gridLevels; при bullish shift вычитается, buyLevels должен остаться >= 1)`);
      }
    }
    // Auto-spacing validation (always, even when off — user may switch to auto via hot-reload)
    if (!['off', 'config', 'auto'].includes(config.grid.autoSpacingPriority)) {
      errors.push('autoSpacingPriority must be "off", "config" or "auto"');
    }
    if (config.grid.autoSpacingPriority !== 'off') {
      if (config.grid.autoSpacingIntervalMin <= 0 || config.grid.autoSpacingIntervalMin > 2880) {
        errors.push('autoSpacingIntervalMin must be between 1 and 2880 (48h)');
      }
      if (config.grid.autoSpacingSafetyMarginPercent < 0 || config.grid.autoSpacingSafetyMarginPercent > 50) {
        errors.push('autoSpacingSafetyMarginPercent must be between 0 and 50');
      }
      if (![1, 2, 3].includes(config.grid.qtySigmas)) {
        errors.push('qtySigmas must be 1, 2, or 3');
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
  if (config.configReloadIntervalTicks < 0) errors.push('configReloadIntervalTicks must be >= 0 (0 = disabled)');

  if (errors.length > 0) {
    throw new Error('Config validation failed:\n  - ' + errors.join('\n  - '));
  }
}
