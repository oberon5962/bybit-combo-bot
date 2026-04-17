// ============================================================
// Bybit Combo Bot — Type Definitions
// ============================================================

export interface BotConfig {
  // API
  apiKey: string;
  apiSecret: string;
  testnet: boolean;

  // Trading pairs and allocation
  pairs: PairConfig[];

  // Global risk management
  risk: RiskConfig;

  // Strategy parameters
  grid: GridConfig;
  dca: DCAConfig;
  indicators: IndicatorConfig;

  // Meta-signal (combo indicator signals)
  metaSignal: MetaSignalConfig;

  // Market protection
  marketProtection: MarketProtectionConfig;

  // Telegram notifications
  telegram: TelegramConfig;

  // Polling interval in seconds
  tickIntervalSec: number;

  // Sync with exchange interval in seconds (0 = only on startup)
  syncIntervalSec: number;

  // How often to hot-reload config from disk (in ticks). 0 = disabled.
  configReloadIntervalTicks: number;

  // How often to log summary to bot.log (in ticks). 10 = ~100 sec.
  logSummaryIntervalTicks: number;

  // Number of pairs to process in parallel per tick. 1 = sequential, 2+ = parallel batches.
  parallelPairs: number;
}

export interface PairConfig {
  symbol: string;           // e.g. "BTC/USDT"
  allocationPercent: number; // % of total capital for this pair
  gridSpacingPercent?: number;     // per-pair override for buy grid spacing (% от цены)
  gridSpacingSellPercent?: number; // per-pair override for sell grid spacing (% от цены)
}

export interface RiskConfig {
  maxDrawdownPercent: number;   // stop all trading if drawdown exceeds this
  maxOpenOrdersPerPair: number;
  stopLossPercent: number;      // per-position stop-loss
  takeProfitPercent: number;    // per-position take-profit
  portfolioTakeProfitPercent: number; // sell all when portfolio grows by X% from start

  // Cooldown after stop-loss
  cooldownAfterSLSec: number;   // пауза после SL (0 = halt навсегда, как раньше)
  cooldownMaxSL: number;        // макс SL подряд до полного halt

  // Trailing stop-loss
  trailingSLPercent: number;              // trailing SL расстояние от пика (напр. 5%)
  trailingSLActivationPercent: number;    // активация trailing после +N% от entry
}

export interface GridConfig {
  enabled: boolean;
  gridLevels: number;           // number of grid lines
  gridSpacingPercent: number;   // distance between BUY levels as % of price
  gridSpacingSellPercent: number; // distance between SELL levels as % of price (can differ from buy)
  orderSizePercent: number;     // % of pair allocation per grid order
  rebalancePercent: number;         // rebalance grid when price drifts > X% from center
  rsiOverboughtThreshold: number; // skip grid buy when RSI > this (e.g. 70)
  useEmaFilter: boolean;          // skip grid buy on bearish EMA crossover

  // Bollinger Bands adaptive grid
  useBollingerAdaptive: boolean;    // включить адаптивный grid на основе Bollinger Bands
  bollingerBuyMultiplier: number;   // множитель orderSize при цене у нижней полосы (напр. 1.5)
  bollingerSellMultiplier: number;  // множитель orderSize при цене у верхней полосы (напр. 1.5)
  bollingerShiftLevels: number;     // сколько уровней перекинуть в пользу buy/sell (напр. 3)

  // Auto-adaptive spacing (на основе волатильности)
  sellTrailingDownHours: number;            // через N часов sell сдвигается к break-even (0 = выключено)
  minSellProfitPercent: number;             // минимальная прибыль для безубыточного sell (% над avgEntry, покрывает комиссии + буфер)
  maxSellLossPercent: number;               // максимальный убыток в midpoint-режиме (% ниже avgEntry, иначе skip)
  orphanSellMaxPerTick: number;             // максимум orphan-sell ордеров за один тик
  autoSpacingIntervalMin: number;          // как часто пересчитывать (минуты, напр. 360 = каждые 6ч)
  autoSpacingSafetyMarginPercent: number; // коэффициент недоверия — вычитать N% из расчётных значений
  autoSpacingPriority: 'off' | 'config' | 'auto'; // "off" = выключено, "config" = считать но не применять, "auto" = применять
}

export interface DCAConfig {
  enabled: boolean;
  intervalSec: number;          // how often to DCA in seconds (e.g. every 4 hours = 14400)
  baseOrderPercent: number;     // base order as % of pair allocation
  rsiBoostThreshold: number;    // buy more when RSI below this (e.g. 25)
  rsiBoostMultiplier: number;   // multiply order size by this when RSI is low
  rsiSkipThreshold: number;     // skip buying when RSI above this (e.g. 75)
}

export interface IndicatorConfig {
  rsiPeriod: number;            // default 14
  emaFastPeriod: number;        // default 9
  emaSlowPeriod: number;        // default 21
  bollingerPeriod: number;      // default 20
  bollingerStdDev: number;      // default 2
}

export interface MetaSignalConfig {
  enabled: boolean;                 // false = disable meta-signal entirely
  buyRsiThreshold: number;          // regular buy when RSI < this (default 35)
  strongBuyRsiThreshold: number;    // strong buy when RSI < this (default 25)
  sellRsiThreshold: number;         // regular sell when RSI > this (default 70)
  strongSellRsiThreshold: number;   // strong sell when RSI > this (default 80)
  orderSizeMultiplier: number;      // regular order = grid.orderSizePercent * this (e.g. 0.5)
  strongOrderSizeMultiplier: number; // strong order = grid.orderSizePercent * this (e.g. 0.8)
}

export interface MarketProtectionConfig {
  // Market Panic: если N из пар одновременно bearish EMA → снять все buy-ордера
  panicBearishPairsThreshold: number;  // сколько пар должны быть bearish (2 = 2 из 3)

  // BTC Watchdog: если BTC упал > X% за час → пауза всех покупок
  btcWatchdogEnabled: boolean;
  btcDropThresholdPercent: number;     // порог падения BTC за час (3 = -3%)
  btcCheckIntervalSec: number;        // как часто проверять BTC (300 = 5 мин)
}

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
  telegramApiUrl: string;         // custom API endpoint (пусто = api.telegram.org)
  sendSummary: boolean;           // отправлять summary
  sendFills: boolean;             // уведомления о сделках
  sendAlerts: boolean;            // SL/TP/halt/panic/cooldown
  summaryIntervalTicks: number;   // summary раз в N тиков (60 = ~10 мин при 10s tick)
  commandPollIntervalTicks: number; // polling Telegram commands раз в N тиков (0 = выкл)
  confirmationTimeoutSec: number;   // таймаут подтверждения команды в секундах (0 = без таймаута)
}

// ============================================================
// Market Data Types
// ============================================================

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Ticker {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  volume24h: number;
}

export interface Balance {
  free: number;   // available
  used: number;   // in open orders
  total: number;
}

// ============================================================
// Indicator Results
// ============================================================

export interface IndicatorSnapshot {
  rsi: number;
  emaFast: number;
  emaSlow: number;
  emaCrossover: 'bullish' | 'bearish' | 'neutral';
  bollingerUpper: number;
  bollingerMiddle: number;
  bollingerLower: number;
  pricePosition: 'above_upper' | 'above_middle' | 'below_middle' | 'below_lower';
}

// ============================================================
// Order / Trade Types
// ============================================================

export interface BotOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  price: number;
  amount: number;
  filled: number;          // actual filled amount (may differ from amount on partial fills)
  status: 'open' | 'filled' | 'cancelled';
  strategy: 'grid' | 'dca' | 'risk' | 'manual';
  timestamp: number;
}

export interface TradeRecord {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  amount: number;
  cost: number;
  fee: number;
  strategy: 'grid' | 'dca' | 'risk' | 'manual';
  timestamp: number;
  pnl?: number;
}

// ============================================================
// Strategy Signals
// ============================================================

export type Signal = 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';

export interface StrategyDecision {
  strategy: string;
  signal: Signal;
  symbol: string;
  suggestedAmount?: number;
  suggestedPrice?: number;
  reason: string;
}

// ============================================================
// Logger
// ============================================================

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

// ============================================================
// Error Sanitizer — strip API keys/secrets from error messages
// ============================================================

export function sanitizeError(err: unknown): string {
  const msg = String(err);
  return msg
    .replace(/(key|secret|token|auth|password|credential|apiKey|apiSecret)[=:"'\s]+\S+/gi, '$1=***')
    .replace(/(Bearer|Basic)\s+\S+/gi, '$1 ***');
}
