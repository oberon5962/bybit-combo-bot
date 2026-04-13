// ============================================================
// Bybit Combo Bot — Technical Indicators (pure math, no deps)
// ============================================================

import { OHLCV, IndicatorSnapshot, IndicatorConfig } from './types';

// ----------------------------------------------------------
// RSI (Relative Strength Index)
// ----------------------------------------------------------

export function calcRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50; // neutral fallback

  let gains = 0;
  let losses = 0;

  // Initial average
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smoothed (Wilder's method)
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1) + 0) / period;
    } else {
      avgGain = (avgGain * (period - 1) + 0) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ----------------------------------------------------------
// EMA (Exponential Moving Average)
// ----------------------------------------------------------

export function calcEMA(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);

  // Seed with SMA of first `period` values for accurate initialization
  // (single-value seed causes unreliable EMA on short histories)
  if (values.length >= period) {
    const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const ema: number[] = new Array(period - 1).fill(seed);
    ema.push(seed);
    for (let i = period; i < values.length; i++) {
      ema.push(values[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
  }

  // Not enough data for proper SMA seed — fallback to first value
  const ema: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    ema.push(values[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

export function lastEMA(values: number[], period: number): number {
  const ema = calcEMA(values, period);
  return ema[ema.length - 1] ?? 0;
}

// ----------------------------------------------------------
// SMA (Simple Moving Average) — used for Bollinger
// ----------------------------------------------------------

export function calcSMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] ?? 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ----------------------------------------------------------
// Standard Deviation
// ----------------------------------------------------------

function stdDev(values: number[], period: number): number {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

// ----------------------------------------------------------
// Bollinger Bands
// ----------------------------------------------------------

export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
}

export function calcBollinger(
  closes: number[],
  period: number = 20,
  multiplier: number = 2,
): BollingerBands {
  const middle = calcSMA(closes, period);
  const sd = stdDev(closes, period);
  return {
    upper: middle + multiplier * sd,
    middle,
    lower: middle - multiplier * sd,
  };
}

// ----------------------------------------------------------
// Full Indicator Snapshot
// ----------------------------------------------------------

export function computeIndicators(
  candles: OHLCV[],
  config: IndicatorConfig,
): IndicatorSnapshot {
  // Guard: insufficient data → return neutral snapshot (no trading signals)
  if (candles.length < Math.max(config.rsiPeriod, config.emaSlowPeriod, config.bollingerPeriod) + 1) {
    const price = candles.length > 0 ? candles[candles.length - 1].close : 0;
    return {
      rsi: 50,              // neutral
      emaFast: price,
      emaSlow: price,
      emaCrossover: 'neutral',
      bollingerUpper: price,
      bollingerMiddle: price,
      bollingerLower: price,
      pricePosition: 'above_middle',  // neutral — won't trigger buy or sell
    };
  }

  // Forward-fill NaN/Infinity values to preserve temporal alignment
  // (filtering shifts indices and breaks EMA crossover detection)
  const rawCloses = candles.map((c) => c.close);
  // Find first valid value for leading NaN fill (avoids injecting 0 into calculations)
  const firstValid = rawCloses.find(v => !isNaN(v) && isFinite(v) && v > 0) ?? 0;
  const closes: number[] = [];
  for (let i = 0; i < rawCloses.length; i++) {
    if (!isNaN(rawCloses[i]) && isFinite(rawCloses[i])) {
      closes.push(rawCloses[i]);
    } else {
      closes.push(i > 0 ? closes[i - 1] : firstValid);
    }
  }
  // Check if we still have enough valid data (count from raw, not forward-filled)
  const validCount = rawCloses.filter(c => !isNaN(c) && isFinite(c) && c > 0).length;
  if (validCount < Math.max(config.rsiPeriod, config.emaSlowPeriod, config.bollingerPeriod) + 1) {
    const price = closes.length > 0 ? closes[closes.length - 1] : 0;
    return {
      rsi: 50, emaFast: price, emaSlow: price, emaCrossover: 'neutral',
      bollingerUpper: price, bollingerMiddle: price, bollingerLower: price,
      pricePosition: 'above_middle',
    };
  }

  // RSI
  const rsi = calcRSI(closes, config.rsiPeriod);

  // EMAs
  const emaFastArr = calcEMA(closes, config.emaFastPeriod);
  const emaSlowArr = calcEMA(closes, config.emaSlowPeriod);
  const emaFast = emaFastArr[emaFastArr.length - 1] ?? 0;
  const emaSlow = emaSlowArr[emaSlowArr.length - 1] ?? 0;

  // EMA crossover detection (compare last 2 values)
  let emaCrossover: IndicatorSnapshot['emaCrossover'] = 'neutral';
  if (emaFastArr.length >= 2 && emaSlowArr.length >= 2) {
    const prevFast = emaFastArr[emaFastArr.length - 2];
    const prevSlow = emaSlowArr[emaSlowArr.length - 2];
    if (prevFast <= prevSlow && emaFast > emaSlow) {
      emaCrossover = 'bullish';  // golden cross
    } else if (prevFast >= prevSlow && emaFast < emaSlow) {
      emaCrossover = 'bearish';  // death cross
    }
  }

  // Bollinger Bands
  const bb = calcBollinger(closes, config.bollingerPeriod, config.bollingerStdDev);
  const currentPrice = closes[closes.length - 1] ?? 0;

  let pricePosition: IndicatorSnapshot['pricePosition'] = 'above_middle';
  if (currentPrice >= bb.upper) pricePosition = 'above_upper';
  else if (currentPrice >= bb.middle) pricePosition = 'above_middle';
  else if (currentPrice >= bb.lower) pricePosition = 'below_middle';
  else pricePosition = 'below_lower';

  return {
    rsi,
    emaFast,
    emaSlow,
    emaCrossover,
    bollingerUpper: bb.upper,
    bollingerMiddle: bb.middle,
    bollingerLower: bb.lower,
    pricePosition,
  };
}
