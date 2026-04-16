// ============================================================
// Volatility Analyzer — статистика размаха цен для grid spacing
// ============================================================
//
// Запуск (из директории bybit-combo-bot):
//   cd D:\project\bbt\bybit-combo-bot
//   npx ts-node analyze-volatility.ts
//
//   или
//
//   npx ts-node analyze-volatility.ts --file ilya.log

//
// Машиночитаемый JSON-вывод (для интеграции/автоматизации):
//   npx ts-node analyze-volatility.ts --json
//
// Что делает:
//   1. Загружает свечи с Bybit mainnet (публичный API, ключи не нужны)
//      для 6 пар: DOT, NEAR, ADA, SUI, SOL, XRP
//   2. Анализирует волатильность за 4 периода: 24h, 3d, 7d, 14d
//      на 3 таймфреймах: 15m, 1h, 4h
//   3. Считает: ATR%, перцентили размаха (P25–P90), close-to-close движения,
//      StdDev returns, directional bias (% бычьих свечей)
//   4. Рассчитывает рекомендации по gridSpacingPercent / gridSpacingSellPercent
//      с учётом комиссии round-trip (0.2%)
//   5. Выводит: детальные таблицы, сравнение таймфреймов,
//      итоговые рекомендации, готовый JSON для config.jsonc
//
// Логика расчёта spacing:
//   buySpacing  ≈ P55 часового размаха (ловим ~55% движений)
//   sellSpacing ≈ P70 часового размаха (шире, чтобы маржа покрывала комиссии)
//   sellSpacing >= buySpacing + 0.2% (гарантия прибыли после комиссий)
//   Взвешенное среднее: свежие данные (24h, 3d) и 1h таймфрейм имеют больший вес
//
// Время работы: ~30–60 секунд (зависит от API)
// Не влияет на работу бота — только читает данные с биржи
// ============================================================

import ccxt from 'ccxt';
import fs from 'fs';

// ── Config ──────────────────────────────────────────────────

const SYMBOLS = ['DOT/USDT', 'NEAR/USDT', 'ADA/USDT', 'SUI/USDT', 'SOL/USDT', 'XRP/USDT'];

// Периоды анализа (часы)
const PERIODS = [
  { name: '24h', hours: 24 },
  { name: '3d', hours: 72 },
  { name: '7d', hours: 168 },
  { name: '14d', hours: 336 },
];

// Таймфреймы свечей за PERIODS
const TIMEFRAMES = [
  { tf: '15m', label: '15m' },
  { tf: '1h', label: '1h' },
  { tf: '4h', label: '4h' },
];

// Комиссия Bybit spot (maker+taker round-trip)
const FEE_ROUND_TRIP_PCT = 0.3; // 0.1% buy + 0.1% sell + 0.1 запас

// ── Types ───────────────────────────────────────────────────

interface CandleStats {
  symbol: string;
  timeframe: string;
  period: string;
  candleCount: number;
  currentPrice: number;

  // ATR (Average True Range) — средний «истинный диапазон» свечи в % от цены.
  // Для каждой свечи берётся максимум из трёх значений:
  //   1. high - low (размах внутри свечи)
  //   2. |high - предыдущий close| (гэп вверх от прошлого закрытия)
  //   3. |low - предыдущий close| (гэп вниз от прошлого закрытия)
  // Затем усредняется по всем свечам периода и делится на текущую цену → ATR%.
  // Пример: ATR% = 1.14 означает что за 1 свечу цена в среднем двигается на ±1.14%.
  // Используется как базовый ориентир для grid spacing.
  atrPct: number;

  // Range percentiles — перцентили размаха свечей (high-low)/close в %.
  // Для каждой свечи считается (high - low) / close * 100 = размах в %.
  // Все значения сортируются и берутся перцентили:
  rangeP25: number;   // 25% свечей имеют размах меньше этого значения (тихие свечи)
  rangeP50: number;   // медиана — типичный размах свечи. Ключевой ориентир для buySpacing
  rangeP75: number;   // 75% свечей ≤ этого. Ориентир для sellSpacing (ловим большинство движений)
  rangeP90: number;   // 90% свечей ≤ этого. Экстремальные движения, для широкого грида
  rangeMax: number;   // максимальный размах за период (выброс, не ориентир)
  rangeMean: number;  // среднее арифметическое размаха (≈ ATR%, но без учёта гэпов)

  // Close-to-close движение (абсолютное) — показывает реальное смещение цены между свечами.
  // Считается |close[i] - close[i-1]| / close[i-1] * 100 для каждой пары соседних свечей.
  // В отличие от range (high-low), это показывает насколько цена РЕАЛЬНО сдвинулась,
  // а не просто колебалась внутри свечи. Если move маленький, а range большой —
  // цена ходит туда-сюда, но никуда не уходит (хорошо для грида!).
  movePct_P50: number;  // медиана сдвига — типичное смещение за свечу
  movePct_P75: number;  // 75-й перцентиль — заметное движение
  movePct_P90: number;  // 90-й перцентиль — сильное направленное движение

  // Volatility (StdDev returns)
  stddevPct: number;

  // Directional bias
  upCandlesPct: number;  // % свечей с close > open

  // Рекомендации
  recBuySpacing: number;
  recSellSpacing: number;
}

interface SymbolRecommendation {
  symbol: string;
  currentPrice: number;
  // Взвешенная рекомендация по всем периодам/таймфреймам
  buySpacing: number;
  sellSpacing: number;
  volatilityRank: number;  // 1 = самая волатильная
  regime: 'low' | 'normal' | 'high';
  details: CandleStats[];
}

// ── Helpers ─────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  return percentile(s, 50);
}

// ── Analysis ────────────────────────────────────────────────

async function analyzeSymbol(
  exchange: InstanceType<typeof ccxt.bybit>,
  symbol: string,
  timeframe: string,
  periodHours: number,
  periodName: string,
): Promise<CandleStats | null> {
  const since = Date.now() - periodHours * 60 * 60 * 1000;

  // Fetch candles (ccxt may paginate, fetch in chunks)
  let allCandles: any[][] = [];
  let fetchSince = since;
  const tfMinutes: Record<string, number> = { '15m': 15, '1h': 60, '4h': 240 };
  const minutes = tfMinutes[timeframe] ?? 60;
  const maxCandles = Math.ceil(periodHours * 60 / minutes);

  while (allCandles.length < maxCandles) {
    const limit = Math.min(1000, maxCandles - allCandles.length);
    const candles = await exchange.fetchOHLCV(symbol, timeframe, fetchSince, limit) as any[][];
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
  const opens = allCandles.map(c => c[1]);
  const currentPrice = closes[closes.length - 1];

  // ── ATR ──
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

  // ── Range percentiles (high-low)/close ──
  const ranges: number[] = allCandles.map(c => (c[2] - c[3]) / c[4] * 100);
  ranges.sort((a, b) => a - b);

  // ── Close-to-close absolute moves ──
  const moves: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    moves.push(Math.abs(closes[i] - closes[i - 1]) / closes[i - 1] * 100);
  }
  moves.sort((a, b) => a - b);

  // ── StdDev of returns ──
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const stddev = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length) * 100;

  // ── Directional bias ──
  const upCandles = allCandles.filter(c => c[4] > c[1]).length;
  const upCandlesPct = upCandles / allCandles.length * 100;

  // ── Recommendations ──
  // buySpacing: P50-P60 range — ловим ~50-60% движений
  // sellSpacing: P65-P75 range — чуть шире для маржи, покрывающей комиссии
  // Минимум: sellSpacing > buySpacing + FEE_ROUND_TRIP_PCT (иначе нет прибыли)
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

function round(n: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// ── Weighted recommendation across periods ──────────────────

function computeRecommendation(details: CandleStats[]): { buySpacing: number; sellSpacing: number; regime: 'low' | 'normal' | 'high' } {
  // Веса: свежие данные важнее, 1h — основной таймфрейм
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

  const buySpacing = round(buySum / weightSum, 2);
  const sellSpacing = round(sellSum / weightSum, 2);

  // Volatility regime: сравниваем 24h ATR с 7d ATR
  let regime: 'low' | 'normal' | 'high' = 'normal';
  if (atr7d > 0) {
    const ratio = atr24h / atr7d;
    if (ratio < 0.7) regime = 'low';
    else if (ratio > 1.3) regime = 'high';
  }

  return { buySpacing, sellSpacing, regime };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const jsonMode = process.argv.includes('--json');

  // --file <path> — записать вывод в файл (UTF-8), минуя проблемы с кодировкой PowerShell
  const fileIdx = process.argv.indexOf('--file');
  const outFile = fileIdx !== -1 ? process.argv[fileIdx + 1] : null;
  let fileLines: string[] = [];
  const origLog = console.log.bind(console); // сохранили оригинальный console.log
  if (outFile) {
    console.log = (...args: any[]) => {
      origLog(...args);                      // ← вот это выводит на экран
      fileLines.push(args.map(String).join(' ')); // а это копирует в массив
    };
    const origError = console.error.bind(console);
    console.error = (...args: any[]) => {
      origError(...args);
      fileLines.push('[ERROR] ' + args.map(String).join(' '));
    };
  }

  const exchange = new ccxt.bybit({ options: { defaultType: 'spot' } });

  console.log('Volatility Analyzer — grid spacing optimizer');
  console.log('='.repeat(60));
  console.log(`Пары: ${SYMBOLS.join(', ')}`);
  console.log(`Периоды: ${PERIODS.map(p => p.name).join(', ')}`);
  console.log(`Таймфреймы: ${TIMEFRAMES.map(t => t.tf).join(', ')}`);
  console.log(`Комиссия round-trip: ${FEE_ROUND_TRIP_PCT}%`);
  console.log('');

  const results: SymbolRecommendation[] = [];

  for (const symbol of SYMBOLS) {
    const details: CandleStats[] = [];
    let currentPrice = 0;

    for (const period of PERIODS) {
      for (const { tf } of TIMEFRAMES) {
        try {
          const stats = await analyzeSymbol(exchange, symbol, tf, period.hours, period.name);
          if (stats) {
            details.push(stats);
            currentPrice = stats.currentPrice;
          }
        } catch (err) {
          console.error(`  Error ${symbol} ${tf} ${period.name}: ${err}`);
        }
      }
    }

    const { buySpacing, sellSpacing, regime } = computeRecommendation(details);

    results.push({
      symbol,
      currentPrice,
      buySpacing,
      sellSpacing,
      volatilityRank: 0, // заполним ниже
      regime,
      details,
    });
  }

  // Ранжирование по волатильности (по взвешенному buySpacing)
  results.sort((a, b) => b.buySpacing - a.buySpacing);
  results.forEach((r, i) => r.volatilityRank = i + 1);
  // Вернуть в исходный порядок
  results.sort((a, b) => SYMBOLS.indexOf(a.symbol) - SYMBOLS.indexOf(b.symbol));

  // ── JSON output ──
  if (jsonMode) {
    const output = results.map(r => ({
      symbol: r.symbol,
      currentPrice: r.currentPrice,
      buySpacing: r.buySpacing,
      sellSpacing: r.sellSpacing,
      regime: r.regime,
      volatilityRank: r.volatilityRank,
    }));
    console.log(JSON.stringify(output, null, 2));
    if (outFile) {
      fs.writeFileSync(outFile, fileLines.join('\n') + '\n', 'utf-8');
      origLog(`\nРезультат записан в ${outFile}`);
    }
    return;
  }

  // ── Detailed report ──

  // 1. Основная таблица: 1h свечи по всем периодам
  console.log('═══ ДЕТАЛЬНАЯ СТАТИСТИКА (1h свечи) ═══');
  console.log('');

  for (const r of results) {
    const hourly = r.details.filter(d => d.timeframe === '1h');
    console.log(`┌─ ${r.symbol} (${r.currentPrice}) — режим: ${r.regime.toUpperCase()} ─┐`);
    console.log(`│ Период │ Свечей │ ATR%  │  P25  │  P50  │  P75  │  P90  │  Max  │ StdDev │ Up%   │ RecBuy │ RecSell │`);
    console.log(`│────────│────────│───────│───────│───────│───────│───────│───────│────────│───────│────────│─────────│`);
    for (const d of hourly) {
      console.log(`│ ${d.period.padEnd(6)} │ ${String(d.candleCount).padStart(6)} │ ${d.atrPct.toFixed(3)} │ ${d.rangeP25.toFixed(3)} │ ${d.rangeP50.toFixed(3)} │ ${d.rangeP75.toFixed(3)} │ ${d.rangeP90.toFixed(3)} │ ${d.rangeMax.toFixed(3)} │ ${d.stddevPct.toFixed(3)}  │ ${d.upCandlesPct.toFixed(1)}  │ ${d.recBuySpacing.toFixed(2)}   │ ${d.recSellSpacing.toFixed(2)}    │`);
    }
    console.log('');
  }

  // 2. Сравнение таймфреймов (3d период)
  console.log('═══ СРАВНЕНИЕ ТАЙМФРЕЙМОВ (период 3d) ═══');
  console.log('');
  console.log(`│ Пара         │  15m ATR │  1h ATR │  4h ATR │  15m P50 │  1h P50 │  4h P50 │`);
  console.log(`│──────────────│─────────│─────────│─────────│──────────│─────────│─────────│`);
  for (const r of results) {
    const d3 = r.details.filter(d => d.period === '3d');
    const get = (tf: string, field: 'atrPct' | 'rangeP50') => {
      const found = d3.find(d => d.timeframe === tf);
      return found ? found[field].toFixed(3) : '  N/A';
    };
    console.log(`│ ${r.symbol.padEnd(12)} │  ${get('15m', 'atrPct')}  │  ${get('1h', 'atrPct')}  │  ${get('4h', 'atrPct')}  │   ${get('15m', 'rangeP50')}  │  ${get('1h', 'rangeP50')}  │  ${get('4h', 'rangeP50')}  │`);
  }
  console.log('');

  // 3. Close-to-close движения (сколько цена реально смещается между свечами)
  console.log('═══ CLOSE-TO-CLOSE ДВИЖЕНИЯ (1h, 3d) ═══');
  console.log('Показывает насколько цена реально смещается между часовыми свечами');
  console.log('');
  console.log(`│ Пара         │ Move P50 │ Move P75 │ Move P90 │ Комментарий                    │`);
  console.log(`│──────────────│──────────│──────────│──────────│────────────────────────────────│`);
  for (const r of results) {
    const d = r.details.find(x => x.period === '3d' && x.timeframe === '1h');
    if (!d) continue;
    const comment = d.movePct_P50 < 0.3 ? 'очень спокойная' :
                    d.movePct_P50 < 0.5 ? 'спокойная' :
                    d.movePct_P50 < 0.8 ? 'средняя' : 'волатильная';
    console.log(`│ ${r.symbol.padEnd(12)} │  ${d.movePct_P50.toFixed(3)}   │  ${d.movePct_P75.toFixed(3)}   │  ${d.movePct_P90.toFixed(3)}   │ ${comment.padEnd(30)} │`);
  }
  console.log('');

  // 4. Итоговые рекомендации
  console.log('═══ ИТОГОВЫЕ РЕКОМЕНДАЦИИ ═══');
  console.log('Взвешенное среднее по всем периодам и таймфреймам');
  console.log('(свежие данные + 1h таймфрейм имеют больший вес)');
  console.log('');
  console.log(`│ Пара         │ Цена      │ buySpacing │ sellSpacing │ Режим  │ Волат.ранг │ Маржа/цикл │`);
  console.log(`│──────────────│───────────│────────────│────────────│────────│────────────│────────────│`);
  for (const r of results) {
    const margin = (r.sellSpacing - FEE_ROUND_TRIP_PCT).toFixed(2);
    console.log(`│ ${r.symbol.padEnd(12)} │ ${r.currentPrice.toFixed(4).padStart(9)} │    ${r.buySpacing.toFixed(2)}%    │    ${r.sellSpacing.toFixed(2)}%    │ ${r.regime.padEnd(6)} │     #${r.volatilityRank}      │   ~${margin}%     │`);
  }
  console.log('');
  console.log(`Маржа/цикл = sellSpacing - комиссия (${FEE_ROUND_TRIP_PCT}%). Чистая прибыль с каждого buy→sell цикла.`);
  console.log('');

  // 5. Готовый JSON для config.jsonc
  console.log('═══ ГОТОВЫЙ КОНФИГ (copy-paste в config.jsonc) ═══');
  console.log('');
  for (const r of results) {
    console.log(`    { "symbol": "${r.symbol}", "allocationPercent": XX, "gridSpacingPercent": ${r.buySpacing}, "gridSpacingSellPercent": ${r.sellSpacing} },`);
  }
  console.log('');

  // Записать в файл если указан --file
  if (outFile) {
    fs.writeFileSync(outFile, fileLines.join('\n') + '\n', 'utf-8');
    origLog(`\nРезультат записан в ${outFile}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
