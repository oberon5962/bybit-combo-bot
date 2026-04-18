// ============================================================
// Volatility Analysis — общий модуль для анализа волатильности
// ============================================================
//
// АЛГОРИТМ (полный путь от свечей до spacing в config.jsonc):
//
// Шаг 1. Сбор данных
//   Для каждой пары загружаем свечи по 4 периодам (24h/3d/7d/14d)
//   и 3 таймфреймам (15m/1h/4h) → итого 12 наборов данных на пару.
//   Больше таймфреймов = более полная картина: 15m ловит внутридневной шум,
//   4h показывает структурные движения, 1h — баланс.
//
// Шаг 2. Метрики волатильности (analyzeSymbol)
//   Из каждого набора свечей считаем:
//   а) ATR (Average True Range) — средний истинный диапазон свечи в %
//   б) ranges[] = (high−low)/close — относительный размах каждой свечи в %
//   в) moves[]  = |close[i]−close[i-1]|/close[i-1] — межсвечное движение в %
//
//   Фильтрация выбросов (закон нормального распределения, правило 3σ):
//   Удаляем значения выше μ + 3σ. Это устраняет flash-crash свечи
//   (напр. внезапный памп/дамп на 15%), которые раздували бы среднее
//   и делали spacing слишком широким. После фильтрации вычисляем
//   перцентили уже на "очищенных" данных.
//
//   Рекомендации по spacing для одного набора:
//   recBuySpacing  = P55(ranges) — 55% обычных свечей не дотянутся до
//                   следующего buy-уровня, т.е. каждый fill = реальное движение
//   recSellSpacing = max(P70(ranges), buy + 0.3%) — шире buy + минимум на
//                   покрытие комиссий round-trip (0.1%+0.1%+0.1% запас)
//
// Шаг 3. Взвешенное среднее (computeRecommendation)
//   12 значений recBuySpacing/recSellSpacing объединяются с весами.
//   Свежие данные важнее старых, часовые важнее 15-минутных:
//     24h/1h  → вес 2.0  (главный: текущая волатильность)
//     3d/1h   → вес 1.5
//     24h/4h  → вес 0.8
//     7d/1h   → вес 1.0
//     14d/15m → вес 0.05 (почти не влияет)
//   Итог: одно число buySpacing = Σ(recBuy × w) / Σ(w)
//
//   Режим волатильности (для информации, не влияет на расчёт):
//   ratio = ATR_24h / ATR_7d
//   < 0.7  → 'low'    (рынок затих относительно недельной нормы)
//   > 1.3  → 'high'   (рынок возбуждён, выше недельной нормы)
//   иначе  → 'normal'
//
// Шаг 4. Safety margin и floor (в combo-manager.ts)
//   buySpacing  × (1 − autoSpacingSafetyMarginPercent/100)
//   floor: buy >= 0.3%, sell >= buy + 0.3%
//
// Шаг 5. Запись в config.jsonc (config-writer.ts)
//   Атомарное обновление gridSpacingPercent/gridSpacingSellPercent для каждой пары.
//   Hot-reload подхватывает через ~30с, новые значения применяются
//   при следующем ребалансе сетки.
//
// Используется как ботом (auto-spacing), так и standalone скриптом (analyze-volatility.ts).

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

// Правило 3σ: удаляем выбросы в верхнем хвосте распределения.
// Для нормально распределённых данных μ + 3σ охватывает 99.85% значений —
// всё что выше почти наверняка flash-crash или API-аномалия.
// Применяем только к верхнему хвосту т.к. ranges/moves всегда > 0.
export function trimOutliers(values: number[], sigmaMultiplier = 3): number[] {
  if (values.length < 4) return values;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const stddev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  const upper = mean + sigmaMultiplier * stddev;
  return values.filter(v => v <= upper);
}

// Линейная интерполяция между соседними элементами отсортированного массива.
// Например P55 на массиве [0.3, 0.5, 0.8, 1.1, 1.5] → между индексами 2 и 3.
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

// Анализирует один символ на одном таймфрейме за один период.
// Возвращает CandleStats с метриками волатильности и рекомендациями spacing.
// Вызывается 12 раз на пару (4 периода × 3 таймфрейма).
export async function analyzeSymbol(
  fetchCandles: CandleFetcher,
  symbol: string,
  timeframe: string,
  periodHours: number,
  periodName: string,
  feeRoundTripPct: number = FEE_ROUND_TRIP_PCT,
): Promise<CandleStats | null> {
  const since = Date.now() - periodHours * 60 * 60 * 1000;

  // Загружаем свечи постранично (Bybit отдаёт max 1000 за раз)
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

  // Отсекаем свечи за пределами периода и требуем минимум 10 штук
  allCandles = allCandles.filter(c => c[0] >= since);
  if (allCandles.length < 10) return null;

  const closes = allCandles.map(c => c[4]);
  const highs = allCandles.map(c => c[2]);
  const lows = allCandles.map(c => c[3]);
  const currentPrice = closes[closes.length - 1];

  // ATR (Average True Range) в % от текущей цены.
  // True Range = max(high−low, |high−prevClose|, |low−prevClose|).
  // Учитывает гэпы между свечами в отличие от простого high−low.
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

  // ranges[] = (high−low)/close × 100% — размах каждой свечи в %.
  // Это основа для recBuySpacing/recSellSpacing: spacing должен быть
  // чуть шире типичного размаха, иначе ордера срабатывают на внутрисвечном шуме.
  // Фильтруем 3σ выбросы (flash-crash свечи), затем сортируем для перцентилей.
  const rangesRaw: number[] = allCandles.map(c => (c[2] - c[3]) / c[4] * 100);
  const ranges = trimOutliers(rangesRaw).sort((a, b) => a - b);

  // moves[] = |close[i]−close[i-1]|/close[i-1] × 100% — движение между закрытиями.
  // Дополняет ranges: ranges показывает внутрисвечной шум,
  // moves показывает реальное направленное движение цены.
  const movesRaw: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    movesRaw.push(Math.abs(closes[i] - closes[i - 1]) / closes[i - 1] * 100);
  }
  const moves = trimOutliers(movesRaw).sort((a, b) => a - b);

  // StdDev логарифмических доходностей — стандартная мера волатильности в финансах.
  // Используется только для отображения в логах, не влияет на spacing.
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const stddev = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length) * 100;

  // Доля растущих свечей (close > open) — индикатор бычьего/медвежьего рынка.
  const upCandles = allCandles.filter(c => c[4] > c[1]).length;
  const upCandlesPct = upCandles / allCandles.length * 100;

  // Рекомендации spacing для данного набора (период × таймфрейм).
  // recBuySpacing  = P55: 55% свечей уже не дотянутся до следующего уровня →
  //                  каждый buy fill = реальное движение, не внутрисвечной шум.
  // recSellSpacing = P70, но не меньше buy + 0.3% (комиссии round-trip).
  const recBuySpacing = Math.round(percentile(ranges, 55) * 100) / 100;
  const minSellForProfit = recBuySpacing + feeRoundTripPct;
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

// Объединяет 12 наборов CandleStats в одну рекомендацию через взвешенное среднее.
// Логика весов: чем свежее и чем "средний" таймфрейм — тем важнее.
// 24h/1h → вес 2.0: текущая реальная волатильность, самый важный сигнал.
// 14d/15m → вес 0.05: слишком далёкое прошлое и слишком мелкий шум.
export function computeRecommendation(
  details: CandleStats[],
  feeRoundTripPct: number = FEE_ROUND_TRIP_PCT,
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

    // ATR 24h и 7d используются для определения режима волатильности
    if (d.period === '24h' && d.timeframe === '1h') atr24h = d.atrPct;
    if (d.period === '7d' && d.timeframe === '1h') atr7d = d.atrPct;
  }

  if (weightSum === 0) return { buySpacing: feeRoundTripPct, sellSpacing: feeRoundTripPct * 2, regime: 'normal' };

  const buySpacing = round(buySum / weightSum, 2);
  const sellSpacing = round(sellSum / weightSum, 2);

  // Режим волатильности: сравниваем ATR последних 24h с недельной нормой ATR_7d.
  // ratio < 0.7 → рынок затих (low), ratio > 1.3 → рынок возбуждён (high).
  // Используется только для информации в логах/Telegram, не меняет spacing напрямую.
  let regime: 'low' | 'normal' | 'high' = 'normal';
  if (atr7d > 0) {
    const ratio = atr24h / atr7d;
    if (ratio < 0.7) regime = 'low';
    else if (ratio > 1.3) regime = 'high';
  }

  return { buySpacing, sellSpacing, regime };
}

// ── High-level convenience function ────────────────────────

// Запускает полный анализ для списка символов.
// Вызывается ботом каждые autoSpacingIntervalMin минут и standalone-скриптом analyze-volatility.ts.
// onProgress — callback для отображения прогресса (например, в логах).
export async function analyzeAllSymbols(
  fetchCandles: CandleFetcher,
  symbols: string[],
  onProgress?: (symbol: string, done: number, total: number) => void,
  feeRoundTripPct: number = FEE_ROUND_TRIP_PCT,
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
          const stats = await analyzeSymbol(fetchCandles, symbol, tf, period.hours, period.name, feeRoundTripPct);
          if (stats) {
            details.push(stats);
            currentPrice = stats.currentPrice;
          }
        } catch {
          // Пропускаем неудавшиеся запросы, продолжаем с доступными данными
        }
        done++;
        if (onProgress) onProgress(symbol, done, total);

        // Пауза между запросами к API чтобы не словить rate limit
        await new Promise(r => setTimeout(r, 300));
      }
    }

    if (details.length === 0) continue;

    const { buySpacing, sellSpacing, regime } = computeRecommendation(details, feeRoundTripPct);
    results.push({ symbol, currentPrice, buySpacing, sellSpacing, volatilityRank: 0, regime, details });
  }

  // Ранжируем по волатильности (для standalone-скрипта), затем восстанавливаем исходный порядок
  results.sort((a, b) => b.buySpacing - a.buySpacing);
  results.forEach((r, i) => r.volatilityRank = i + 1);
  results.sort((a, b) => symbols.indexOf(a.symbol) - symbols.indexOf(b.symbol));

  return results;
}
