// Temporary script: compare 2-sigma vs 3-sigma auto-spacing
import * as ccxt from 'ccxt';
import * as dotenv from 'dotenv';
import { trimOutliers, percentile, round, computeRecommendation, CandleStats } from '../src/volatility';

dotenv.config();

const SYMBOLS = ['DOT/USDT','NEAR/USDT','ADA/USDT','SUI/USDT','SOL/USDT','XRP/USDT','AAVE/USDT','RENDER/USDT'];
const PERIODS = [
  { name: '24h', hours: 24 },
  { name: '3d',  hours: 72 },
  { name: '7d',  hours: 168 },
  { name: '14d', hours: 336 },
];
const TIMEFRAMES = ['15m', '1h', '4h'];
const FEE = 0.3;

const exchange = new (ccxt as any).bybit({
  apiKey: process.env.BYBIT_API_KEY,
  secret: process.env.BYBIT_API_SECRET,
  options: { defaultType: 'spot' },
});

async function analyzeSymbolWithSigma(symbol: string, sigma: number): Promise<CandleStats[]> {
  const details: CandleStats[] = [];
  for (const period of PERIODS) {
    for (const tf of TIMEFRAMES) {
      try {
        const since = Date.now() - period.hours * 60 * 60 * 1000;
        const tfMin: Record<string,number> = { '15m': 15, '1h': 60, '4h': 240 };
        const maxCandles = Math.ceil(period.hours * 60 / (tfMin[tf] ?? 60));
        let allCandles: number[][] = [];
        let fetchSince = since;
        while (allCandles.length < maxCandles) {
          const limit = Math.min(1000, maxCandles - allCandles.length);
          const candles = await exchange.fetchOHLCV(symbol, tf, fetchSince, limit);
          if (candles.length === 0) break;
          allCandles = allCandles.concat(candles);
          fetchSince = (candles[candles.length - 1][0] as number) + 1;
          if (candles.length < limit) break;
        }
        allCandles = allCandles.filter((c: number[]) => c[0] >= since);
        if (allCandles.length < 10) continue;

        const closes = allCandles.map((c: number[]) => c[4]);
        const highs   = allCandles.map((c: number[]) => c[2]);
        const lows    = allCandles.map((c: number[]) => c[3]);
        const currentPrice = closes[closes.length - 1];

        let atrSum = 0;
        for (let i = 1; i < allCandles.length; i++) {
          atrSum += Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
        }
        const atrPct = (atrSum / (allCandles.length - 1)) / currentPrice * 100;

        const rangesRaw = allCandles.map((c: number[]) => (c[2]-c[3])/c[4]*100);
        const ranges = trimOutliers(rangesRaw, sigma).sort((a:number, b:number) => a - b);

        const movesRaw: number[] = [];
        for (let i = 1; i < closes.length; i++) movesRaw.push(Math.abs(closes[i]-closes[i-1])/closes[i-1]*100);
        const moves = trimOutliers(movesRaw, sigma).sort((a:number, b:number) => a - b);

        const recBuySpacing = Math.round(percentile(ranges, 55) * 100) / 100;
        const recSellSpacing = Math.max(Math.round(percentile(ranges, 70) * 100) / 100, recBuySpacing + FEE);

        const returns: number[] = [];
        for (let i = 1; i < closes.length; i++) returns.push((closes[i]-closes[i-1])/closes[i-1]);
        const meanR = returns.reduce((s:number,r:number) => s+r, 0) / returns.length;
        const stddev = Math.sqrt(returns.reduce((s:number,r:number) => s+(r-meanR)**2, 0) / returns.length) * 100;
        const upCandlesPct = allCandles.filter((c: number[]) => c[4]>c[1]).length / allCandles.length * 100;

        details.push({
          symbol, timeframe: tf, period: period.name, candleCount: allCandles.length,
          currentPrice, atrPct: round(atrPct),
          rangeP25: round(percentile(ranges,25)), rangeP50: round(percentile(ranges,50)),
          rangeP75: round(percentile(ranges,75)), rangeP90: round(percentile(ranges,90)),
          rangeMax: round(ranges[ranges.length-1]), rangeMean: round(ranges.reduce((s:number,v:number)=>s+v,0)/ranges.length),
          movePct_P50: round(percentile(moves,50)), movePct_P75: round(percentile(moves,75)), movePct_P90: round(percentile(moves,90)),
          stddevPct: round(stddev), upCandlesPct: round(upCandlesPct),
          recBuySpacing: round(recBuySpacing), recSellSpacing: round(recSellSpacing),
        });
        await new Promise(r => setTimeout(r, 300));
      } catch { /* skip */ }
    }
  }
  return details;
}

async function main() {
  console.log('Fetching candles for 1σ / 2σ / 3σ...\n');
  const results1: {symbol:string, buy:number, sell:number}[] = [];
  const results2: {symbol:string, buy:number, sell:number}[] = [];
  const results3: {symbol:string, buy:number, sell:number}[] = [];

  for (const symbol of SYMBOLS) {
    process.stdout.write(`  ${symbol}... `);
    const [d1, d2, d3] = await Promise.all([
      analyzeSymbolWithSigma(symbol, 1),
      analyzeSymbolWithSigma(symbol, 2),
      analyzeSymbolWithSigma(symbol, 3),
    ]);
    const rec1 = computeRecommendation(d1, FEE);
    const rec2 = computeRecommendation(d2, FEE);
    const rec3 = computeRecommendation(d3, FEE);
    results1.push({ symbol, buy: rec1.buySpacing, sell: rec1.sellSpacing });
    results2.push({ symbol, buy: rec2.buySpacing, sell: rec2.sellSpacing });
    results3.push({ symbol, buy: rec3.buySpacing, sell: rec3.sellSpacing });
    console.log('done');
  }

  console.log('\n══════════════════════════════════════════════════════════════════════════');
  console.log('  Пара    │  1σ buy/sell    │  2σ buy/sell    │  3σ buy/sell    │  Δ(1σ→3σ)');
  console.log('──────────┼─────────────────┼─────────────────┼─────────────────┼──────────');
  for (let i = 0; i < SYMBOLS.length; i++) {
    const r1 = results1[i], r2 = results2[i], r3 = results3[i];
    const sym = r1.symbol.replace('/USDT','').padEnd(6);
    const s1 = `${r1.buy.toFixed(2)}%/${r1.sell.toFixed(2)}%`.padEnd(15);
    const s2 = `${r2.buy.toFixed(2)}%/${r2.sell.toFixed(2)}%`.padEnd(15);
    const s3 = `${r3.buy.toFixed(2)}%/${r3.sell.toFixed(2)}%`.padEnd(15);
    const db = (r3.buy  - r1.buy ).toFixed(2);
    const ds = (r3.sell - r1.sell).toFixed(2);
    const signb = Number(db) >= 0 ? '+' : '';
    const signs = Number(ds) >= 0 ? '+' : '';
    console.log(`  ${sym}  │  ${s1}│  ${s2}│  ${s3}│  ${signb}${db}/${signs}${ds}`);
  }
  console.log('══════════════════════════════════════════════════════════════════════════\n');
}

main().catch(console.error);
