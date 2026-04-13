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

  // Polling interval in seconds
  tickIntervalSec: number;

  // Sync with exchange interval in seconds (0 = only on startup)
  syncIntervalSec: number;
}

export interface PairConfig {
  symbol: string;           // e.g. "BTC/USDT"
  allocationPercent: number; // % of total capital for this pair
}

export interface RiskConfig {
  maxDrawdownPercent: number;   // stop all trading if drawdown exceeds this
  maxOpenOrdersPerPair: number;
  stopLossPercent: number;      // per-position stop-loss
  takeProfitPercent: number;    // per-position take-profit
  portfolioTakeProfitPercent: number; // sell all when portfolio grows by X% from start
}

export interface GridConfig {
  enabled: boolean;
  gridLevels: number;           // number of grid lines
  gridSpacingPercent: number;   // distance between levels as % of price
  orderSizePercent: number;     // % of pair allocation per grid order
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
  status: 'open' | 'filled' | 'cancelled';
  strategy: 'grid' | 'dca' | 'risk';
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
  strategy: 'grid' | 'dca' | 'risk';
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
