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
import {
  type CandleFetcher,
  FEE_ROUND_TRIP_PCT,
  PERIODS,
  TIMEFRAMES,
  analyzeAllSymbols,
} from './src/volatility';

// ── Config ──────────────────────────────────────────────────

const SYMBOLS = ['DOT/USDT', 'NEAR/USDT', 'ADA/USDT', 'SUI/USDT', 'SOL/USDT', 'XRP/USDT'];

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

  // CandleFetcher callback — адаптер ccxt → общий модуль
  const fetcher: CandleFetcher = async (symbol, timeframe, since, limit) => {
    return await exchange.fetchOHLCV(symbol, timeframe, since, limit) as number[][];
  };

  const results = await analyzeAllSymbols(fetcher, SYMBOLS, (sym, done, total) => {
    if (done % 3 === 0) console.log(`  ${sym}... (${done}/${total})`);
  });

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
