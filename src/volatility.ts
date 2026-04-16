// ============================================================
// Volatility Analysis — общий модуль для анализа волатильности
// ============================================================
// Используется как ботом (auto-spacing), так и standalone скриптом (analyze-volatility.ts).
// Все функции — чистая математика + загрузка свечей через callback.

// ── Constants ──────────────────────────────────────────────

export const FEE_ROUND_TRIP_PCT = 0.3; // Bybit spot round-trip: 0.1% buy + 0.1% sell + 0.1 запас

export const PERIODS = [
  { name: '24h', hours: 24 },
  { name: '3d', hours: 72 },
  { name: '7d', hours: 168 },
  { name: '14d', hours: 336 },
];

export const TIMEFRAMES = [
  { tf: '15m', label: '15m' },
  { tf: '1h', label: '1h' },
  { tf: '4h', label: '4h' },
];

// ── Types ──────────────────────────────────────────────────

export interface CandleStats {
  symbol: string;
  timeframe: string;
  period: string;
  candleCount: number;
  currentPrice: number;
  atrPct: number;
  rangeP25: number;
  rangeP50: number;
  rangeP75: number;
  rangeP90: number;
  rangeMax: number;
  rangeMean: number;
  movePct_P50: number;
  movePct_P75: number;
  movePct_P90: number;
  stddevPct: number;
  upCandlesPct: number;
  recBuySpacing: number;
  recSellSpacing: number;
}

export interface SymbolRecommendation {
  symbol: string;
  currentPrice: number;
  buySpacing: number;
  sellSpacing: number;
  volatilityRank: number;
  regime: 'low' | 'normal' | 'high';
  details: CandleStats[];
}

// Callback для загрузки свечей — абстрагирует ccxt от логики анализа
export type CandleFetcher = (
  symbol: string,
  timeframe: string,
  since: number,
  limit: number,
) => Promise<number[][]>;

// ── Helpers ────────────────────────────────────────────────

export function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function round(n: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// ── Core Analysis ──────────────────────────────────────────

export async function analyzeSymbol(
  fetchCandles: CandleFetcher,
  symbol: string,
  timeframe: string,
  periodHours: number,
  periodName: string,
): Promise<CandleStats | null> {
  const since = Date.now() - periodHours * 60 * 60 * 1000;

  // Fetch candles with pagination
  let allCandles: number[][] = [];
  let fetchSince = since;
  const tfMinutes: Record<string, number> = { '15m': 15, '1h': 60, '4h': 240 };
  const minutes = tfMinutes[timeframe] ?? 60;
  const maxCandles = Math.ceil(periodHours * 60 / minutes);

  while (allCandles.length < maxCandles) {
    const limit = Math.min(1000, maxCandles - allCandles.length);
    const candles = await fetchCandles(symbol, timeframe, fetchSince, limit);
    if (candles.length === 0) break;
    allCandles = allCandles.concat(candles);
    fetchSince = (candles[candles.length - 1][0] as number) + 1;
    if (candles.length < limit) break;
  }

  // Filter to period
  allCandles = allCandles.filter(c => c[0] >= since);
  if (allCandles.length < 10) return null;

  const closes = allCandles.map(c => c[4]);
  const highs = allCandles.map(c => c[2]);
  const lows = allCandles.map(c => c[3]);
  const currentPrice = closes[closes.length - 1];

  // ATR
  let atrSum = 0;
  for (let i = 1; i < allCandles.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    atrSum += tr;
  }
  const atrPct = (atrSum / (allCandles.length - 1)) / currentPrice * 100;

  // Range percentiles (high-low)/close
  const ranges: number[] = allCandles.map(c => (c[2] - c[3]) / c[4] * 100);
  ranges.sort((a, b) => a - b);

  // Close-to-close absolute moves
  const moves: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    moves.push(Math.abs(closes[i] - closes[i - 1]) / closes[i - 1] * 100);
  }
  moves.sort((a, b) => a - b);

  // StdDev of returns
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const stddev = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length) * 100;

  // Directional bias
  const upCandles = allCandles.filter(c => c[4] > c[1]).length;
  const upCandlesPct = upCandles / allCandles.length * 100;

  // Recommendations
  const recBuySpacing = Math.round(percentile(ranges, 55) * 100) / 100;
  const minSellForProfit = recBuySpacing + FEE_ROUND_TRIP_PCT;
  const recSellRaw = Math.round(percentile(ranges, 70) * 100) / 100;
  const recSellSpacing = Math.max(recSellRaw, minSellForProfit);

  return {
    symbol,
    timeframe,
    period: periodName,
    candleCount: allCandles.length,
    currentPrice,
    atrPct: round(atrPct),
    rangeP25: round(percentile(ranges, 25)),
    rangeP50: round(percentile(ranges, 50)),
    rangeP75: round(percentile(ranges, 75)),
    rangeP90: round(percentile(ranges, 90)),
    rangeMax: round(ranges[ranges.length - 1]),
    rangeMean: round(ranges.reduce((s, v) => s + v, 0) / ranges.length),
    movePct_P50: round(percentile(moves, 50)),
    movePct_P75: round(percentile(moves, 75)),
    movePct_P90: round(percentile(moves, 90)),
    stddevPct: round(stddev),
    upCandlesPct: round(upCandlesPct),
    recBuySpacing: round(recBuySpacing),
    recSellSpacing: round(recSellSpacing),
  };
}

// ── Weighted recommendation ────────────────────────────────

export function computeRecommendation(
  details: CandleStats[],
): { buySpacing: number; sellSpacing: number; regime: 'low' | 'normal' | 'high' } {
  const weights: Record<string, Record<string, number>> = {
    '24h': { '15m': 0.5, '1h': 2.0, '4h': 0.8 },
    '3d':  { '15m': 0.3, '1h': 1.5, '4h': 1.0 },
    '7d':  { '15m': 0.1, '1h': 1.0, '4h': 0.8 },
    '14d': { '15m': 0.05, '1h': 0.5, '4h': 0.5 },
  };

  let buySum = 0, sellSum = 0, weightSum = 0;
  let atr24h = 0, atr7d = 0;

  for (const d of details) {
    const w = weights[d.period]?.[d.timeframe] ?? 0.5;
    buySum += d.recBuySpacing * w;
    sellSum += d.recSellSpacing * w;
    weightSum += w;

    if (d.period === '24h' && d.timeframe === '1h') atr24h = d.atrPct;
    if (d.period === '7d' && d.timeframe === '1h') atr7d = d.atrPct;
  }

  if (weightSum === 0) return { buySpacing: FEE_ROUND_TRIP_PCT, sellSpacing: FEE_ROUND_TRIP_PCT * 2, regime: 'normal' };

  const buySpacing = round(buySum / weightSum, 2);
  const sellSpacing = round(sellSum / weightSum, 2);

  let regime: 'low' | 'normal' | 'high' = 'normal';
  if (atr7d > 0) {
    const ratio = atr24h / atr7d;
    if (ratio < 0.7) regime = 'low';
    else if (ratio > 1.3) regime = 'high';
  }

  return { buySpacing, sellSpacing, regime };
}

// ── High-level convenience function ────────────────────────

export async function analyzeAllSymbols(
  fetchCandles: CandleFetcher,
  symbols: string[],
  onProgress?: (symbol: string, done: number, total: number) => void,
): Promise<SymbolRecommendation[]> {
  const total = symbols.length * PERIODS.length * TIMEFRAMES.length;
  let done = 0;
  const results: SymbolRecommendation[] = [];

  for (const symbol of symbols) {
    const details: CandleStats[] = [];
    let currentPrice = 0;

    for (const period of PERIODS) {
      for (const { tf } of TIMEFRAMES) {
        try {
          const stats = await analyzeSymbol(fetchCandles, symbol, tf, period.hours, period.name);
          if (stats) {
            details.push(stats);
            currentPrice = stats.currentPrice;
          }
        } catch {
          // Skip failed fetches, continue with available data
        }
        done++;
        if (onProgress) onProgress(symbol, done, total);

        // Small delay between API calls to avoid rate limiting
        await new Promise(r => setTimeout(r, 300));
      }
    }

    if (details.length === 0) continue;

    const { buySpacing, sellSpacing, regime } = computeRecommendation(details);
    results.push({ symbol, currentPrice, buySpacing, sellSpacing, volatilityRank: 0, regime, details });
  }

  // Rank by volatility
  results.sort((a, b) => b.buySpacing - a.buySpacing);
  results.forEach((r, i) => r.volatilityRank = i + 1);
  // Restore original order
  results.sort((a, b) => symbols.indexOf(a.symbol) - symbols.indexOf(b.symbol));

  return results;
}
