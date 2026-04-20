// ============================================================
// Bybit Combo Bot — Combo Strategy Manager (with persistence)
// ============================================================

import {
  BotConfig, PairConfig, Ticker, IndicatorSnapshot,
  StrategyDecision, Logger, sanitizeError,
} from '../types';
import { BybitExchange } from '../exchange';
import { computeIndicators } from '../indicators';
import { loadConfig } from '../config';
import { GridStrategy } from './grid';
import { DCAStrategy } from './dca';
import { StateManager } from '../state';
import { TelegramNotifier, TelegramCommand } from '../telegram';
import { ExchangeSync } from '../sync';
import { analyzeAllSymbols, round as volRound } from '../volatility';
import type { CandleFetcher } from '../volatility';
import { updatePairStateInConfig, updatePairSpacingInConfig, addPairToConfig, markPairDeletedInConfig, rewritePairAllocations } from '../config-writer';
import { POSITION_RECONCILE_TOLERANCE_PERCENT } from '../constants';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const HALT_HINT = 'Для возобновления: /run или halted→false в bot-state.json';

export class ComboManager {
  private config: BotConfig;
  private exchange: BybitExchange;
  private log: Logger;
  private grid: GridStrategy;
  private dca: DCAStrategy;
  private state: StateManager;
  private marketPrecisionCache: Map<string, { amountPrecision: number; minAmount: number; minCost: number }> = new Map();

  // Market protection state
  private marketPanic: boolean = false;
  private btcPaused: boolean = false;
  private lastBtcCheck: number = 0;
  private lastIndicatorsPerPair: Map<string, IndicatorSnapshot> = new Map();
  private lastTickPortfolioValue: number = 0;
  private tg: TelegramNotifier;
  private sync: ExchangeSync | null = null;
  private ticksSinceConfigReload: number = 0;
  private lastConfigHash: string = '';
  private ticksSinceCommandPoll: number = 0;
  private lastAutoSpacingRun: number = 0;
  private autoSpacingRunning: boolean = false;
  private autoSpacingMap: Map<string, { buy: number; sell: number }> = new Map();

  constructor(config: BotConfig, exchange: BybitExchange, log: Logger, state: StateManager) {
    this.config = config;
    this.exchange = exchange;
    this.log = log;
    this.state = state;
    this.grid = new GridStrategy(config, exchange, log, state);
    this.dca = new DCAStrategy(config, exchange, log, state);
    this.tg = new TelegramNotifier(config.telegram, log);
    this.grid.setTelegram(this.tg);
  }

  /** Get current (hot-reloaded) config */
  getConfig(): BotConfig { return this.config; }

  /** Link ExchangeSync so it gets updated on hot-reload */
  setSync(sync: ExchangeSync): void {
    this.sync = sync;
    sync.setSpacingResolver((symbol) => this.grid.getSpacingPublic(symbol));
  }

  // ----------------------------------------------------------
  // Initialize
  // ----------------------------------------------------------

  async init(): Promise<void> {
    // Calculate TOTAL portfolio value (USDT + crypto holdings) for accurate capital tracking
    const { single: balance, all: allBalances } = await this.exchange.fetchBalanceAndAll('USDT');
    let totalPortfolioValue = balance.total;

    for (const pair of this.config.pairs) {
      const base = pair.symbol.split('/')[0];
      const held = allBalances[base];
      if (held && held.total > 0) {
        try {
          const ticker = await this.exchange.fetchTicker(pair.symbol);
          totalPortfolioValue += held.total * ticker.last;
        } catch (err) {
          this.log.error(`Failed to fetch ${pair.symbol} price during init: ${sanitizeError(err)}`);
        }
      }
    }

    if (this.state.startingCapital === 0) {
      this.state.startingCapital = totalPortfolioValue;
    }
    if (this.state.peakCapital === 0 || totalPortfolioValue > this.state.peakCapital) {
      this.state.peakCapital = totalPortfolioValue;
    }

    // On restart: cooldown pairs resume, hard-halted pairs (max SL exceeded) stay halted
    for (const pair of this.config.pairs) {
      const sym = pair.symbol;
      // Clear expired cooldowns
      if (this.state.getCooldownUntil(sym) > 0) {
        if (Date.now() >= this.state.getCooldownUntil(sym)) {
          this.log.info(`Cooldown expired for ${sym}, resuming`);
          this.state.clearCooldown(sym);
        } else {
          const minLeft = Math.ceil((this.state.getCooldownUntil(sym) - Date.now()) / 60000);
          this.log.info(`${sym} in cooldown, ${minLeft} min remaining`);
        }
      }
      // Hard-halted pairs (consecutiveSL >= max) stay halted
      if (this.state.isPairHalted(sym)) {
        const reason = this.state.getHaltReason(sym) ?? '';
        this.log.warn(`Pair ${sym} remains HALTED (${reason}). Edit bot-state.json to resume.`);
      }
    }

    const trades = this.state.getRecentTrades();
    this.log.info('ComboManager initialized', {
      usdtBalance: balance.total,
      totalPortfolioValue: totalPortfolioValue.toFixed(2),
      pairs: this.config.pairs.map((p) => p.symbol),
      savedTrades: trades.length,
      totalTicks: this.state.totalTicks,
      resumed: this.state.totalTicks > 0 ? 'YES — continuing from saved state' : 'NO — fresh start',
    });

    // Restore Telegram update offset from persisted state (prevents replaying commands on restart)
    if (this.state.telegramUpdateId > 0) {
      this.tg.setLastUpdateId(this.state.telegramUpdateId);
    }

    // Initialize config hash to prevent spurious reload on first tick
    const cfgPath = resolve(__dirname, '../../config.jsonc');
    this.lastConfigHash = createHash('md5').update(readFileSync(cfgPath, 'utf-8')).digest('hex');

    // Apply initial per-pair state from config (hot-reload может пропустить первый старт)
    for (const pair of this.config.pairs) {
      const st = pair.state;
      if (!st || st === 'unfreeze') continue;
      const base = pair.symbol.split('/')[0];
      this.log.info(`Startup: applying pair state ${st} for ${pair.symbol}`);
      await this.applyPairState(base, st, false);
    }

    // Register Telegram menu commands (updates /command list in Telegram UI)
    this.tg.registerCommands();

    // Telegram startup message
    const mode = this.config.testnet ? 'TESTNET' : 'LIVE';
    const pairs = this.config.pairs.map(p => `${p.symbol} (${p.allocationPercent}%)`).join(', ');
    this.tg.sendStartup(mode, pairs);
  }

  // ----------------------------------------------------------
  // Auto-spacing: volatility-based grid spacing recalculation
  // ----------------------------------------------------------

  private async runAutoSpacing(): Promise<void> {
    if (this.autoSpacingRunning) return;
    this.autoSpacingRunning = true;
    this.lastAutoSpacingRun = Date.now();

    this.log.info('Auto-spacing: starting volatility analysis...');

    try {
      const symbols = this.config.pairs.map(p => p.symbol);
      const fetcher: CandleFetcher = (symbol, tf, since, limit) =>
        this.exchange.fetchOHLCVRaw(symbol, tf, since, limit);

      const minSellProfitPct = this.config.grid.minSellProfitPercent;
      const results = await analyzeAllSymbols(fetcher, symbols, (sym, done, total) => {
        this.log.debug(`Auto-spacing: ${sym} (${done}/${total})`);
      }, minSellProfitPct, this.config.grid.qtySigmas);

      const safetyMultiplier = 1 - (this.config.grid.autoSpacingSafetyMarginPercent / 100);
      const newMap = new Map<string, { buy: number; sell: number }>();
      const logLines: string[] = [];
      const tgLines: string[] = [];
      const maxSymLen = Math.max(...results.map(r => r.symbol.length));
      const regimeShort: Record<string, string> = { low: 'low ', normal: 'norm', high: 'high' };

      for (const r of results) {
        let buy = volRound(r.buySpacing * safetyMultiplier, 2);
        let sell = volRound(r.sellSpacing * safetyMultiplier, 2);

        // Floor: never below minSellProfitPercent (covers fees + buffer)
        buy = Math.max(buy, minSellProfitPct);
        sell = volRound(Math.max(sell, buy + minSellProfitPct), 2);

        newMap.set(r.symbol, { buy, sell });

        const pair = this.config.pairs.find(p => p.symbol === r.symbol);
        const cfgBuy = pair?.gridSpacingPercent ?? this.config.grid.gridSpacingPercent;
        const cfgSell = pair?.gridSpacingSellPercent ?? this.config.grid.gridSpacingSellPercent;
        const active = this.config.grid.autoSpacingPriority === 'auto' ? 'AUTO' : 'CFG';

        const buyStr = buy.toFixed(2);
        const sellStr = sell.toFixed(2);
        const cfgBuyStr = cfgBuy.toFixed(2);
        const cfgSellStr = cfgSell.toFixed(2);

        const symPaddedLog = (r.symbol + ':').padEnd(maxSymLen + 2);
        const regLog = regimeShort[r.regime] ?? r.regime;
        logLines.push(`  ${symPaddedLog}auto=${buyStr}%/${sellStr}% cfg=${cfgBuyStr}%/${cfgSellStr}% regime=${regLog} [${active}]`);
        const symPadded = (r.symbol + ':').padEnd(maxSymLen + 2);
        const reg = regimeShort[r.regime] ?? r.regime;
        tgLines.push(`${symPadded}${buyStr}%/${sellStr}% (${reg})`);
      }

      this.autoSpacingMap = newMap;
      // Если auto-spacing был отключён во время анализа — не применяем результат
      if (this.config.grid.autoSpacingPriority === 'off') {
        this.log.info('Auto-spacing completed but was disabled during analysis — result not applied');
        return;
      }
      this.grid.setAutoSpacing(newMap);

      // Определить какие пары реально изменили spacing (отличаются от config сейчас).
      // Для них — пишем в config, force-rebalance. Для неизменных — пропускаем (экономия API + нет лишнего ребаланса).
      const changedPairs: string[] = [];
      for (const [sym, spacing] of newMap) {
        const pair = this.config.pairs.find(p => p.symbol === sym);
        const cfgBuy = pair?.gridSpacingPercent ?? this.config.grid.gridSpacingPercent;
        const cfgSell = pair?.gridSpacingSellPercent ?? this.config.grid.gridSpacingSellPercent;
        // Сравниваем через строки с toFixed(2) — точно такой же масштаб что в логе/config.jsonc
        if (spacing.buy.toFixed(2) !== cfgBuy.toFixed(2) || spacing.sell.toFixed(2) !== cfgSell.toFixed(2)) {
          changedPairs.push(sym);
        }
      }

      // Auto-spacing priority=auto → синхронизировать только ИЗМЕНЁННЫЕ значения в config.jsonc
      if (this.config.grid.autoSpacingPriority === 'auto' && changedPairs.length > 0) {
        const cfgPathAs = resolve(__dirname, '../../config.jsonc');
        for (const sym of changedPairs) {
          const spacing = newMap.get(sym);
          if (!spacing) continue;
          try { updatePairSpacingInConfig(cfgPathAs, sym, spacing.buy, spacing.sell); }
          catch (e) { this.log.warn(`config-writer spacing ${sym}: ${sanitizeError(e)}`); }
        }
        this.lastConfigHash = createHash('md5').update(readFileSync(cfgPathAs, 'utf-8')).digest('hex');
        this.log.info(`Auto-spacing: ${changedPairs.length} pair(s) with new values written to config.jsonc (${changedPairs.join(', ')})`);
      } else if (this.config.grid.autoSpacingPriority === 'auto') {
        this.log.info('Auto-spacing: no pairs changed — config.jsonc and grids untouched');
      }

      // Force-rebalance ТОЛЬКО изменённых пар. Раньше срабатывало только на первом запуске —
      // периодические auto-spacing пересчёты не применялись. Теперь каждый раз при изменении.
      if (this.config.grid.autoSpacingPriority === 'auto' && changedPairs.length > 0) {
        for (const sym of changedPairs) this.grid.forceRebalance(sym);
        this.log.info(`Auto-spacing: force-rebalancing ${changedPairs.length} pair(s) with new values`);
      }

      const margin = this.config.grid.autoSpacingSafetyMarginPercent;
      this.log.info(`Auto-spacing done (${results.length} pairs, margin=${margin}%):\n${logLines.join('\n')}`);

      // Telegram
      const priority = this.config.grid.autoSpacingPriority.toUpperCase();
      this.tg.sendAlert(
        `📊 <b>Auto-spacing</b> (margin=${margin}%)\n\n` +
        `<pre>${tgLines.join('\n')}</pre>\n` +
        `Priority: <b>${priority}</b>`,
      );
    } catch (err) {
      this.log.error(`Auto-spacing error (keeping previous values): ${sanitizeError(err)}`);
    } finally {
      this.autoSpacingRunning = false;
    }
  }

  // ----------------------------------------------------------
  // Main tick
  // ----------------------------------------------------------

  async tick(): Promise<void> {
    // Process Telegram commands BEFORE halted check (so /start, /buy work when stopped)
    await this.processTelegramCommands();

    if (this.state.halted) {
      const haltedPairs = this.config.pairs
        .filter(p => this.state.isPairHalted(p.symbol))
        .map(p => {
          const reason = this.state.getHaltReason(p.symbol) ?? 'unknown';
          return `${p.symbol} (${reason})`;
        });
      const pairInfo = haltedPairs.length > 0
        ? ` Halted pairs: ${haltedPairs.join(', ')}`
        : '';
      this.log.warn(`Bot is HALTED.${pairInfo} Send /run in Telegram or set "halted":false in bot-state.json + restart.`);
      return;
    }

    // Hot-reload config from config.jsonc every N ticks
    // When configReloadIntervalTicks=0, still check every 30 ticks to detect re-enable
    const reloadInterval = this.config.configReloadIntervalTicks || 30;
    this.ticksSinceConfigReload++;
    if (this.ticksSinceConfigReload >= reloadInterval) {
      this.ticksSinceConfigReload = 0;
      try {
        const configPath = resolve(__dirname, '../../config.jsonc');
        const content = readFileSync(configPath, 'utf-8');
        const hash = createHash('md5').update(content).digest('hex');
        if (hash !== this.lastConfigHash) {
          this.lastConfigHash = hash;
          const newConfig = loadConfig();
          const prevPairs = this.config.pairs; // сохраняем ДО перезаписи this.config
          this.config = newConfig;
          this.grid.updateConfig(newConfig);
          this.dca.updateConfig(newConfig);
          this.tg.updateConfig(newConfig.telegram);
          if (this.sync) this.sync.updateConfig(newConfig);

          // Hot-reload: обработка per-pair state изменений
          for (const newPair of newConfig.pairs) {
            const oldPair = prevPairs.find(p => p.symbol === newPair.symbol);
            const oldState = oldPair?.state ?? 'unfreeze';
            const newState = newPair.state ?? 'unfreeze';
            if (oldState !== newState) {
              const base = newPair.symbol.split('/')[0];
              this.log.info(`Config hot-reload: ${newPair.symbol} state changed ${oldState} → ${newState}`);
              await this.applyPairState(base, newState, false);
            }
          }

          // Hot-reload: обработка auto-spacing изменений
          if (newConfig.grid.autoSpacingPriority === 'off' && this.autoSpacingMap.size > 0) {
            this.autoSpacingMap.clear();
            this.grid.clearAutoSpacing();
            this.log.info('Auto-spacing disabled — reverting to config values');
          }
          if (newConfig.grid.autoSpacingPriority !== 'off' && this.autoSpacingMap.size > 0) {
            this.grid.setAutoSpacing(this.autoSpacingMap);
            this.log.info(`Auto-spacing map applied to grid (${this.autoSpacingMap.size} pairs, priority=${newConfig.grid.autoSpacingPriority})`);
          }

          this.log.info('Config reloaded from config.jsonc');
        }
      } catch (err) {
        this.log.error(`Config reload failed (keeping previous config): ${sanitizeError(err)}`);
      }
    }

    // Auto-spacing: всегда fire-and-forget (не блокирует торговлю)
    if (this.config.grid.autoSpacingPriority !== 'off' && !this.autoSpacingRunning) {
      const intervalMs = this.config.grid.autoSpacingIntervalMin * 60 * 1000;
      if (this.lastAutoSpacingRun === 0 || Date.now() - this.lastAutoSpacingRun >= intervalMs) {
        this.runAutoSpacing().catch(err => {
          this.log.error(`Auto-spacing background error: ${sanitizeError(err)}`);
          this.autoSpacingRunning = false;
        });
      }
    }

    // Invalidate balance cache at start of tick — forces fresh fetch, then cached for rest of tick
    this.exchange.invalidateBalanceCache();

    // Fetch USDT + all balances in ONE API call (cached for subsequent calls within this tick)
    const { single: currentBalance, all: allBalances } = await this.exchange.fetchBalanceAndAll('USDT');
    let totalPortfolioUSDT = currentBalance.total;

    // Add value of held crypto to portfolio total (skip deleted pairs).
    // Tickers fetched in parallel batches of parallelPairs — ~1 API "wave" instead of N sequential.
    // Each fetchTicker writes to tickerCache, so processPair() downstream reuses it via getCachedOrFreshTicker.
    {
      const pairsToPrice = this.config.pairs.filter(p =>
        p.state !== 'deleted' && !this.state.isPairDeleted(p.symbol) &&
        (allBalances[p.symbol.split('/')[0]]?.total ?? 0) > 0,
      );
      const batchSize = Math.max(1, this.config.parallelPairs || 1);
      for (let i = 0; i < pairsToPrice.length; i += batchSize) {
        const batch = pairsToPrice.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(p => this.exchange.fetchTicker(p.symbol)),
        );
        for (let j = 0; j < batch.length; j++) {
          const r = results[j];
          const pair = batch[j];
          const held = allBalances[pair.symbol.split('/')[0]];
          if (r.status === 'fulfilled' && held) {
            totalPortfolioUSDT += held.total * r.value.last;
          } else if (r.status === 'rejected') {
            this.log.error(`Failed to fetch ticker for ${pair.symbol} during portfolio calc: ${sanitizeError(r.reason)}`);
          }
        }
      }
    }

    // Per-tick position reconciliation: detect manual Bybit UI buys/sells and untracked balance drift.
    // Uses allBalances fetched above (essentially free). Catches desync within ~10 seconds.
    // Preserves avgEntryPrice when known; skips pair if new position has no baseline (let 12h sync handle it).
    for (const pair of this.config.pairs) {
      if (pair.state === 'deleted' || this.state.isPairDeleted(pair.symbol)) continue;
      const base = pair.symbol.split('/')[0];
      const bybitTotal = allBalances[base]?.total ?? 0;
      const statePos = this.state.getPosition(pair.symbol);
      const stateAmt = statePos.amount;
      if (bybitTotal < 1e-8 && stateAmt < 1e-8) continue;
      const ref = Math.max(bybitTotal, stateAmt, 1e-8);
      const diffPct = Math.abs(bybitTotal - stateAmt) / ref * 100;
      if (diffPct <= POSITION_RECONCILE_TOLERANCE_PERCENT) continue;
      // Only reconcile if we have an avgEntry baseline — fallback to sync.ts for fresh positions
      if (statePos.avgEntryPrice <= 0) continue;

      let newCost: number;
      let note: string;
      if (bybitTotal < stateAmt) {
        // External sell: Bybit has less than state thinks. Scale costBasis proportionally,
        // preserving avgEntryPrice (same logic as reducePosition).
        const fraction = bybitTotal / stateAmt;
        newCost = statePos.costBasis * fraction;
        note = `avgEntry ${statePos.avgEntryPrice.toFixed(4)} preserved (external sell)`;
      } else {
        // External buy: Bybit has more than state. The delta was purchased at ~current price,
        // not at the old avgEntryPrice. Blend costs: old position at old avg + delta at current price.
        const delta = bybitTotal - stateAmt;
        const cachedTicker = this.exchange.getCachedTicker(pair.symbol);
        const priceForDelta = cachedTicker?.last && cachedTicker.last > 0
          ? cachedTicker.last
          : statePos.avgEntryPrice;
        newCost = statePos.costBasis + delta * priceForDelta;
        const newAvg = newCost / bybitTotal;
        note = `external buy +${delta.toFixed(6)} @ ~${priceForDelta.toFixed(4)}, avgEntry ${statePos.avgEntryPrice.toFixed(4)} → ${newAvg.toFixed(4)}`;
      }
      this.log.warn(
        `[tick-reconcile] ${pair.symbol}: state=${stateAmt.toFixed(6)}, Bybit=${bybitTotal.toFixed(6)} ` +
        `(${diffPct.toFixed(1)}% diff). ${note}`,
      );
      this.state.setPosition(pair.symbol, bybitTotal, newCost);
    }

    // Deposit/withdrawal detection: compare with previous tick value
    // NOTE: Trigger on jumps >20%. False positives from flash crashes / unrecorded grid fills
    // are handled by checking recent trades AND open grid orders before adjusting capital.
    let skipGlobalChecks = false;
    if (this.lastTickPortfolioValue > 0) {
      const jumpPercent = ((totalPortfolioUSDT - this.lastTickPortfolioValue) / this.lastTickPortfolioValue) * 100;
      if (Math.abs(jumpPercent) > 20) {
        // Check if any trades happened recently (within last 5 tick intervals — enough time for grid fills to be recorded)
        const trades = this.state.getRecentTrades();
        const cutoff = Date.now() - this.config.tickIntervalSec * 5000;
        const hasRecentTrades = trades.length > 0 && trades[trades.length - 1].timestamp > cutoff;

        // Also check if there are open grid orders — fills from these could explain the jump
        const hasOpenGridOrders = this.config.pairs.some(pair => {
          const levels = this.state.getGridLevels(pair.symbol);
          return levels.some(l => l.orderId);
        });

        if (!hasRecentTrades && !hasOpenGridOrders) {
          const change = totalPortfolioUSDT - this.lastTickPortfolioValue;
          if (change > 0) {
            // Deposit
            this.state.startingCapital += change;
            this.state.peakCapital = Math.max(this.state.peakCapital, totalPortfolioUSDT);
            this.log.info(`DEPOSIT DETECTED: +${change.toFixed(2)} USDT → new startingCapital: ${this.state.startingCapital.toFixed(2)}`);
          } else {
            // Withdrawal — adjust startingCapital and peakCapital down, clamp to minimum 1
            this.state.startingCapital = Math.max(1, this.state.startingCapital + change); // change is negative
            this.state.peakCapital = Math.max(totalPortfolioUSDT, this.state.startingCapital);
            this.log.info(`WITHDRAWAL DETECTED: ${change.toFixed(2)} USDT → new startingCapital: ${this.state.startingCapital.toFixed(2)}`);
          }
        } else {
          // Trades or open orders + huge jump → likely market movement or fill, freeze global checks this tick
          skipGlobalChecks = true;
          this.log.warn(`Portfolio spike ${jumpPercent > 0 ? '+' : ''}${jumpPercent.toFixed(0)}% with active trading — freezing peak/drawdown/TP this tick`);
        }
      }
    }
    this.lastTickPortfolioValue = totalPortfolioUSDT;

    if (!skipGlobalChecks) {
      // Update peak capital
      if (totalPortfolioUSDT > this.state.peakCapital) {
        this.state.peakCapital = totalPortfolioUSDT;
      }
    }

    // Check MAX DRAWDOWN — halt if portfolio drops too much
    if (!skipGlobalChecks) {
      const drawdown = this.state.peakCapital > 0
        ? ((this.state.peakCapital - totalPortfolioUSDT) / this.state.peakCapital) * 100
        : 0;
      if (drawdown > this.config.risk.maxDrawdownPercent) {
        this.log.error(`MAX DRAWDOWN EXCEEDED: ${drawdown.toFixed(1)}% > ${this.config.risk.maxDrawdownPercent}%`);
        this.log.error(`HALTING ALL TRADING. ${HALT_HINT}`);
        this.tg.sendAlert(`🚨 <b>MAX DRAWDOWN ${drawdown.toFixed(1)}%</b>\nPeak: ${this.state.peakCapital.toFixed(2)} → ${totalPortfolioUSDT.toFixed(2)} USDT\nBot HALTED!\n${HALT_HINT}`);
        this.state.halted = true;
        return;
      }
    }

    // Check PORTFOLIO TAKE PROFIT — sell everything if target reached
    if (this.state.startingCapital <= 0) {
      this.log.warn('startingCapital not set, skipping take profit check');
    }
    const profitPercent = this.state.startingCapital > 0
      ? ((totalPortfolioUSDT - this.state.startingCapital) / this.state.startingCapital) * 100
      : 0;
    if (!skipGlobalChecks && this.state.startingCapital > 0 && profitPercent >= this.config.risk.portfolioTakeProfitPercent) {
      this.log.info('='.repeat(60));
      this.log.info(`PORTFOLIO TAKE PROFIT TRIGGERED!`);
      this.log.info(`Started with: ${this.state.startingCapital.toFixed(2)} USDT`);
      this.log.info(`Current value: ${totalPortfolioUSDT.toFixed(2)} USDT (+${profitPercent.toFixed(1)}%)`);
      this.log.info(`Target was: +${this.config.risk.portfolioTakeProfitPercent}%`);
      this.log.info('Selling all positions...');
      this.log.info('='.repeat(60));

      await this.sellEverything();
      this.state.halted = true;
      this.tg.sendAlert(`🎉 <b>PORTFOLIO TAKE-PROFIT!</b>\nStart: ${this.state.startingCapital.toFixed(2)} → ${totalPortfolioUSDT.toFixed(2)} USDT (+${profitPercent.toFixed(1)}%)\nAll sold. Bot halted.\n${HALT_HINT}`);
      this.log.info(`All positions sold. Bot halted. Congratulations! ${HALT_HINT}`);
      return;
    }

    // Market protection checks (uses indicators from previous tick — panic state carries over)
    await this.checkMarketPanic();
    await this.checkBtcWatchdog();

    // Record tick
    this.state.recordTick();

    // Process trading pairs in parallel batches
    // parallelPairs=1 → sequential (safe), 2+ → parallel (faster, more API load)
    const batchSize = Math.max(1, this.config.parallelPairs || 1);
    const pairs = this.config.pairs;
    for (let i = 0; i < pairs.length; i += batchSize) {
      if (this.state.halted) {
        this.log.warn(`Bot halted mid-tick (global), skipping remaining pairs`);
        break;
      }
      const batch = pairs.slice(i, i + batchSize);
      await Promise.all(batch.map(async (pair) => {
        if (this.state.halted) return;
        try {
          await this.processPair(pair, totalPortfolioUSDT);
        } catch (err) {
          this.log.error(`Error processing ${pair.symbol}: ${sanitizeError(err)}`);
        }
      }));
    }

    // Log summary every N ticks (configurable, default 10)
    const logInterval = this.config.logSummaryIntervalTicks || 10;
    if (this.state.totalTicks % logInterval === 0) {
      this.logSummary(totalPortfolioUSDT, currentBalance.free);
    }
  }

  // ----------------------------------------------------------
  // Process a single pair
  // ----------------------------------------------------------

  private async processPair(pair: PairConfig, totalUSDT: number): Promise<void> {
    const { symbol } = pair;

    // Skip deleted pairs — completely outside bot responsibility
    if (pair.state === 'deleted' || this.state.isPairDeleted(symbol)) return;

    // Skip halted pairs (max consecutive SL exceeded)
    if (this.state.isPairHalted(symbol)) {
      this.log.debug(`Skipping ${symbol} — pair is halted`);
      return;
    }

    // Cooldown check — pair is paused after SL, waiting to resume
    const cooldownUntil = this.state.getCooldownUntil(symbol);
    if (cooldownUntil > 0) {
      if (Date.now() < cooldownUntil) {
        const minLeft = Math.ceil((cooldownUntil - Date.now()) / 60000);
        this.log.debug(`Skipping ${symbol} — cooldown, ${minLeft} min left`);
        return;
      }
      // Cooldown expired — resume
      this.state.clearCooldown(symbol);
      this.log.info(`${symbol} cooldown expired, resuming trading`);
    }

    // Use TOTAL USDT for allocation — free balance fluctuates as grid locks funds in orders.
    // Grid internally checks free balance before placing sells, so over-allocation is safe.
    const allocationUSDT = totalUSDT * (pair.allocationPercent / 100);

    // Ticker: reuse cache from portfolio calc (same tick, ~<1s old) — avoids duplicate API call.
    // OHLCV always fetched fresh (candles needed for RSI/EMA/BB).
    const [ticker, candles] = await Promise.all([
      this.exchange.getCachedOrFreshTicker(symbol),
      this.exchange.fetchOHLCV(symbol, '5m', 100),
    ]);

    // Guard: skip pair if ticker price is zero or invalid
    if (!ticker.last || ticker.last <= 0 || !isFinite(ticker.last)) {
      this.log.error(`${symbol}: ticker.last is invalid (${ticker.last}), skipping pair this tick`);
      return;
    }

    // Pre-cache amount precision for this symbol (used by evaluateMetaSignal)
    if (!this.marketPrecisionCache.has(symbol)) {
      try {
        const mp = await this.exchange.getMarketPrecision(symbol);
        this.marketPrecisionCache.set(symbol, { amountPrecision: mp.amountPrecision, minAmount: mp.minAmount, minCost: mp.minCost });
      } catch (err) {
        this.log.warn(`Failed to get precision for ${symbol}: ${sanitizeError(err)}`);
      }
    }

    const indicators = computeIndicators(candles, this.config.indicators);

    // Store latest indicators for market panic detection
    this.lastIndicatorsPerPair.set(symbol, indicators);

    this.log.debug(`${symbol} | Price: ${ticker.last} | RSI: ${indicators.rsi.toFixed(1)} | EMA: ${indicators.emaCrossover} | BB: ${indicators.pricePosition}`, {
      symbol,
    });

    // ---- Per-position stop-loss / take-profit check ----
    const slTriggered = await this.checkPositionStopLossTakeProfit(symbol, ticker.last);
    if (slTriggered) {
      // Position was closed by SL/TP — skip normal strategy evaluation this tick
      return;
    }

    // ---- Sellgrid dust-check: если баланс < dustThresholdUSDT — авто-freeze ----
    const pairBase = symbol.split('/')[0];
    if (this.state.isSellGridActive(pairBase)) {
      try {
        const allBals = await this.exchange.fetchAllBalances();
        const heldBase = allBals[pairBase];
        const heldValueUSDT = heldBase && heldBase.total > 0 ? heldBase.total * ticker.last : 0;
        const dustThreshold = this.config.dustThresholdUSDT ?? 1;
        if (heldValueUSDT < dustThreshold) {
          this.log.info(`[sellgrid] ${symbol}: dust detected (${heldValueUSDT.toFixed(4)} USDT < ${dustThreshold} USDT) — auto-freezebuy`);
          const configPathDust = resolve(__dirname, '../../config.jsonc');
          await this.applyPairState(pairBase, 'freezebuy', false);
          try { updatePairStateInConfig(configPathDust, symbol, 'freezebuy'); } catch { /* ignore */ }
          this.lastConfigHash = createHash('md5').update(readFileSync(configPathDust, 'utf-8')).digest('hex');
          this.tg.sendAlert(`🧊 <b>${symbol}</b> — sellgrid завершён (остаток &lt; ${dustThreshold}$). Покупки заморожены, оставшиеся продажи активны.`);
          return;
        }
      } catch (dustErr) {
        this.log.debug(`${symbol}: dust-check failed: ${sanitizeError(dustErr)}`);
      }
    }

    // ---- Freeze check: пара полностью заморожена — только SL/TP (выше), торговля пропускается ----
    if (this.state.isPairFrozen(symbol.split('/')[0])) {
      this.log.debug(`${symbol}: pair is frozen — skipping grid/dca/meta this tick`);
      return;
    }

    const allDecisions: StrategyDecision[] = [];
    const protectionActive = this.isMarketProtectionActive();
    const tradesBeforeGrid = this.state.getRecentTrades().length;

    if (protectionActive) {
      // Market protection active — only check grid fills (to process existing orders,
      // counter-sells, etc.) but don't place new buy orders.
      // Grid.evaluate still runs to detect fills and place counter-SELL orders.
      // We pass indicators so grid can track state, but grid.isBuyAllowed() plus
      // the EMA filter will naturally block new buys when bearish.
      // However, to be safe, we skip DCA and meta-signal entirely.
      const gridDecisions = await this.grid.evaluate(symbol, ticker, indicators, allocationUSDT, true);
      // Only keep non-buy decisions from grid (sells, holds)
      allDecisions.push(...gridDecisions);

      this.log.debug(`${symbol}: market protection active (panic=${this.marketPanic}, btcPaused=${this.btcPaused}) — skipping DCA/meta buys`);
    } else {
      const gridDecisions = await this.grid.evaluate(symbol, ticker, indicators, allocationUSDT, false);
      allDecisions.push(...gridDecisions);

      const dcaDecisions = await this.dca.evaluate(symbol, ticker, indicators, allocationUSDT);
      allDecisions.push(...dcaDecisions);

      const metaSignal = this.evaluateMetaSignal(indicators, ticker, allocationUSDT);
      if (metaSignal) {
        allDecisions.push(metaSignal);
      }
    }

    for (const decision of allDecisions) {
      // When market protection is active, block buy executions but allow sells
      if (protectionActive && (decision.signal === 'buy' || decision.signal === 'strong_buy')) {
        this.log.debug(`${symbol}: blocking ${decision.signal} from ${decision.strategy} — market protection active`);
        continue;
      }
      await this.executeDecision(decision, indicators);
    }

    // Telegram: notify about new fills
    const allTrades = this.state.getRecentTrades();
    if (allTrades.length > tradesBeforeGrid) {
      const newTrades = allTrades.slice(tradesBeforeGrid);
      for (const t of newTrades) {
        const icon = t.side === 'buy' ? '🔵' : '🟠';
        this.tg.sendFill(`${icon} <b>${t.side.toUpperCase()} ${t.symbol}</b>\n${t.amount} @ ${t.price.toFixed(4)}\nCost: ${t.cost.toFixed(2)} USDT | ${t.strategy}`);
      }
    }
  }

  // ----------------------------------------------------------
  // Meta-signal
  // ----------------------------------------------------------

  private roundAmountForSymbol(amount: number, symbol: string): number {
    const cached = this.marketPrecisionCache.get(symbol);
    const precision = cached?.amountPrecision ?? 5;
    const factor = Math.pow(10, precision);
    return Math.floor(amount * factor) / factor;
  }

  private evaluateMetaSignal(
    indicators: IndicatorSnapshot,
    ticker: Ticker,
    allocationUSDT: number,
  ): StrategyDecision | null {
    if (!this.config.metaSignal.enabled) return null;
    const { rsi, emaCrossover, pricePosition } = indicators;
    const sym = ticker.symbol;

    const ms = this.config.metaSignal;
    const gridOrderPct = this.config.grid.orderSizePercent;
    const regularAmount = (allocationUSDT * gridOrderPct * ms.orderSizeMultiplier / 100) / ticker.last;
    const strongAmount = (allocationUSDT * gridOrderPct * ms.strongOrderSizeMultiplier / 100) / ticker.last;

    const cached = this.marketPrecisionCache.get(sym);
    const minAmount = cached?.minAmount ?? 0;
    const minCost = cached?.minCost ?? 0;

    // Helper: check if amount meets exchange minimums
    const isViableOrder = (amount: number): boolean => {
      if (amount < minAmount) {
        this.log.debug(`[combo-meta] ${sym}: amount ${amount} < minAmount ${minAmount}, skipping`);
        return false;
      }
      if (amount * ticker.last < minCost) {
        this.log.debug(`[combo-meta] ${sym}: cost ${(amount * ticker.last).toFixed(2)} < minCost ${minCost}, skipping`);
        return false;
      }
      return true;
    };

    if (rsi < ms.strongBuyRsiThreshold && emaCrossover === 'bullish' && pricePosition === 'below_lower') {
      const amount = this.roundAmountForSymbol(strongAmount, sym);
      if (!isViableOrder(amount)) return null;
      return {
        strategy: 'combo-meta',
        signal: 'strong_buy',
        symbol: sym,
        suggestedAmount: amount,
        reason: `STRONG BUY signal: RSI=${rsi.toFixed(0)}, bullish EMA cross, below Bollinger lower`,
      };
    }

    if (rsi > ms.strongSellRsiThreshold && emaCrossover === 'bearish' && pricePosition === 'above_upper') {
      const pos = this.state.getPosition(sym);
      const sellAmount = pos.amount > 0 ? Math.min(this.roundAmountForSymbol(strongAmount, sym), pos.amount) : 0;
      if (sellAmount <= 0 || !isViableOrder(sellAmount)) return null;
      // Don't sell below entry + fees (0.1% buy + 0.1% sell + 0.1% margin)
      const minSellPrice = pos.avgEntryPrice * (1 + this.config.grid.minSellProfitPercent / 100);
      if (ticker.last < minSellPrice) {
        this.log.info(`[combo-meta] ${sym}: STRONG SELL skipped — price ${ticker.last.toFixed(4)} < minSell ${minSellPrice.toFixed(4)} (entry ${pos.avgEntryPrice.toFixed(4)})`);
        return null;
      }
      return {
        strategy: 'combo-meta',
        signal: 'strong_sell',
        symbol: sym,
        suggestedAmount: sellAmount,
        reason: `STRONG SELL signal: RSI=${rsi.toFixed(0)}, bearish EMA cross, above Bollinger upper`,
      };
    }

    if (rsi < ms.buyRsiThreshold && pricePosition === 'below_middle') {
      const amount = this.roundAmountForSymbol(regularAmount, sym);
      if (!isViableOrder(amount)) return null;
      return {
        strategy: 'combo-meta',
        signal: 'buy',
        symbol: sym,
        suggestedAmount: amount,
        reason: `BUY signal: RSI=${rsi.toFixed(0)}, price below Bollinger middle`,
      };
    }

    if (rsi > ms.sellRsiThreshold && pricePosition === 'above_upper') {
      const pos2 = this.state.getPosition(sym);
      const sellAmt = pos2.amount > 0 ? Math.min(this.roundAmountForSymbol(regularAmount, sym), pos2.amount) : 0;
      if (sellAmt <= 0 || !isViableOrder(sellAmt)) return null;
      // Don't sell below entry + fees (0.1% buy + 0.1% sell + 0.1% margin)
      const minSellPrice2 = pos2.avgEntryPrice * (1 + this.config.grid.minSellProfitPercent / 100);
      if (ticker.last < minSellPrice2) {
        this.log.info(`[combo-meta] ${sym}: SELL skipped — price ${ticker.last.toFixed(4)} < minSell ${minSellPrice2.toFixed(4)} (entry ${pos2.avgEntryPrice.toFixed(4)})`);
        return null;
      }
      return {
        strategy: 'combo-meta',
        signal: 'sell',
        symbol: sym,
        suggestedAmount: sellAmt,
        reason: `SELL signal: RSI=${rsi.toFixed(0)}, price above Bollinger upper`,
      };
    }

    return null;
  }

  // ----------------------------------------------------------
  // Per-position stop-loss / take-profit
  // ----------------------------------------------------------

  private async checkPositionStopLossTakeProfit(
    symbol: string,
    currentPrice: number,
  ): Promise<boolean> {
    const position = this.state.getPosition(symbol);
    if (position.amount <= 0) return false;

    // Guard: if avgEntryPrice is 0 or negative (state corruption), reset position to prevent division by zero
    if (position.avgEntryPrice <= 0) {
      this.log.error(`Invalid avgEntryPrice for ${symbol}: ${position.avgEntryPrice} with amount ${position.amount}. Resetting position.`);
      this.state.resetPosition(symbol);
      return false;
    }

    // Guard: if position value < minCost — это dust, нет смысла триггерить SL/TSL/TP (закончится infinite retry).
    // Сбрасываем trailingPeak чтобы не зацикливаться, оставляем dust в позиции (orphan-sell со временем подхватит).
    try {
      const mp = await this.exchange.getMarketPrecision(symbol);
      if (position.amount * currentPrice < mp.minCost) {
        if (this.state.getTrailingPeak(symbol) > 0) {
          this.log.info(`${symbol}: position is dust (${position.amount} × ${currentPrice} < minCost ${mp.minCost}) — resetting trailingPeak to skip TSL retry loop`);
          this.state.resetTrailingPeak(symbol);
        }
        return false;
      }
    } catch { /* ignore precision fetch errors here */ }

    const { stopLossPercent, takeProfitPercent, trailingSLPercent, trailingSLActivationPercent,
            cooldownAfterSLSec, cooldownMaxSL } = this.config.risk;
    const pnlPercent = ((currentPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100;

    // --- 1. HARD STOP-LOSS: price crashed from entry ---
    if (pnlPercent <= -stopLossPercent) {
      this.log.warn('='.repeat(60));
      this.log.warn(`STOP-LOSS TRIGGERED for ${symbol}!`);
      this.log.warn(`Entry avg: ${position.avgEntryPrice.toFixed(2)} | Current: ${currentPrice.toFixed(2)} | PnL: ${pnlPercent.toFixed(1)}%`);
      this.log.warn('='.repeat(60));

      const sold = await this.closePosition(symbol, position.amount, currentPrice, 'stop-loss');
      if (!sold) {
        this.log.warn(`${symbol} SL: closePosition failed — keeping position in state`);
        return false;
      }
      this.tg.sendAlert(`🔴 <b>STOP-LOSS ${symbol}</b>\nEntry: ${position.avgEntryPrice.toFixed(2)} → ${currentPrice.toFixed(2)}\nPnL: ${pnlPercent.toFixed(1)}%\n${HALT_HINT}`);
      await this.handlePostSL(symbol, position.avgEntryPrice, currentPrice, pnlPercent, cooldownAfterSLSec, cooldownMaxSL);
      return true;
    }

    // --- 2. TRAILING STOP-LOSS: price retreated from peak ---
    if (pnlPercent >= trailingSLActivationPercent) {
      // Update peak price
      this.state.updateTrailingPeak(symbol, currentPrice);
    }

    const trailingPeak = this.state.getTrailingPeak(symbol);
    if (trailingPeak > 0) {
      const dropFromPeak = ((trailingPeak - currentPrice) / trailingPeak) * 100;
      if (dropFromPeak >= trailingSLPercent) {
        const trailingPnl = ((currentPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100;
        this.log.info('='.repeat(60));
        this.log.info(`TRAILING STOP-LOSS TRIGGERED for ${symbol}!`);
        this.log.info(`Entry: ${position.avgEntryPrice.toFixed(2)} | Peak: ${trailingPeak.toFixed(2)} | Current: ${currentPrice.toFixed(2)}`);
        this.log.info(`Drop from peak: -${dropFromPeak.toFixed(1)}% | PnL from entry: ${trailingPnl >= 0 ? '+' : ''}${trailingPnl.toFixed(1)}%`);
        this.log.info('='.repeat(60));

        const sold = await this.closePosition(symbol, position.amount, currentPrice, 'trailing-stop');
        if (!sold) {
          this.log.warn(`${symbol} trailing SL: closePosition failed — keeping position in state`);
          return false;
        }
        this.tg.sendAlert(`🟡 <b>TRAILING SL ${symbol}</b>\nEntry: ${position.avgEntryPrice.toFixed(2)} | Peak: ${trailingPeak.toFixed(2)} → ${currentPrice.toFixed(2)}\nDrop: -${dropFromPeak.toFixed(1)}% | PnL: ${trailingPnl >= 0 ? '+' : ''}${trailingPnl.toFixed(1)}%\n${HALT_HINT}`);
        // closePosition already called reducePosition — only reset if fully sold
        const trailRemaining = this.state.getPosition(symbol);
        if (trailRemaining.amount < 1e-12) {
          this.state.resetPosition(symbol);
        } else {
          this.log.warn(`${symbol} trailing SL: partial sell, ${trailRemaining.amount} still held — position kept`);
        }
        this.state.resetTrailingPeak(symbol);
        this.state.setGridInitialized(symbol, false);

        if (trailingPnl < 0) {
          await this.handlePostSL(symbol, position.avgEntryPrice, currentPrice, trailingPnl, cooldownAfterSLSec, cooldownMaxSL);
          this.log.info(`${symbol} trailing SL done (loss). Cooldown applied.`);
        } else {
          this.state.resetConsecutiveSL(symbol);
          this.log.info(`${symbol} trailing SL done (profit). Grid will rebuild on next tick.`);
        }
        return true;
      }
    }

    // --- 3. TAKE-PROFIT: price reached target ---
    if (pnlPercent >= takeProfitPercent) {
      this.log.info('='.repeat(60));
      this.log.info(`TAKE-PROFIT TRIGGERED for ${symbol}!`);
      this.log.info(`Entry avg: ${position.avgEntryPrice.toFixed(2)} | Current: ${currentPrice.toFixed(2)} | PnL: +${pnlPercent.toFixed(1)}%`);
      this.log.info('='.repeat(60));

      const sold = await this.closePosition(symbol, position.amount, currentPrice, 'take-profit');
      if (!sold) {
        this.log.warn(`${symbol} TP: closePosition failed — keeping position in state`);
        return false;
      }
      this.tg.sendAlert(`🟢 <b>TAKE-PROFIT ${symbol}</b>\nEntry: ${position.avgEntryPrice.toFixed(2)} → ${currentPrice.toFixed(2)}\nPnL: +${pnlPercent.toFixed(1)}%`);
      // closePosition already called reducePosition — only reset if fully sold
      const tpRemaining = this.state.getPosition(symbol);
      if (tpRemaining.amount < 1e-12) {
        this.state.resetPosition(symbol);
      } else {
        this.log.warn(`${symbol} TP: partial sell, ${tpRemaining.amount} still held — position kept`);
      }
      this.state.resetTrailingPeak(symbol);
      this.state.resetConsecutiveSL(symbol);
      this.state.setGridInitialized(symbol, false);
      this.log.info(`${symbol} take-profit done. Grid will rebuild on next tick.`);
      return true;
    }

    return false;
  }

  private async handlePostSL(
    symbol: string,
    entryPrice: number,
    exitPrice: number,
    pnlPercent: number,
    cooldownSec: number,
    maxConsecutive: number,
  ): Promise<void> {
    const count = this.state.incrementConsecutiveSL(symbol);
    // closePosition already called reducePosition — only reset if fully sold
    const remaining = this.state.getPosition(symbol);
    if (remaining.amount < 1e-12) {
      this.state.resetPosition(symbol);
    } else {
      this.log.warn(`${symbol} SL: partial sell, ${remaining.amount} still held — position kept in state`);
    }
    this.state.resetTrailingPeak(symbol);
    this.state.setGridInitialized(symbol, false);

    const reason = `stop-loss: entry ${entryPrice.toFixed(2)}, exit ${exitPrice.toFixed(2)}, PnL ${pnlPercent.toFixed(1)}%`;

    if (count >= maxConsecutive) {
      // Too many SL in a row — full halt
      this.state.haltPair(symbol, `${reason} [${count}x SL — halted]`);
      this.log.warn(`${symbol} HALTED — ${count} consecutive stop-losses. ${HALT_HINT}`);
      this.tg.sendAlert(`🛑 <b>${symbol} HALTED</b>\n${count}x SL подряд — пара остановлена.\n${HALT_HINT}`);
    } else if (cooldownSec > 0) {
      // Cooldown — pause and resume later
      const until = Date.now() + cooldownSec * 1000;
      this.state.setCooldown(symbol, until);
      const hours = (cooldownSec / 3600).toFixed(1);
      this.log.warn(`${symbol} cooldown ${hours}h after SL (${count}/${maxConsecutive}). Will resume at ${new Date(until).toLocaleTimeString()}`);
    } else {
      // cooldownSec = 0 — halt forever (old behavior)
      this.state.haltPair(symbol, reason);
      this.log.warn(`${symbol} HALTED after stop-loss. ${HALT_HINT}`);
      this.tg.sendAlert(`🛑 <b>${symbol} HALTED</b>\nSL сработал, cooldown=0 — пара остановлена навсегда.\n${HALT_HINT}`);
    }
  }

  private async closePosition(
    symbol: string,
    amount: number,
    currentPrice: number,
    reason: 'stop-loss' | 'take-profit' | 'trailing-stop',
  ): Promise<boolean> {
    try {
      // Cancel all open grid orders for this pair first
      await this.grid.cancelAll(symbol);
      this.log.info(`Cancelled grid orders for ${symbol} before ${reason} sell`);

      // Poll for free balance to appear (cancellations may take time to settle)
      const base = symbol.split('/')[0];
      let sellAmount = 0;
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const allBalances = await this.exchange.fetchAllBalances();
        const held = allBalances[base];
        sellAmount = held && held.free > 0 ? Math.min(held.free, amount) : 0;
        if (sellAmount > 0) break;
        this.log.debug(`${reason}: waiting for ${base} balance to free up (attempt ${attempt + 1}/5)`);
      }

      if (sellAmount <= 0) {
        this.log.warn(`${reason}: No free ${base} balance to sell after 5 attempts`);
        return false;
      }

      // Round to market precision to avoid exchange rejection
      try {
        const mp = await this.exchange.getMarketPrecision(symbol);
        const factor = Math.pow(10, mp.amountPrecision);
        sellAmount = Math.floor(sellAmount * factor) / factor;
        if (sellAmount <= 0 || sellAmount < mp.minAmount) {
          this.log.warn(`${reason}: Sell amount ${sellAmount} below minimum ${mp.minAmount} for ${symbol}`);
          return false;
        }
        if (sellAmount * currentPrice < mp.minCost) {
          this.log.warn(`${reason}: Sell cost ${(sellAmount * currentPrice).toFixed(2)} below minCost ${mp.minCost} for ${symbol}`);
          return false;
        }
      } catch (precErr) {
        this.log.warn(`${reason}: Failed to get precision for ${symbol}, using raw amount: ${precErr}`);
      }

      const riskLabel = reason === 'trailing-stop' ? 'trailing-stop-loss' : reason;
      const order = await this.exchange.createMarketSell(symbol, sellAmount, 'risk', riskLabel);
      this.exchange.deductCachedBalance(symbol.split('/')[0], sellAmount);
      const filledAmount = order.filled > 0 ? order.filled : sellAmount;
      const fillPrice = order.price || currentPrice;

      const slCost = filledAmount * fillPrice;
      this.state.addTrade({
        timestamp: Date.now(),
        symbol,
        side: 'sell',
        amount: filledAmount,
        price: fillPrice,
        cost: slCost,
        fee: slCost * 0.001,
        strategy: reason,
      });

      // Update position tracking with actual filled amount
      this.state.reducePosition(symbol, filledAmount);

      const position = this.state.getPosition(symbol);
      this.log.info(`${reason.toUpperCase()} executed for ${symbol}`, {
        sold: sellAmount,
        price: fillPrice.toFixed(2),
        remainingPosition: position.amount,
      });
      return true;
    } catch (err) {
      this.log.error(`${reason} execution failed for ${symbol}: ${sanitizeError(err)}`);
      return false;
    }
  }

  // ----------------------------------------------------------
  // Execute decisions
  // ----------------------------------------------------------

  private async executeDecision(
    decision: StrategyDecision,
    indicators: IndicatorSnapshot,
  ): Promise<void> {
    const { signal, symbol, suggestedAmount, suggestedPrice, reason, strategy } = decision;

    this.log.info(`[${strategy}] ${signal.toUpperCase()} ${symbol}: ${reason}`);

    if (!suggestedAmount || suggestedAmount <= 0) return;
    if (signal === 'hold') return;

    if (
      (signal === 'buy' || signal === 'strong_buy') &&
      indicators.emaCrossover === 'bearish' &&
      strategy !== 'combo-meta'
    ) {
      this.log.debug(`Skipping ${strategy} buy for ${symbol} — bearish EMA crossover active`);
      // DO NOT reset DCA timer — DCA should retry when EMA turns bullish.
      // Setting the timer here would block DCA for the entire interval during downtrends,
      // which is the worst time to skip buying (DCA is designed to accumulate on dips).
      return;
    }

    // maxOpenOrders check — only relevant for limit orders (grid handles its own).
    // DCA and combo-meta decisions that reach here are always MARKET orders
    // which execute instantly and don't occupy an order slot.
    // Grid decisions never reach here (they return signal='hold').
    // So this check is skipped for market-order strategies.

    try {
      // Note: only DCA and combo-meta decisions reach here (grid returns signal='hold').
      // All orders are market orders — limit orders are handled directly by grid.ts.
      const ticker = await this.exchange.fetchTicker(symbol);
      const fallbackPrice = ticker.last;

      if (signal === 'buy' || signal === 'strong_buy') {
        // Check free USDT before market buy
        const usdtBal = await this.exchange.fetchBalance('USDT');
        const estimatedCost = suggestedAmount * fallbackPrice;
        if (usdtBal.free < estimatedCost) {
          this.log.debug(`${symbol}: skipping ${strategy} buy — free USDT ${usdtBal.free.toFixed(2)} < needed ${estimatedCost.toFixed(2)}`);
          return;
        }
        const order = await this.exchange.createMarketBuy(symbol, suggestedAmount, strategy as any);
        this.exchange.deductCachedBalance('USDT', suggestedAmount * fallbackPrice);
        const filledAmount = order.filled > 0 ? order.filled : suggestedAmount;
        const buyPrice = order.price || fallbackPrice;
        const buyCost = filledAmount * buyPrice;
        this.state.addTrade({
          timestamp: Date.now(), symbol, side: 'buy',
          amount: filledAmount, price: buyPrice,
          cost: buyCost, fee: buyCost * 0.001, strategy,
        });
        // Track position for stop-loss / take-profit
        this.state.addToPosition(symbol, filledAmount, filledAmount * buyPrice);
        // Update DCA-specific stats and timer
        if (strategy === 'dca') {
          this.state.addDcaPurchase(symbol, filledAmount * buyPrice, filledAmount);
          this.state.setLastDcaBuyTime(symbol, Date.now());
        }
      } else if (signal === 'sell' || signal === 'strong_sell') {
        // Check free crypto balance before market sell (crypto may be locked in limit sell orders)
        const base = symbol.split('/')[0];
        const allBal = await this.exchange.fetchAllBalances();
        const freeCrypto = allBal[base]?.free ?? 0;
        if (freeCrypto < suggestedAmount * 0.5) {
          this.log.debug(`${symbol}: skipping ${strategy} sell — free ${base} ${freeCrypto.toFixed(6)} < needed ${suggestedAmount.toFixed(6)} (locked in orders)`);
          return;
        }
        // Use actual free balance if less than suggested (partial sell)
        const sellAmount = Math.min(suggestedAmount, freeCrypto);
        const order = await this.exchange.createMarketSell(symbol, sellAmount, strategy as any);
        this.exchange.deductCachedBalance(base, sellAmount);
        const filledAmount = order.filled > 0 ? order.filled : suggestedAmount;
        const sellPrice = order.price || fallbackPrice;
        const sellCost = filledAmount * sellPrice;
        this.state.addTrade({
          timestamp: Date.now(), symbol, side: 'sell',
          amount: filledAmount, price: sellPrice,
          cost: sellCost, fee: sellCost * 0.001, strategy,
        });
        // Track position for stop-loss / take-profit
        this.state.reducePosition(symbol, filledAmount);
      }
    } catch (err) {
      this.log.error(`Order execution failed: ${err}`, { decision });
    }
  }

  // ----------------------------------------------------------
  // Sell everything — triggered by portfolio take profit
  // ----------------------------------------------------------

  private async sellEverything(): Promise<void> {
    // 1. Cancel ALL open orders on all pairs
    for (const pair of this.config.pairs) {
      try {
        await this.grid.cancelAll(pair.symbol);
        this.log.info(`Cancelled all orders for ${pair.symbol}`);
      } catch (err) {
        this.log.error(`Failed to cancel orders for ${pair.symbol}: ${sanitizeError(err)}`);
      }
    }

    // 2. Wait for cancellations to settle on exchange
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 3. Fetch FRESH balances (after cancellations freed up crypto)
    const allBalances = await this.exchange.fetchAllBalances();
    for (const pair of this.config.pairs) {
      const base = pair.symbol.split('/')[0]; // "BTC" from "BTC/USDT"
      const held = allBalances[base];
      if (held && held.free > 0) {
        // After cancelling all orders, free should be close to total
        const sellAmount = held.free;
        if (sellAmount <= 0) {
          this.log.warn(`${base}: total=${held.total} but free=0 — some may still be locked`);
          continue;
        }
        try {
          // Round to market precision
          let roundedSellAmount = held.free;
          try {
            const mp = await this.exchange.getMarketPrecision(pair.symbol);
            const factor = Math.pow(10, mp.amountPrecision);
            roundedSellAmount = Math.floor(roundedSellAmount * factor) / factor;
            if (roundedSellAmount <= 0 || roundedSellAmount < mp.minAmount) {
              this.log.warn(`${base}: rounded amount ${roundedSellAmount} below minimum — skipping`);
              continue;
            }
          } catch (precErr) {
            this.log.warn(`Failed to get precision for ${pair.symbol}, using raw amount: ${precErr}`);
          }

          const ticker = await this.exchange.fetchTicker(pair.symbol);
          const valueUSDT = roundedSellAmount * ticker.last;
          // Check minCost before selling
          try {
            const mp = await this.exchange.getMarketPrecision(pair.symbol);
            if (valueUSDT < mp.minCost) {
              this.log.warn(`${base}: sell value ${valueUSDT.toFixed(2)} USDT below minCost ${mp.minCost} — skipping`);
              continue;
            }
          } catch { /* precision already checked above */ }
          this.log.info(`Selling ${roundedSellAmount} ${base} (~${valueUSDT.toFixed(2)} USDT)`);

          const order = await this.exchange.createMarketSell(pair.symbol, roundedSellAmount, 'risk', 'portfolio take-profit');
          this.exchange.deductCachedBalance(base, roundedSellAmount);
          const filledAmount = order.filled > 0 ? order.filled : roundedSellAmount;
          const tpPrice = order.price || ticker.last;
          const tpCost = filledAmount * tpPrice;
          this.state.addTrade({
            timestamp: Date.now(),
            symbol: pair.symbol,
            side: 'sell',
            amount: filledAmount,
            price: tpPrice,
            cost: tpCost,
            fee: tpCost * 0.001,
            strategy: 'portfolio-take-profit',
          });

          this.log.info(`SOLD ${base}: ${filledAmount} @ ~${(order.price || ticker.last).toFixed(2)}`);

          // Only reset if fully sold, otherwise reduce by actual fill
          if (filledAmount >= roundedSellAmount * 0.99) {
            this.state.resetPosition(pair.symbol);
          } else {
            this.state.reducePosition(pair.symbol, filledAmount);
            this.log.warn(`${base}: partial fill ${filledAmount}/${roundedSellAmount} — position reduced, not reset`);
          }
        } catch (err) {
          this.log.error(`Failed to sell ${base}: ${sanitizeError(err)}`);
        }
      }
    }

    // 3. Sell manual pairs (bought via /buy, not in config)
    const manualPairs = this.state.getManualPairs();
    if (manualPairs.length > 0) {
      const freshBalances = await this.exchange.fetchAllBalances();
      for (const sym of manualPairs) {
        const base = sym.split('/')[0];
        if (this.config.pairs.some(p => p.symbol === sym)) continue; // already handled above
        const held = freshBalances[base];
        if (!held || held.free <= 0) continue;

        try {
          // Cancel any open orders for this pair
          await this.exchange.cancelAllOrders(sym);
          await new Promise(resolve => setTimeout(resolve, 500));

          const updatedBal = await this.exchange.fetchAllBalances();
          let sellAmount = updatedBal[base]?.free ?? 0;
          if (sellAmount <= 0) continue;

          const mp = await this.exchange.getMarketPrecision(sym);
          const factor = Math.pow(10, mp.amountPrecision);
          sellAmount = Math.floor(sellAmount * factor) / factor;
          if (sellAmount < mp.minAmount) continue;

          const ticker = await this.exchange.fetchTicker(sym);
          if (sellAmount * ticker.last < mp.minCost) continue;

          const order = await this.exchange.createMarketSell(sym, sellAmount, 'manual', 'sell-all');
          this.exchange.deductCachedBalance(sym.split('/')[0], sellAmount);
          const filledAmount = order.filled > 0 ? order.filled : sellAmount;
          const sellPrice = order.price || ticker.last;
          this.state.addTrade({
            timestamp: Date.now(), symbol: sym, side: 'sell',
            amount: filledAmount, price: sellPrice,
            cost: filledAmount * sellPrice, fee: filledAmount * sellPrice * 0.001,
            strategy: 'manual',
          });
          this.state.reducePosition(sym, filledAmount);
          this.log.info(`SOLD manual ${base}: ${filledAmount} @ ${sellPrice.toFixed(4)}`);
        } catch (err) {
          this.log.error(`Failed to sell manual pair ${sym}: ${sanitizeError(err)}`);
        }
      }
    }

    // 4. Final balance
    const finalBalance = await this.exchange.fetchBalance('USDT');
    const profit = finalBalance.total - this.state.startingCapital;
    const profitPct = (profit / this.state.startingCapital) * 100;
    this.log.info('='.repeat(60));
    this.log.info(`FINAL BALANCE: ${finalBalance.total.toFixed(2)} USDT`);
    this.log.info(`PROFIT: +${profit.toFixed(2)} USDT (+${profitPct.toFixed(1)}%)`);
    this.log.info('='.repeat(60));
  }

  // ----------------------------------------------------------
  // Market Protection — panic detector & BTC watchdog
  // ----------------------------------------------------------

  private async checkMarketPanic(): Promise<void> {
    const threshold = this.config.marketProtection.panicBearishPairsThreshold;
    const activePairsForPanic = this.config.pairs.filter(p => p.state !== 'deleted' && !this.state.isPairDeleted(p.symbol));
    const total = activePairsForPanic.length;
    let bearishCount = 0;

    for (const pair of activePairsForPanic) {
      const ind = this.lastIndicatorsPerPair.get(pair.symbol);
      if (ind && ind.emaFast < ind.emaSlow) {
        bearishCount++;
      }
    }

    if (bearishCount >= threshold) {
      if (!this.marketPanic) {
        this.marketPanic = true;
        this.log.warn(`MARKET PANIC: ${bearishCount}/${total} pairs bearish — all grid buys cancelled`);
        await this.cancelAllBuyOrders();
      }
    } else {
      if (this.marketPanic) {
        this.marketPanic = false;
        this.log.info(`Market panic cleared — ${bearishCount}/${total} pairs bearish, resuming buys`);
      }
    }
  }

  private async cancelAllBuyOrders(): Promise<void> {
    for (const pair of this.config.pairs.filter(p => p.state !== 'deleted' && !this.state.isPairDeleted(p.symbol))) {
      try {
        const openOrders = await this.exchange.fetchOpenOrders(pair.symbol);
        const buyOrders = openOrders.filter(o => o.side === 'buy');
        const cancelledIds = new Set<string>();
        for (const order of buyOrders) {
          await this.exchange.cancelOrder(order.id, pair.symbol);
          cancelledIds.add(order.id);
        }
        // Clear stale orderId from grid state so levels can be re-placed later
        if (cancelledIds.size > 0) {
          const levels = this.state.getGridLevels(pair.symbol);
          for (const level of levels) {
            if (level.orderId && cancelledIds.has(level.orderId)) {
              level.orderId = undefined;
            }
          }
          this.state.setGridLevels(pair.symbol, levels);
          this.log.info(`Market panic: cancelled ${cancelledIds.size} buy orders for ${pair.symbol}, grid state cleaned`);
        }
      } catch (err) {
        this.log.error(`Market panic: failed to cancel buy orders for ${pair.symbol}: ${sanitizeError(err)}`);
      }
    }
  }

  private async checkBtcWatchdog(): Promise<void> {
    if (!this.config.marketProtection.btcWatchdogEnabled) return;

    const now = Date.now();
    const intervalMs = this.config.marketProtection.btcCheckIntervalSec * 1000;
    if (now - this.lastBtcCheck < intervalMs) return;
    this.lastBtcCheck = now;

    try {
      const candles = await this.exchange.fetchOHLCV('BTC/USDT', '15m', 4);
      if (candles.length < 2) {
        this.log.warn('BTC WATCHDOG: not enough candles to evaluate');
        return;
      }

      const firstOpen = candles[0].open;
      const lastClose = candles[candles.length - 1].close;
      const changePercent = ((lastClose - firstOpen) / firstOpen) * 100;

      if (changePercent <= -this.config.marketProtection.btcDropThresholdPercent) {
        if (!this.btcPaused) {
          this.log.warn(`BTC WATCHDOG: BTC dropped ${changePercent.toFixed(2)}% in 1h — pausing all buys`);
        }
        this.btcPaused = true;
      } else {
        if (this.btcPaused) {
          this.log.info(`BTC WATCHDOG: BTC recovered (${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}% in 1h) — resuming buys`);
        }
        this.btcPaused = false;
      }
    } catch (err) {
      this.log.error(`BTC WATCHDOG: failed to fetch BTC candles: ${sanitizeError(err)}`);
      // Reset to safe state — don't keep stale btcPaused indefinitely on API errors
      if (this.btcPaused) {
        this.btcPaused = false;
        this.log.warn('BTC WATCHDOG: API error — releasing pause to avoid indefinite block');
      }
    }
  }

  /** Returns true if market protection is active and buys should be blocked. */
  private isMarketProtectionActive(): boolean {
    return this.marketPanic || this.btcPaused;
  }

  // ----------------------------------------------------------
  // Sort helper: группа (0=активные, 1=замороженные, 2=deleted), внутри — PnL desc.
  // Используется в BOT SUMMARY, /status, /stats для единообразной сортировки.
  // ----------------------------------------------------------

  private getPairSortGroup(sym: string): number {
    const pair = this.config.pairs.find(p => p.symbol === sym);
    const base = sym.split('/')[0];
    // Deleted — в конце.
    if (pair?.state === 'deleted' || this.state.isPairDeleted(sym)) return 2;
    // Любое "замороженное" состояние (через config.state или runtime).
    if (pair?.state === 'freeze' || pair?.state === 'freezebuy' || pair?.state === 'sellgrid') return 1;
    if (this.state.isBuyBlocked(base) || this.state.isSellGridActive(base)) return 1;
    return 0;
  }

  private comparePairsForDisplay = (a: string, b: string): number => {
    const ga = this.getPairSortGroup(a);
    const gb = this.getPairSortGroup(b);
    if (ga !== gb) return ga - gb;
    return this.state.getPairStats(b).pnl - this.state.getPairStats(a).pnl;
  };

  // ----------------------------------------------------------
  // Summary log
  // ----------------------------------------------------------

  private logSummary(currentCapital: number, freeCapital: number): void {
    const trades = this.state.getRecentTrades();
    const buys = trades.filter((t) => t.side === 'buy');
    const sells = trades.filter((t) => t.side === 'sell');
    const totalSpent = buys.reduce((s, t) => s + t.cost, 0);
    const totalEarned = sells.reduce((s, t) => s + t.cost, 0);
    const totalFees = trades.reduce((s, t) => s + (t.fee || 0), 0);

    // PnL
    const pnl = currentCapital - this.state.startingCapital;
    const pnlPct = this.state.startingCapital > 0 ? (pnl / this.state.startingCapital) * 100 : 0;
    const drawdown = this.state.peakCapital > 0
      ? ((this.state.peakCapital - currentCapital) / this.state.peakCapital) * 100
      : 0;

    this.log.info('=== BOT SUMMARY ===', {
      totalTicks: this.state.totalTicks,
      currentCapital: currentCapital.toFixed(2),
      freeCapital: freeCapital.toFixed(2),
      startingCapital: this.state.startingCapital.toFixed(2),
      peakCapital: this.state.peakCapital.toFixed(2),
      PnL: `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
      drawdown: `${drawdown.toFixed(1)}%`,
      totalTrades: trades.length,
      buys: buys.length,
      sells: sells.length,
      totalSpent: totalSpent.toFixed(2),
      totalEarned: totalEarned.toFixed(2),
      totalFees: totalFees.toFixed(4),
      marketPanic: this.marketPanic ? 'YES — buys blocked' : 'no',
      btcWatchdog: this.btcPaused ? 'PAUSED — BTC drop detected' : 'ok',
    });

    // Per-pair summary line. Сортировка: группа (0=активные, 1=замороженные, 2=deleted), внутри группы — PnL desc.
    const pairLogLines: string[] = [];
    const pairTgLines: string[] = [];
    const sortedPairs = [...this.config.pairs].sort((a, b) =>
      this.comparePairsForDisplay(a.symbol, b.symbol),
    );

    // Pre-pass: собрать raw skip-reason строки для всех пар, чтобы padEnd выровнял колонку
    // ровно по самой длинной строке текущего summary (dynamic alignment).
    const rawNoColBySymbol = new Map<string, string>();
    for (const pair of sortedPairs) {
      const sym = pair.symbol;
      const buySkip  = this.grid.getBuySkipReason(sym);
      const sellSkip = this.grid.getSellSkipReason(sym);
      const parts: string[] = [];
      if (buySkip)  parts.push(`buy:${buySkip}`);
      if (sellSkip) parts.push(`sell:${sellSkip}`);
      rawNoColBySymbol.set(sym, parts.join(' '));
    }
    const noColPadLen = Math.max(0, ...Array.from(rawNoColBySymbol.values()).map(s => s.length));

    for (const pair of sortedPairs) {
      const sym = pair.symbol;
      const pairTrades = trades.filter((t) => t.symbol === sym);
      const isHalted = this.state.isPairHalted(sym);
      const haltReason = this.state.getHaltReason(sym);

      const pairBuys = pairTrades.filter((t) => t.side === 'buy');
      const pairSells = pairTrades.filter((t) => t.side === 'sell');
      const slTrades = pairTrades.filter((t) => t.strategy === 'stop-loss');
      const tpTrades = pairTrades.filter((t) => t.strategy === 'take-profit');
      const tslTrades = pairTrades.filter((t) => t.strategy === 'trailing-stop');

      // Grid levels info
      const gridLevels = this.state.getGridLevels(sym);
      const buyLevels = gridLevels.filter((l) => l.side === 'buy');
      const sellLevels = gridLevels.filter((l) => l.side === 'sell');
      const activeBuys = buyLevels.filter((l) => !l.filled && l.orderId);
      const activeSells = sellLevels.filter((l) => !l.filled && l.orderId);
      const pendingSells = sellLevels.filter((l) => !l.filled && !l.orderId);

      // Single aligned log line (monospace columns)
      const st = this.state.getPairStats(sym);
      const stPnl = st.pnl >= 0 ? `+${st.pnl.toFixed(2)}` : st.pnl.toFixed(2);
      const stPnlPct = st.spent > 0 ? (st.pnl / st.spent) * 100 : 0;
      const stPnlStr = `${stPnl} (${st.pnl >= 0 ? '+' : ''}${stPnlPct.toFixed(1)}%)`;

      const lastInd = this.lastIndicatorsPerPair.get(sym);
      const rsiStr  = lastInd ? lastInd.rsi.toFixed(1).padStart(4)        : '   ?';
      const bbAbbr:  Record<string, string> = { above_upper: 'overbought', above_middle: 'bull', below_middle: 'bear', below_lower: 'oversold' };
      // EMA: show persistent trend state (fast vs slow) — matches the filter in isBuyAllowed.
      // emaCrossover is the one-tick event, not useful for summary; user sees conflicting state otherwise.
      const emaTrend = lastInd
        ? (lastInd.emaFast > lastInd.emaSlow ? 'bull' : lastInd.emaFast < lastInd.emaSlow ? 'bear' : 'flat')
        : '?';
      const emaStr  = emaTrend.padEnd(4);
      const bbStr   = (bbAbbr [lastInd?.pricePosition ?? ''] ?? lastInd?.pricePosition ?? '?').padEnd(10);

      const buyCostVal  = activeBuys.reduce((s, l) => s + l.price * l.amount, 0);
      const sellCostVal = activeSells.reduce((s, l) => s + l.price * l.amount, 0);
      const buyCol  = (activeBuys.length  > 0 ? `${activeBuys.length}B [${buyCostVal.toFixed(0)}$]`   : '0B').padEnd(11);
      const sellCol = (activeSells.length > 0 ? `${activeSells.length}S [${sellCostVal.toFixed(0)}$]` :
                      pendingSells.length > 0  ? `${pendingSells.length}S pend`                        : '0S').padEnd(11);

      // Status / events suffix — always show counters even when zero
      const cooldownUntil = this.state.getCooldownUntil(sym);
      const extras: string[] = [];
      extras.push(`SL ${slTrades.length}x`);
      extras.push(`TSL ${tslTrades.length}x`);
      extras.push(`TP ${tpTrades.length}x`);
      if (isHalted) extras.push(`HALTED:${haltReason ?? '?'}`);
      else if (cooldownUntil > 0 && Date.now() < cooldownUntil)
        extras.push(`COOL:${Math.ceil((cooldownUntil - Date.now()) / 60000)}min`);

      // Grid skip reasons per side — surfaced ONLY in front-of-line noCol, not duplicated in extras
      const buySkip  = this.grid.getBuySkipReason(sym);
      const sellSkip = this.grid.getSellSkipReason(sym);

      // Front-of-line "buy:/sell:" skip-reason column — padding автоматически по длиннейшей строке текущего summary (см. pre-pass выше).
      const noCol = (rawNoColBySymbol.get(sym) ?? '').padEnd(noColPadLen);

      // State column: directly from config.pairs[].state (deleted/freeze/freezebuy/sellgrid/unfreeze)
      const pairCfg = this.config.pairs.find(p => p.symbol === sym);
      const pairStateStr = pairCfg?.state ?? 'unfreeze';
      const stateCol = pairStateStr.padEnd(9);

      const level = (isHalted || cooldownUntil > Date.now()) ? 'warn' : 'info';
      const symPad = sym.padEnd(11);
      const logLine = [
        `  ${symPad}`,
        `PnL ${stPnlStr.padStart(18)}`,
        noCol,
        stateCol,
        `Spent ${st.spent.toFixed(2).padStart(7)}`,
        `Earned ${st.earned.toFixed(2).padStart(7)}`,
        `Fees ${st.totalFees.toFixed(3).padStart(6)}`,
        `RSI ${rsiStr}`,
        `EMA ${emaStr}`,
        `BB ${bbStr}`,
        buyCol,
        sellCol,
        ...extras,
      ].join(' | ');
      this.log[level](logLine);
      pairLogLines.push(logLine.trim());

      // Telegram per-pair
      const tgPairParts: string[] = [];
      const summaryBase = sym.split('/')[0];
      const summaryFrozen = this.state.isBuyBlocked(summaryBase);
      const summarySellgrid = this.state.isSellGridActive(summaryBase);
      // 🦺 N — количество активных counter-sells (защита конкретных покупок break-even'ом).
      // Condition: sellSource='counter' — реальные counter-sells, не ladder и не orphan.
      const raisedToBreakEven = sellLevels.filter(l =>
        !l.filled &&
        l.orderId &&
        l.sellSource === 'counter',
      ).length;
      const vestMarker = raisedToBreakEven > 0 ? ` 🦺${raisedToBreakEven}` : '';
      const summaryMarker = (summarySellgrid ? ' 🔻' : '') + (summaryFrozen ? ' 🧊' : '') + vestMarker;
      tgPairParts.push(`<b>${sym}</b> (${pairBuys.length}B/${pairSells.length}S)${summaryMarker}`);
      if (st.buys > 0 || st.sells > 0) {
        const stPnlSign = st.pnl >= 0 ? '+' : '';
        const stPnlPct = st.spent > 0 ? (st.pnl / st.spent) * 100 : 0;
        tgPairParts.push(` PnL: ${stPnlSign}${st.pnl.toFixed(2)} (${stPnlSign}${stPnlPct.toFixed(1)}%)`);
      }
      if (activeBuys.length > 0) {
        const buyCost = activeBuys.reduce((s, l) => s + l.price * l.amount, 0).toFixed(2);
        tgPairParts.push(` ${activeBuys.length}B [${buyCost}$]`);
      }
      if (activeSells.length > 0 || pendingSells.length > 0) {
        const parts: string[] = [];
        if (activeSells.length > 0) {
          const activeCost = activeSells.reduce((s, l) => s + l.price * l.amount, 0).toFixed(2);
          parts.push(`${activeSells.length}S [${activeCost}$]`);
        }
        if (pendingSells.length > 0) {
          parts.push(`${pendingSells.length}Pend`);
        }
        tgPairParts.push(` ${parts.join(' + ')}`);
      }
      if (slTrades.length > 0) tgPairParts.push(` SL: ${slTrades.length}x`);
      if (tslTrades.length > 0) tgPairParts.push(` TSL: ${tslTrades.length}x`);
      if (tpTrades.length > 0) tgPairParts.push(` TP: ${tpTrades.length}x`);
      if (isHalted) tgPairParts.push(` HALTED — ${haltReason ?? 'unknown'}`);
      else if (cooldownUntil > 0 && Date.now() < cooldownUntil) {
        const minLeft = Math.ceil((cooldownUntil - Date.now()) / 60000);
        tgPairParts.push(` COOLDOWN — ${minLeft} min`);
      }
      // Skip reasons per side (same as log summary — buySkip/sellSkip from grid).
      // В Telegram скрываем чисто-"low USDT"/"low <BASE>" причины (ожидаемая ситуация, не требует внимания).
      // Составные причины (напр. "low AAVE, max orders") — показываем оставшуюся НЕ-low часть.
      const LOW_SKIP_RE = /^low\s+\S+(?:\s+\(pair budget\))?$/;
      const filterLowSkip = (reason: string): string =>
        reason.split(', ').filter(part => !LOW_SKIP_RE.test(part)).join(', ');
      const buySkipTg  = buySkip  ? filterLowSkip(buySkip)  : '';
      const sellSkipTg = sellSkip ? filterLowSkip(sellSkip) : '';
      // 🧊 — buy frozen (пара в sellgrid/freezebuy состоянии, покупки временно выключены).
      // ⛔ — реальные блокировки (BTC watchdog, max orders, budget too small и т.п.).
      const pickSkipIcon = (reason: string) => {
        if (reason.includes('buy frozen')) return '🧊';
        return '⛔';
      };
      if (buySkipTg)  tgPairParts.push(` ${pickSkipIcon(buySkipTg)} buy:${buySkipTg}`);
      if (sellSkipTg) tgPairParts.push(` ${pickSkipIcon(sellSkipTg)} sell:${sellSkipTg}`);
      // Pair state marker (only if non-default, to avoid noise)
      if (pairStateStr !== 'unfreeze') tgPairParts.push(` state: ${pairStateStr}`);
      pairTgLines.push(tgPairParts.join('\n'));
    }

    // Join pairs with blank line separator
    const pairTgBlock = pairTgLines.join('\n\n');

    // Telegram summary
    const sign = pnl >= 0 ? '+' : '';
    const trendIcon = pnl >= 0 ? '⬆️' : '⬇️';
    const panicStr = this.marketPanic ? '⚠️ PANIC' : 'no';
    const btcStr = this.btcPaused ? '⚠️ PAUSED' : 'ok';
    const tgText = [
      `${trendIcon} <b>BOT SUMMARY</b> (tick ${this.state.totalTicks})`,
      '',
      `${currentCapital.toFixed(2)} USDT | free ${freeCapital.toFixed(2)} | PnL ${sign}${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(1)}%) | DD ${drawdown.toFixed(1)}% | peak ${this.state.peakCapital.toFixed(2)} | Trades: ${trades.length} (${buys.length}B/${sells.length}S)`,
      `Panic: ${panicStr} | BTC: ${btcStr}`,
      '',
      pairTgBlock,
    ].join('\n');
    this.tg.sendSummary(this.state.totalTicks, tgText);
  }

  // ----------------------------------------------------------
  // Telegram Commands
  // ----------------------------------------------------------

  private async processTelegramCommands(): Promise<void> {
    const pollInterval = this.config.telegram.commandPollIntervalTicks;
    if (pollInterval <= 0) return;

    this.ticksSinceCommandPoll++;
    if (this.ticksSinceCommandPoll < pollInterval) return;
    this.ticksSinceCommandPoll = 0;

    const commands = await this.tg.pollCommands();
    // Persist update offset to prevent replaying commands on restart
    const newOffset = this.tg.getLastUpdateId();
    if (newOffset !== this.state.telegramUpdateId) {
      this.state.telegramUpdateId = newOffset;
    }
    for (const cmd of commands) {
      this.log.info(`Telegram command: /${cmd.command} ${cmd.args}${cmd.confirmed ? ' [confirmed]' : ''}`);
      try {
        // Commands requiring confirmation: stop, sellall, buy
        const needsConfirm = ['stop', 'sellall', 'buy', 'cancelorders', 'regrid', 'freezebuy', 'unfreezebuy', 'sellgrid', 'unsellgrid', 'freeze', 'unfreeze', 'addtoken', 'removetoken'].includes(cmd.command);

        // /freezebuy: empty args → wizard, unknown currency → reject
        if (cmd.command === 'freezebuy' && !cmd.confirmed) {
          const arg = cmd.args.trim().toUpperCase();
          if (!arg) {
            const currencies = this.collectBuyMenuCurrencies();
            this.tg.sendFreezeMenu(currencies, this.state.getBlockedBuyBases());
            continue;
          }
          if (!this.collectBuyMenuCurrencies().includes(arg)) {
            this.log.warn(`/freezebuy rejected: unknown currency ${arg}`);
            this.tg.sendReply(`❌ Валюта ${arg} не найдена в торгуемых парах. Доступны: ${this.collectBuyMenuCurrencies().join(', ')}`);
            continue;
          }
        }
        // /unfreezebuy: empty args → wizard
        if (cmd.command === 'unfreezebuy' && !cmd.confirmed) {
          const arg = cmd.args.trim().toUpperCase();
          if (!arg) {
            this.tg.sendUnfreezeMenu(this.state.getBlockedBuyBases());
            continue;
          }
          if (!this.state.isBuyBlocked(arg)) {
            this.tg.sendReply(`Валюта ${arg} не заморожена.`);
            continue;
          }
        }
        // /sellgrid: empty args → wizard, unknown → reject
        if (cmd.command === 'sellgrid' && !cmd.confirmed) {
          const arg = cmd.args.trim().toUpperCase();
          if (!arg) {
            this.tg.sendSellGridMenu(this.collectBuyMenuCurrencies(), this.state.getSellGridBases());
            continue;
          }
          if (!this.collectBuyMenuCurrencies().includes(arg)) {
            this.log.warn(`/sellgrid rejected: unknown currency ${arg}`);
            this.tg.sendReply(`❌ Валюта ${arg} не найдена в торгуемых парах.`);
            continue;
          }
        }
        // /unsellgrid: empty args → wizard
        if (cmd.command === 'unsellgrid' && !cmd.confirmed) {
          const arg = cmd.args.trim().toUpperCase();
          if (!arg) {
            this.tg.sendUnsellGridMenu(this.state.getSellGridBases());
            continue;
          }
          if (!this.state.isSellGridActive(arg)) {
            this.tg.sendReply(`Валюта ${arg} не в sellgrid-режиме.`);
            continue;
          }
        }
        // /addtoken: empty args → ask to type token name; with args → show state selection
        if (cmd.command === 'addtoken' && !cmd.confirmed) {
          const arg = cmd.args.trim().toUpperCase().replace('/USDT', '');
          if (!arg) {
            this.tg.sendReply('➕ Напиши: /addtoken SYMBOL\nПример: /addtoken DOT или /addtoken dot\n(USDT добавляется автоматически)');
            continue;
          }
          const symbol = `${arg}/USDT`;
          if (this.config.pairs.find(p => p.symbol === symbol && p.state !== 'deleted')) {
            this.tg.sendReply(`❌ Пара ${symbol} уже существует в конфиге.`);
            continue;
          }
          this.tg.sendAddTokenStateMenu(symbol);
          continue;
        }
        // /removetoken: empty args → show list of active pairs; with args → confirmation
        if (cmd.command === 'removetoken' && !cmd.confirmed) {
          const arg = cmd.args.trim().toUpperCase().replace('/USDT', '');
          if (!arg) {
            const activePairs = this.config.pairs.filter(p => p.state !== 'deleted').map(p => p.symbol.split('/')[0]);
            this.tg.sendReply(`🗑 Укажи токен для удаления:\n/removetoken SYMBOL\n\nАктивные пары: ${activePairs.join(', ')}`);
            continue;
          }
          const symbol = `${arg}/USDT`;
          if (!this.config.pairs.find(p => p.symbol === symbol)) {
            this.tg.sendReply(`❌ Пара ${symbol} не найдена.`);
            continue;
          }
        }
        // Pre-validate /buy args before showing confirmation dialog; empty args → show wizard
        if (cmd.command === 'buy' && !cmd.confirmed) {
          const parts = cmd.args.trim().split(/\s+/).filter(Boolean);
          if (parts.length === 0) {
            const currencies = this.collectBuyMenuCurrencies();
            this.tg.sendBuyMenu(currencies);
            continue;
          }
          if (parts.length < 2 || parts.length > 3) {
            this.tg.sendReply('Формат: /buy SUI 10 или /buy SUI BTC 10\nПервое — base (что купить), опционально quote (за что), последнее — количество. Quote по умолчанию USDT.');
            continue;
          }
          const lastArg = parts[parts.length - 1];
          const amt = parseFloat(lastArg);
          if (isNaN(amt) || amt <= 0) {
            this.tg.sendReply(`Некорректное количество: ${lastArg}`);
            continue;
          }
        }
        if (needsConfirm && !cmd.confirmed) {
          const descriptions: Record<string, string> = {
            stop: '⏸ Остановить торговлю?',
            sellall: '❌ Продать ВСЁ и отменить все ордера?',
            buy: (() => {
              // Extract base from first arg; handles both "SUI 10", "SUI BTC 10", and legacy "SUI/BTC 10"
              const firstArg = cmd.args.trim().split(/\s+/)[0] ?? '';
              const buyBase = firstArg.split('/')[0].toUpperCase();
              const warn = buyBase && this.state.isBuyBlocked(buyBase) ? `🧊 <b>${buyBase} заморожена</b> — покупка пройдёт как ручной ордер, бот НЕ будет автоматически её продавать.\n` : '';
              return `${warn}🛒 Купить: ${cmd.args}?`;
            })(),
            cancelorders: '⚠️ Отменить ВСЕ открытые ордера?',
            regrid: '🔄 Перестроить торговые сетки ордеров?',
            freezebuy: `🧊 Заморозить покупки по ${cmd.args.toUpperCase()}? Будут отменены все buy-ордера; sell продолжат работать.`,
            unfreezebuy: `✅ Разморозить покупки по ${cmd.args.toUpperCase()}? Сетки восстановятся в следующем тике.`,
            sellgrid: `🔻 Включить sellgrid для ${cmd.args.toUpperCase()}? Buy заморозятся, после каждого sell fill ставится новый sell выше (ladder). Завершится автоматически, когда крипта закончится.`,
            unsellgrid: `✅ Отключить sellgrid для ${cmd.args.toUpperCase()} и разморозить buy?`,
            removetoken: `🗑 Удалить пару ${cmd.args.trim().toUpperCase().replace('/USDT','')}/USDT? Все ордера будут отменены. Торговля остановлена навсегда (state=deleted).`,
          };
          const label = descriptions[cmd.command] ?? `/${cmd.command}`;
          const callbackData = cmd.args ? `${cmd.command}:${cmd.args}` : cmd.command;
          this.tg.sendConfirmation(label, callbackData);
          continue;
        }

        switch (cmd.command) {
          case 'start':
            this.cmdStartWelcome();
            break;
          case 'status':
            await this.cmdStatus();
            break;
          case 'stop':
            await this.cmdStop();
            break;
          case 'run':
            await this.cmdStart();
            break;
          case 'sellall':
            await this.cmdSellAll();
            break;
          case 'buy':
            await this.cmdBuy(cmd.args);
            break;
          case 'orders':
            await this.cmdOrders();
            break;
          case 'cancelorders':
            await this.cmdCancelOrders();
            break;
          case 'stats':
            await this.cmdStats();
            break;
          case 'regrid':
            await this.cmdResetGrid();
            break;
          case '_buymenu':
            // User picked a currency from the wizard — show preset-amount buttons
            this.tg.sendBuyAmountMenu(cmd.args.toUpperCase(), [5, 10, 15, 20, 50]);
            break;
          case '_buysum': {
            // args format: "SUI:10" — convert USDT amount to base amount via ticker
            const [curRaw, usdStr] = cmd.args.split(':');
            const currency = (curRaw ?? '').toUpperCase();
            const usd = parseFloat(usdStr ?? '');
            if (!currency || isNaN(usd) || usd <= 0) {
              this.tg.sendReply(`Некорректный выбор: ${cmd.args}`);
              break;
            }
            const symbol = `${currency}/USDT`;
            let ticker;
            try {
              ticker = await this.exchange.fetchTicker(symbol);
            } catch {
              this.tg.sendReply(`Не удалось получить цену ${symbol}`);
              break;
            }
            const mp = await this.exchange.getMarketPrecision(symbol).catch(() => null);
            if (!mp) {
              this.tg.sendReply(`Пара ${symbol} не найдена на бирже`);
              break;
            }
            if (!ticker.last || ticker.last <= 0) {
              this.tg.sendReply(`Некорректная цена ${symbol}: ${ticker.last}`);
              break;
            }
            const rawAmount = usd / ticker.last;
            const factor = Math.pow(10, mp.amountPrecision);
            const amountStr = (Math.floor(rawAmount * factor) / factor).toFixed(mp.amountPrecision);
            const amount = parseFloat(amountStr);
            if (amount < mp.minAmount) {
              this.tg.sendReply(`$${usd} → ${amountStr} ${currency} < minAmount ${mp.minAmount}. Увеличь сумму.`);
              break;
            }
            const frozenWarn = this.state.isBuyBlocked(currency) ? `🧊 <b>${currency} заморожена</b> — это ручная покупка, бот НЕ будет автоматически её продавать.\n` : '';
            this.tg.sendConfirmation(`${frozenWarn}🛒 Купить ${amountStr} ${currency} (~$${usd} @ ${ticker.last.toFixed(4)})?`, `buy:${currency} ${amountStr}`);
            break;
          }
          case '_buycustom':
            this.tg.sendReply('✏️ Напиши: /buy валюта количество\nПример: /buy SUI 10');
            break;
          case '_buyother':
            this.tg.sendReply('🔤 Напиши тикер и количество:\n/buy TICKER количество\nПример: /buy LINK 0.5');
            break;
          case 'freezebuy':
            await this.cmdFreezeBuy(cmd.args.trim().toUpperCase());
            break;
          case 'unfreezebuy':
            await this.cmdUnfreezeBuy(cmd.args.trim().toUpperCase());
            break;
          case '_freezemenu': {
            const base = cmd.args.toUpperCase();
            if (this.state.isBuyBlocked(base)) {
              this.tg.sendReply(`${base} уже заморожен. Используй /unfreezebuy ${base}.`);
            } else {
              this.tg.sendConfirmation(`🧊 Заморозить покупки по ${base}? Будут отменены все buy-ордера; sell продолжат работать.`, `freezebuy:${base}`);
            }
            break;
          }
          case '_unfreezemenu': {
            const base = cmd.args.toUpperCase();
            this.tg.sendConfirmation(`✅ Разморозить покупки по ${base}? Сетки восстановятся в следующем тике.`, `unfreezebuy:${base}`);
            break;
          }
          case 'sellgrid':
            await this.cmdSellGrid(cmd.args.trim().toUpperCase());
            break;
          case 'unsellgrid':
            await this.cmdUnsellGrid(cmd.args.trim().toUpperCase());
            break;
          case '_sellgridmenu': {
            const base = cmd.args.toUpperCase();
            if (this.state.isSellGridActive(base)) {
              this.tg.sendReply(`${base} уже в sellgrid-режиме. Используй /unsellgrid ${base}.`);
            } else {
              this.tg.sendConfirmation(`🔻 Включить sellgrid для ${base}? Buy заморозятся, после каждого sell fill ставится новый sell выше (ladder). Завершится автоматически, когда крипта закончится.`, `sellgrid:${base}`);
            }
            break;
          }
          case '_unsellgridmenu': {
            const base = cmd.args.toUpperCase();
            this.tg.sendConfirmation(`✅ Отключить sellgrid для ${base} и разморозить buy?`, `unsellgrid:${base}`);
            break;
          }
          case 'freeze':
            await this.cmdFreeze(cmd.args.trim().toUpperCase());
            break;
          case 'unfreeze':
            await this.cmdUnfreeze(cmd.args.trim().toUpperCase());
            break;
          case '_addtokenstate': {
            // args = "DOT/USDT:unfreeze" or "DOT/USDT:freeze"
            const lastColon = cmd.args.lastIndexOf(':');
            const atSymbol = lastColon > 0 ? cmd.args.substring(0, lastColon) : cmd.args;
            const atState  = lastColon > 0 ? cmd.args.substring(lastColon + 1) : 'unfreeze';
            const stateLabel = atState === 'freeze' ? '🧊 Заморожен (freeze)' : '▶️ Начать торговать (unfreeze)';
            this.tg.sendConfirmation(`➕ Добавить ${atSymbol}?\nСостояние: ${stateLabel}`, `addtoken:${atSymbol}:${atState}`);
            break;
          }
          case 'addtoken':
            await this.cmdAddToken(cmd.args.trim());
            break;
          case 'removetoken':
            await this.cmdRemoveToken(cmd.args.trim().toUpperCase().replace('/USDT', ''));
            break;
          default:
            this.tg.sendReply(`Неизвестная команда /${cmd.command}\nДоступные: /start /status /stop /run /sellall /buy /orders /cancelorders /stats /regrid /freezebuy /unfreezebuy /sellgrid /unsellgrid /freeze /unfreeze /addtoken /removetoken`);
        }
      } catch (err) {
        this.log.error(`Telegram command /${cmd.command} failed: ${sanitizeError(err)}`);
        this.tg.sendReply(`Ошибка /${cmd.command}: ${sanitizeError(err)}`);
      }
    }
  }

  /** Build currency list for /buy wizard: base tickers from config pairs + manual pairs, deduped. */
  private async cmdFreezeBuy(base: string): Promise<void> {
    if (!base) { this.tg.sendReply('Формат: /freezebuy XRP'); return; }
    const available = this.collectBuyMenuCurrencies();
    if (!available.includes(base)) {
      this.log.warn(`/freezebuy rejected: unknown currency ${base}`);
      this.tg.sendReply(`❌ Валюта ${base} не найдена в торгуемых парах. Доступны: ${available.join(', ')}`);
      return;
    }
    const added = this.state.addBlockedBuyBase(base);
    if (!added) {
      this.tg.sendReply(`${base} уже заморожен.`);
      return;
    }
    // Cancel all buy-orders for every pair with this base
    const affectedSymbols = this.config.pairs
      .map(p => p.symbol)
      .concat(this.state.getManualPairs())
      .filter((s, i, arr) => arr.indexOf(s) === i) // dedup
      .filter(sym => sym.split('/')[0] === base);

    let cancelled = 0;
    let failed = 0;
    for (const sym of affectedSymbols) {
      try {
        const openOrders = await this.exchange.fetchOpenOrders(sym);
        const buyOrders = openOrders.filter(o => o.side === 'buy');
        for (const o of buyOrders) {
          try {
            await this.exchange.cancelOrder(o.id, sym);
            cancelled++;
          } catch (err) {
            failed++;
            this.log.warn(`/freezebuy: cancelOrder ${o.id} ${sym} failed: ${sanitizeError(err)}`);
          }
        }
        // Clear orderId/placedAt on buy levels so they don't appear as active (mutate in place; setGridLevels persists)
        const levels = this.state.getGridLevels(sym);
        let mutated = false;
        for (const l of levels) {
          if (l.side === 'buy' && l.orderId) {
            l.orderId = undefined;
            l.placedAt = undefined;
            mutated = true;
          }
        }
        if (mutated) this.state.setGridLevels(sym, levels);
      } catch (err) {
        this.log.error(`/freezebuy: fetchOpenOrders ${sym} failed: ${sanitizeError(err)}`);
      }
    }
    // Post-cancel verification: any buy still open? If so, retry once and report remaining.
    let stillOpen = 0;
    for (const sym of affectedSymbols) {
      try {
        const remaining = (await this.exchange.fetchOpenOrders(sym)).filter(o => o.side === 'buy');
        for (const o of remaining) {
          try {
            await this.exchange.cancelOrder(o.id, sym);
            cancelled++;
          } catch {
            stillOpen++;
            this.log.error(`/freezebuy: ${sym} buy-order ${o.id} could not be cancelled after retry`);
          }
        }
      } catch (err) {
        this.log.warn(`/freezebuy: post-check fetchOpenOrders ${sym} failed: ${sanitizeError(err)}`);
      }
    }
    this.log.info(`/freezebuy ${base}: blocked, cancelled ${cancelled} buy-orders across ${affectedSymbols.length} pair(s), failed=${failed}, stillOpen=${stillOpen}`);
    let reply = `🧊 ${base} заморожен. Отменено ${cancelled} buy-ордер(ов). Sell-ордера продолжают работать.`;
    if (stillOpen > 0) {
      reply += `\n⚠️ Не удалось отменить ${stillOpen} ордер(ов). Повтори /freezebuy ${base} или отмени вручную через /cancelorders.`;
    }
    this.tg.sendReply(reply);
    const cfgPathFb = resolve(__dirname, '../../config.jsonc');
    const sym = this.config.pairs.find(p => p.symbol.split('/')[0] === base)?.symbol ?? `${base}/USDT`;
    try { updatePairStateInConfig(cfgPathFb, sym, 'freezebuy'); } catch (e) { this.log.warn(`config-writer freezebuy: ${sanitizeError(e)}`); }
    this.lastConfigHash = createHash('md5').update(readFileSync(cfgPathFb, 'utf-8')).digest('hex');
  }

  private async cmdSellGrid(base: string): Promise<void> {
    if (!base) { this.tg.sendReply('Формат: /sellgrid XRP'); return; }
    const available = this.collectBuyMenuCurrencies();
    if (!available.includes(base)) {
      this.log.warn(`/sellgrid rejected: unknown currency ${base}`);
      this.tg.sendReply(`❌ Валюта ${base} не найдена в торгуемых парах.`);
      return;
    }
    // Enable sellgrid + implicit freeze (Q-A=б: /unsellgrid will remove both)
    const addedSellgrid = this.state.addSellGridBase(base);
    const addedFreeze = this.state.addBlockedBuyBase(base);
    if (!addedSellgrid) {
      this.tg.sendReply(`${base} уже в sellgrid-режиме.`);
      return;
    }
    // Cancel existing buy-orders (since buy is now frozen)
    const affectedSymbols = this.config.pairs
      .map(p => p.symbol)
      .concat(this.state.getManualPairs())
      .filter((s, i, arr) => arr.indexOf(s) === i)
      .filter(sym => sym.split('/')[0] === base);
    let cancelled = 0;
    for (const sym of affectedSymbols) {
      try {
        const openOrders = await this.exchange.fetchOpenOrders(sym);
        const buyOrders = openOrders.filter(o => o.side === 'buy');
        for (const o of buyOrders) {
          try { await this.exchange.cancelOrder(o.id, sym); cancelled++; }
          catch (err) { this.log.warn(`/sellgrid: cancel ${o.id} failed: ${sanitizeError(err)}`); }
        }
        const levels = this.state.getGridLevels(sym);
        let mutated = false;
        for (const l of levels) {
          if (l.side === 'buy' && l.orderId) {
            l.orderId = undefined;
            l.placedAt = undefined;
            mutated = true;
          }
        }
        if (mutated) this.state.setGridLevels(sym, levels);
      } catch (err) {
        this.log.warn(`/sellgrid: fetchOpenOrders ${sym} failed: ${sanitizeError(err)}`);
      }
    }
    this.log.info(`/sellgrid ${base}: enabled (freeze=${addedFreeze ? 'new' : 'existed'}), cancelled ${cancelled} buy-orders. Ladder-mode active.`);
    this.tg.sendReply(`🔻 ${base} в sellgrid-режиме. Buy заморожены (${cancelled} ордер(ов) отменено). После каждого sell fill — новый sell выше. Завершится автоматически при исчерпании крипты.`);
    const cfgPathSg = resolve(__dirname, '../../config.jsonc');
    const symSg = this.config.pairs.find(p => p.symbol.split('/')[0] === base)?.symbol ?? `${base}/USDT`;
    try { updatePairStateInConfig(cfgPathSg, symSg, 'sellgrid'); } catch (e) { this.log.warn(`config-writer sellgrid: ${sanitizeError(e)}`); }
    this.lastConfigHash = createHash('md5').update(readFileSync(cfgPathSg, 'utf-8')).digest('hex');
  }

  private async cmdUnsellGrid(base: string): Promise<void> {
    if (!base) { this.tg.sendReply('Формат: /unsellgrid XRP'); return; }
    const removedSellgrid = this.state.removeSellGridBase(base);
    if (!removedSellgrid) {
      this.tg.sendReply(`${base} не в sellgrid-режиме.`);
      return;
    }
    const removedFreeze = this.state.removeBlockedBuyBase(base); // Q-A=б: также разморозить buy
    // Force rebalance on affected pairs so buy-levels get refreshed
    const affectedSymbols = this.config.pairs
      .map(p => p.symbol)
      .concat(this.state.getManualPairs())
      .filter((s, i, arr) => arr.indexOf(s) === i)
      .filter(sym => sym.split('/')[0] === base);
    let forced = 0;
    for (const sym of affectedSymbols) {
      if (this.state.isGridInitialized(sym)) {
        this.state.setGridCenterPrice(sym, 0);
        forced++;
      }
    }
    this.log.info(`/unsellgrid ${base}: sellgrid disabled, freeze also removed (${removedFreeze}), force-rebalance for ${forced} pair(s)`);
    this.tg.sendReply(`✅ ${base}: sellgrid отключён, buy разморожен. Сетки восстановятся в ближайшем тике.`);
    const cfgPathUsg = resolve(__dirname, '../../config.jsonc');
    const symUsg = this.config.pairs.find(p => p.symbol.split('/')[0] === base)?.symbol ?? `${base}/USDT`;
    try { updatePairStateInConfig(cfgPathUsg, symUsg, 'unfreeze'); } catch (e) { this.log.warn(`config-writer unsellgrid: ${sanitizeError(e)}`); }
    this.lastConfigHash = createHash('md5').update(readFileSync(cfgPathUsg, 'utf-8')).digest('hex');
  }

  private async cmdUnfreezeBuy(base: string): Promise<void> {
    if (!base) { this.tg.sendReply('Формат: /unfreezebuy XRP'); return; }
    const removed = this.state.removeBlockedBuyBase(base);
    if (!removed) {
      this.tg.sendReply(`${base} не был заморожен.`);
      return;
    }
    // Force rebalance for affected pairs — center=0 triggers fresh grid build on next tick.
    // This ensures buy-levels are computed from current price, not stale values from before freeze.
    const affectedSymbols = this.config.pairs
      .map(p => p.symbol)
      .concat(this.state.getManualPairs())
      .filter((s, i, arr) => arr.indexOf(s) === i)
      .filter(sym => sym.split('/')[0] === base);
    let forced = 0;
    for (const sym of affectedSymbols) {
      if (this.state.isGridInitialized(sym)) {
        this.state.setGridCenterPrice(sym, 0);
        forced++;
      }
    }
    this.log.info(`/unfreezebuy ${base}: unblocked, force-rebalance scheduled for ${forced} pair(s) on next tick`);
    this.tg.sendReply(`✅ ${base} разморожен. Force-rebalance сетки — buy-ордера будут выставлены по актуальной цене в ближайшем тике.`);
    const cfgPathUfb = resolve(__dirname, '../../config.jsonc');
    const symUfb = this.config.pairs.find(p => p.symbol.split('/')[0] === base)?.symbol ?? `${base}/USDT`;
    try { updatePairStateInConfig(cfgPathUfb, symUfb, 'unfreeze'); } catch (e) { this.log.warn(`config-writer unfreezebuy: ${sanitizeError(e)}`); }
    this.lastConfigHash = createHash('md5').update(readFileSync(cfgPathUfb, 'utf-8')).digest('hex');
  }

  // Применить состояние пары: freeze/freezebuy/sellgrid/unfreeze.
  // writeConfig=false при вызове из hot-reload (конфиг уже обновлён), true при вызове из Telegram.
  private async applyPairState(base: string, newState: string, writeConfig: boolean): Promise<void> {
    const configPath = resolve(__dirname, '../../config.jsonc');
    const mainPair = this.config.pairs.find(p => p.symbol.split('/')[0] === base);
    const mainSymbol = mainPair?.symbol ?? `${base}/USDT`;

    // Все символы с данной базой (включая manual pairs) — как в cmdFreezeBuy
    const affectedSymbols = this.config.pairs
      .map(p => p.symbol)
      .concat(this.state.getManualPairs())
      .filter((s, i, arr) => arr.indexOf(s) === i)
      .filter(sym => sym.split('/')[0] === base);

    if (newState === 'deleted') {
      // Пара удалена: сначала отменить все ордера, затем пометить в state
      this.state.removeBlockedBuyBase(base);
      this.state.removeSellGridBase(base);
      this.state.removeFrozenPair(base);
      let cancelled = 0;
      for (const sym of affectedSymbols) {
        try {
          const openOrders = await this.exchange.fetchOpenOrders(sym);
          for (const o of openOrders) {
            try { await this.exchange.cancelOrder(o.id, sym); cancelled++; }
            catch (err) { this.log.warn(`deleted: cancel ${o.id} ${sym} failed: ${sanitizeError(err)}`); }
          }
          this.state.setGridLevels(sym, []);
          this.state.setGridInitialized(sym, false);
        } catch (err) {
          this.log.warn(`deleted: fetchOpenOrders ${sym} failed: ${sanitizeError(err)}`);
        }
      }
      // Помечаем deleted только после отмены ордеров
      this.state.markPairDeleted(mainSymbol);
      this.log.info(`Pair ${mainSymbol} marked deleted: cancelled ${cancelled} orders, grid cleared`);
      this.tg.sendAlert(`🗑 <b>${mainSymbol}</b> удалена из торговли. Отменено ордеров: ${cancelled}. Пара скрыта из статистики.`);

      // При auto-режиме пересчитать аллокации оставшихся активных пар + обнулить удалённую
      if (this.config.allocationPercentMode === 'auto') {
        try {
          const configPath = resolve(__dirname, '../../config.jsonc');
          const remaining = this.config.pairs.filter(p => p.state !== 'deleted' && !this.state.isPairDeleted(p.symbol));
          const equalAlloc = remaining.length > 0 ? Math.floor(100 / remaining.length) : 0;
          rewritePairAllocations(configPath, [
            { symbol: mainSymbol, allocationPercent: 0 },
            ...remaining.map(p => ({ symbol: p.symbol, allocationPercent: equalAlloc })),
          ]);
          this.lastConfigHash = createHash('md5').update(readFileSync(configPath, 'utf-8')).digest('hex');
        } catch (err) {
          this.log.warn(`applyPairState deleted: rewritePairAllocations failed: ${sanitizeError(err)}`);
        }
      }
      return;
    } else if (newState === 'freeze') {
      // Снять все ордера (buy + sell) по всем affected символам, выставить frozen
      this.state.addFrozenPair(base);
      this.state.addBlockedBuyBase(base);
      let cancelled = 0;
      for (const sym of affectedSymbols) {
        try {
          const openOrders = await this.exchange.fetchOpenOrders(sym);
          for (const o of openOrders) {
            try { await this.exchange.cancelOrder(o.id, sym); cancelled++; }
            catch (err) { this.log.warn(`/freeze: cancel ${o.id} ${sym} failed: ${sanitizeError(err)}`); }
          }
          const levels = this.state.getGridLevels(sym);
          let mutated = false;
          for (const l of levels) {
            if (l.orderId) { l.orderId = undefined; l.placedAt = undefined; mutated = true; }
          }
          if (mutated) this.state.setGridLevels(sym, levels);
        } catch (err) {
          this.log.warn(`/freeze: fetchOpenOrders ${sym} failed: ${sanitizeError(err)}`);
        }
      }
      this.log.info(`/freeze ${base}: full freeze applied, cancelled ${cancelled} orders across ${affectedSymbols.length} pair(s)`);
      if (writeConfig) {
        try { updatePairStateInConfig(configPath, mainSymbol, 'freeze'); } catch (e) { this.log.warn(`config-writer freeze: ${sanitizeError(e)}`); }
        this.lastConfigHash = createHash('md5').update(readFileSync(configPath, 'utf-8')).digest('hex');
        this.tg.sendReply(`🔒 ${base} полностью заморожен. Все ордера отменены (${cancelled}). Только SL/TP работают.`);
      }
    } else if (newState === 'freezebuy') {
      this.state.removeFrozenPair(base);
      this.state.removeSellGridBase(base);
      await this.cmdFreezeBuyInternal(base);
      if (writeConfig) {
        try { updatePairStateInConfig(configPath, mainSymbol, 'freezebuy'); } catch (e) { this.log.warn(`config-writer freezebuy: ${sanitizeError(e)}`); }
        this.lastConfigHash = createHash('md5').update(readFileSync(configPath, 'utf-8')).digest('hex');
      }
    } else if (newState === 'sellgrid') {
      this.state.removeFrozenPair(base);
      await this.cmdSellGridInternal(base);
      if (writeConfig) {
        try { updatePairStateInConfig(configPath, mainSymbol, 'sellgrid'); } catch (e) { this.log.warn(`config-writer sellgrid: ${sanitizeError(e)}`); }
        this.lastConfigHash = createHash('md5').update(readFileSync(configPath, 'utf-8')).digest('hex');
      }
    } else {
      // unfreeze: снять всё, force-rebalance для всех affected символов
      this.state.removeFrozenPair(base);
      this.state.removeBlockedBuyBase(base);
      this.state.removeSellGridBase(base);
      let forced = 0;
      for (const sym of affectedSymbols) {
        if (this.state.isGridInitialized(sym)) {
          this.state.setGridCenterPrice(sym, 0);
          forced++;
        }
      }
      this.log.info(`/unfreeze ${base}: all freezes removed, force-rebalance for ${forced} pair(s)`);
      if (writeConfig) {
        try { updatePairStateInConfig(configPath, mainSymbol, 'unfreeze'); } catch (e) { this.log.warn(`config-writer unfreeze: ${sanitizeError(e)}`); }
        this.lastConfigHash = createHash('md5').update(readFileSync(configPath, 'utf-8')).digest('hex');
        this.tg.sendReply(`✅ ${base} разморожен полностью. Сетка пересоберётся в ближайшем тике.`);
      }
    }
  }

  private async cmdFreeze(base: string): Promise<void> {
    if (!base) { this.tg.sendReply('Формат: /freeze XRP'); return; }
    const available = this.collectBuyMenuCurrencies();
    if (!available.includes(base)) {
      this.tg.sendReply(`❌ Валюта ${base} не найдена в торгуемых парах.`);
      return;
    }
    await this.applyPairState(base, 'freeze', true);
  }

  private async cmdUnfreeze(base: string): Promise<void> {
    if (!base) { this.tg.sendReply('Формат: /unfreeze XRP'); return; }
    const available = this.collectBuyMenuCurrencies();
    if (!available.includes(base)) {
      this.tg.sendReply(`❌ Валюта ${base} не найдена в торгуемых парах.`);
      return;
    }
    await this.applyPairState(base, 'unfreeze', true);
  }

  // Внутренняя версия cmdFreezeBuy без Telegram-вывода (используется из applyPairState)
  private async cmdFreezeBuyInternal(base: string): Promise<void> {
    this.state.addBlockedBuyBase(base);
    const affectedSymbols = this.config.pairs
      .map(p => p.symbol)
      .concat(this.state.getManualPairs())
      .filter((s, i, arr) => arr.indexOf(s) === i)
      .filter(sym => sym.split('/')[0] === base);
    for (const sym of affectedSymbols) {
      try {
        const openOrders = await this.exchange.fetchOpenOrders(sym);
        const buyOrders = openOrders.filter(o => o.side === 'buy');
        for (const o of buyOrders) {
          try { await this.exchange.cancelOrder(o.id, sym); }
          catch (err) { this.log.warn(`freezebuy: cancel ${o.id} failed: ${sanitizeError(err)}`); }
        }
        const levels = this.state.getGridLevels(sym);
        let mutated = false;
        for (const l of levels) {
          if (l.side === 'buy' && l.orderId) { l.orderId = undefined; l.placedAt = undefined; mutated = true; }
        }
        if (mutated) this.state.setGridLevels(sym, levels);
      } catch (err) {
        this.log.warn(`freezebuy: fetchOpenOrders ${sym} failed: ${sanitizeError(err)}`);
      }
    }
  }

  // Внутренняя версия cmdSellGrid без Telegram-вывода (используется из applyPairState)
  private async cmdSellGridInternal(base: string): Promise<void> {
    this.state.addSellGridBase(base);
    this.state.addBlockedBuyBase(base);
    const affectedSymbols = this.config.pairs
      .map(p => p.symbol)
      .concat(this.state.getManualPairs())
      .filter((s, i, arr) => arr.indexOf(s) === i)
      .filter(sym => sym.split('/')[0] === base);
    for (const sym of affectedSymbols) {
      try {
        const openOrders = await this.exchange.fetchOpenOrders(sym);
        const buyOrders = openOrders.filter(o => o.side === 'buy');
        for (const o of buyOrders) {
          try { await this.exchange.cancelOrder(o.id, sym); }
          catch (err) { this.log.warn(`sellgrid: cancel ${o.id} failed: ${sanitizeError(err)}`); }
        }
        const levels = this.state.getGridLevels(sym);
        let mutated = false;
        for (const l of levels) {
          if (l.side === 'buy' && l.orderId) { l.orderId = undefined; l.placedAt = undefined; mutated = true; }
        }
        if (mutated) this.state.setGridLevels(sym, levels);
      } catch (err) {
        this.log.warn(`sellgrid: fetchOpenOrders ${sym} failed: ${sanitizeError(err)}`);
      }
    }
  }

  private async cmdAddToken(args: string): Promise<void> {
    // args = "DOT/USDT:unfreeze" or "DOT/USDT:freeze" (from _addtokenstate confirmation)
    const lastColon = args.lastIndexOf(':');
    const symbol  = lastColon > 0 ? args.substring(0, lastColon) : args;
    const newState = lastColon > 0 ? args.substring(lastColon + 1) : 'unfreeze';

    if (!symbol.includes('/')) {
      this.tg.sendReply(`❌ Некорректный символ: ${args}`);
      return;
    }

    const configPath = resolve(__dirname, '../../config.jsonc');
    const activePairs = this.config.pairs.filter(p => p.state !== 'deleted');

    // Рассчитать allocationPercent
    // auto: равномерно; config: минимально возможный (остаток от текущей суммы)
    const currentTotal = activePairs.reduce((s, p) => s + p.allocationPercent, 0);
    let allocationPercent: number;
    if (this.config.allocationPercentMode === 'auto') {
      allocationPercent = Math.floor(100 / (activePairs.length + 1));
    } else {
      allocationPercent = Math.max(1, 100 - currentTotal);
    }

    // Проверить что суммарный alloc не превысит 100
    if (currentTotal + allocationPercent > 100) {
      this.tg.sendReply(`⚠️ Невозможно добавить ${symbol}: суммарная аллокация превысит 100% (текущая ${currentTotal}%, новая ${allocationPercent}%).\nСначала уменьши аллокацию других пар или удали лишние.`);
      return;
    }

    try {
      addPairToConfig(configPath, symbol, allocationPercent, newState === 'freeze' ? 'freeze' : undefined);

      // При auto-режиме пересчитать все аллокации равномерно
      if (this.config.allocationPercentMode === 'auto') {
        const newTotal = activePairs.length + 1;
        const equalAlloc = Math.floor(100 / newTotal);
        const newAllocPairs = [...activePairs.map(p => ({ symbol: p.symbol, allocationPercent: equalAlloc })),
          { symbol, allocationPercent: equalAlloc }];
        rewritePairAllocations(configPath, newAllocPairs);
      }

      this.lastConfigHash = createHash('md5').update(readFileSync(configPath, 'utf-8')).digest('hex');
    } catch (err) {
      this.tg.sendReply(`❌ Ошибка записи в config.jsonc: ${sanitizeError(err)}`);
      return;
    }

    const stateLabel = newState === 'freeze' ? '🧊 заморожена' : '▶️ активна';
    this.log.info(`/addtoken: ${symbol} добавлена в config.jsonc (alloc=${allocationPercent}%, state=${newState})`);
    this.tg.sendReply(
      `✅ <b>${symbol}</b> добавлена в конфиг.\n` +
      `Аллокация: ${allocationPercent}% | Состояние: ${stateLabel}\n` +
      `Бот подхватит изменения через ~30с (hot-reload).`,
    );
  }

  private async cmdRemoveToken(base: string): Promise<void> {
    if (!base) { this.tg.sendReply('Формат: /removetoken XRP'); return; }

    const symbol = `${base}/USDT`;
    const pair = this.config.pairs.find(p => p.symbol === symbol);
    if (!pair) {
      this.tg.sendReply(`❌ Пара ${symbol} не найдена.`);
      return;
    }
    if (pair.state === 'deleted') {
      this.tg.sendReply(`${symbol} уже помечена как deleted.`);
      return;
    }

    // Отменить все ордера
    let cancelled = 0;
    try {
      const openOrders = await this.exchange.fetchOpenOrders(symbol);
      for (const o of openOrders) {
        try { await this.exchange.cancelOrder(o.id, symbol); cancelled++; }
        catch (err) { this.log.warn(`/removetoken: cancel ${o.id} failed: ${sanitizeError(err)}`); }
      }
    } catch (err) {
      this.log.warn(`/removetoken: fetchOpenOrders ${symbol} failed: ${sanitizeError(err)}`);
    }

    // Очистить grid levels в state
    this.state.setGridLevels(symbol, []);
    this.state.setGridInitialized(symbol, false);

    // Пометить в state как deleted
    this.state.markPairDeleted(symbol);

    // Снять все freezes/sellgrid
    this.state.removeBlockedBuyBase(base);
    this.state.removeSellGridBase(base);
    this.state.removeFrozenPair(base);

    // Записать state=deleted в config.jsonc
    const configPath = resolve(__dirname, '../../config.jsonc');
    try {
      markPairDeletedInConfig(configPath, symbol);

      // При auto-режиме пересчитать аллокации оставшихся активных пар + обнулить удалённую
      if (this.config.allocationPercentMode === 'auto') {
        const remaining = this.config.pairs.filter(p => p.symbol !== symbol && p.state !== 'deleted' && !this.state.isPairDeleted(p.symbol));
        const equalAlloc = remaining.length > 0 ? Math.floor(100 / remaining.length) : 0;
        rewritePairAllocations(configPath, [
          { symbol, allocationPercent: 0 },
          ...remaining.map(p => ({ symbol: p.symbol, allocationPercent: equalAlloc })),
        ]);
      }

      this.lastConfigHash = createHash('md5').update(readFileSync(configPath, 'utf-8')).digest('hex');
    } catch (err) {
      this.log.warn(`/removetoken: config-writer error: ${sanitizeError(err)}`);
    }

    const msg = `🗑 ${symbol} удалена. Отменено ордеров: ${cancelled}. Торговля остановлена, пара скрыта из статистики.`;
    this.log.info(`/removetoken: ${symbol} marked deleted, cancelled=${cancelled}`);
    this.tg.sendReply(msg);
  }

  private cmdStartWelcome(): void {
    const text = [
      '🤖 <b>Bybit Combo Bot</b>',
      '',
      'Спот-трейдинг на Bybit: Grid + Meta-signals с защитой позиций',
      '',
      '<b>📊 Мониторинг:</b>',
      '/status — капитал, PnL, позиции',
      '/stats — статистика по парам',
      '/orders — открытые ордера',
      '',
      '<b>🛒 Торговля:</b>',
      '/regrid — пересобрать торговые сетки',
      '/cancelorders — отменить все ордера',
      '/buy — купить количество валюты за USDT (/buy SUI USDT 10)',
      '/sellall — продать всё + отмена ордеров',
      '',
      '<b>🧊 Заморозка:</b>',
      '/freezebuy — заморозить покупки по валюте',
      '/unfreezebuy — разморозить покупки',
      '/freeze — заморозить всё (только SL/TP работают)',
      '/unfreeze — полностью разморозить',
      '',
      '<b>🔻 Распродажа по торговой сетке без покупки новой:</b>',
      '/sellgrid — продавать по торговой сетке + freezebuy',
      '/unsellgrid — отключить sellgrid + unfreezebuy',
      '',
      '<b>⚙️ Управление:</b>',
      '/stop — остановить торговлю',
      '/run — возобновить торговлю',
      '',
      '<b>➕ Криптовалюта:</b>',
      '/addtoken — добавить новую валюту (торговую пару)',
      '/removetoken — удалить пару (ордера отменяются)',
    ].join('\n');
    this.tg.sendReply(text);
  }

  private collectBuyMenuCurrencies(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of this.config.pairs) {
      if (p.state === 'deleted') continue;
      const base = p.symbol.split('/')[0];
      if (base && !seen.has(base)) { seen.add(base); out.push(base); }
    }
    for (const sym of this.state.getManualPairs()) {
      const base = sym.split('/')[0];
      if (base && !seen.has(base)) { seen.add(base); out.push(base); }
    }
    return out;
  }

  private async cmdStatus(): Promise<void> {
    const { single: balance, all: allBalances } = await this.exchange.fetchBalanceAndAll('USDT');
    let totalValue = balance.total;

    const pairLines: string[] = [];
    const countedBases = new Set<string>(); // avoid double-counting base currencies
    // Сортировка: группа (0=активные, 1=замороженные, 2=deleted), внутри — PnL desc.
    const statusSortedPairs = [...this.config.pairs].sort((a, b) =>
      this.comparePairsForDisplay(a.symbol, b.symbol),
    );
    for (const pair of statusSortedPairs) {
      const sym = pair.symbol;
      const base = sym.split('/')[0];
      const held = allBalances[base];
      let pairValue = 0;
      let price = 0;

      if (held && held.total > 0) {
        try {
          const ticker = await this.exchange.fetchTicker(sym);
          price = ticker.last;
          pairValue = held.total * price;
          totalValue += pairValue;
          countedBases.add(base);
        } catch { /* skip */ }
      }

      const pos = this.state.getPosition(sym);
      const levels = this.state.getGridLevels(sym);
      const openOrders = levels.filter(l => l.orderId).length;
      const isHalted = this.state.isPairHalted(sym);

      const statusBase = sym.split('/')[0];
      const frozen = this.state.isBuyBlocked(statusBase);
      const sellgrid = this.state.isSellGridActive(statusBase);
      const marker = (sellgrid ? ' 🔻' : '') + (frozen ? ' 🧊' : '');
      let line = `${sym}${marker}: `;
      if (pos.amount > 0) {
        const pnl = price > 0 ? ((price - pos.avgEntryPrice) / pos.avgEntryPrice * 100) : 0;
        line += `tokens ${parseFloat(pos.amount.toFixed(6))} | avgEntry ${pos.avgEntryPrice.toFixed(4)} | uPnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%`;
      } else {
        line += 'нет позиции';
      }
      line += ` | open ${openOrders}`;
      if (isHalted) line += ' | HALTED';

      pairLines.push(line);
    }

    // Manual pairs (bought via /buy, not in config)
    const manualPairs = this.state.getManualPairs();
    if (manualPairs.length > 0) {
      pairLines.push('');
      pairLines.push('<b>Ручные покупки:</b>');
      for (const sym of manualPairs) {
        const base = sym.split('/')[0];
        const held = allBalances[base];
        if (held && held.total > 0) {
          try {
            const ticker = await this.exchange.fetchTicker(sym);
            const value = held.total * ticker.last;
            if (!countedBases.has(base)) {
              totalValue += value;
              countedBases.add(base);
            }
            pairLines.push(`${sym}: ${held.total.toFixed(6)} (~${value.toFixed(2)} USDT)`);
          } catch {
            pairLines.push(`${sym}: ${held.total.toFixed(6)} (цена недоступна)`);
          }
        } else {
          pairLines.push(`${sym}: продано`);
        }
      }
    }

    const pnl = totalValue - this.state.startingCapital;
    const pnlPct = this.state.startingCapital > 0 ? (pnl / this.state.startingCapital) * 100 : 0;
    const drawdown = this.state.peakCapital > 0
      ? ((this.state.peakCapital - totalValue) / this.state.peakCapital) * 100 : 0;
    const trades = this.state.getRecentTrades();

    const text = [
      `<b>STATUS</b> (tick ${this.state.totalTicks})`,
      `Capital: <b>${totalValue.toFixed(2)}</b> USDT`,
      `Start: ${this.state.startingCapital.toFixed(2)} USDT`,
      `PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
      `Drawdown: ${drawdown.toFixed(1)}%`,
      `Halted: ${this.state.halted ? 'YES' : 'no'}`,
      `Trades: ${trades.length}`,
      `USDT free: ${balance.free.toFixed(2)}`,
      '',
      ...pairLines,
    ].join('\n');
    this.tg.sendReply(text);
  }

  private async cmdStop(): Promise<void> {
    this.state.halted = true;
    this.log.info(`Telegram /stop: bot halted. ${HALT_HINT}`);
    this.tg.sendReply(`Бот остановлен (/stop). Ордера остаются на бирже.\n${HALT_HINT}`);
  }

  private async cmdStart(): Promise<void> {
    this.state.halted = false;
    // Reset all per-pair halts and cooldowns
    for (const pair of this.config.pairs) {
      this.state.resetPairHalt(pair.symbol);
      this.state.clearCooldown(pair.symbol);
      this.state.resetConsecutiveSL(pair.symbol);
    }
    this.log.info('Telegram /run: bot resumed, all pair halts/cooldowns cleared');
    this.tg.sendReply('Бот запущен (/run). Все пары активны, cooldowns сброшены.');
  }

  private async cmdSellAll(): Promise<void> {
    this.tg.sendReply('Выполняю /sellall — отмена ордеров и продажа всех позиций...');
    await this.sellEverything();
    this.state.halted = true;
    this.log.info(`Telegram /sellall: all positions sold, bot halted. ${HALT_HINT}`);

    const balance = await this.exchange.fetchBalance('USDT');
    this.tg.sendReply(`/sellall выполнен. USDT: ${balance.total.toFixed(2)}. Бот остановлен.\n${HALT_HINT}`);
  }

  private async cmdBuy(args: string): Promise<void> {
    // Parse: /buy SUI 10 → buy 10 SUI for USDT (pair = SUI/USDT)
    // Parse: /buy SUI BTC 10 → buy 10 SUI for BTC (pair = SUI/BTC)
    // Legacy: /buy SUI/BTC 10 still accepted (converted transparently)
    const parts = args.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      this.tg.sendReply('Формат: /buy SUI 10 или /buy SUI BTC 10\nПервое — base (что купить), опционально quote (за что), последнее — количество. Quote по умолчанию USDT.');
      return;
    }

    let base: string;
    let quote: string;
    let amount: number;
    if (parts.length === 2) {
      // /buy SUI 10 — quote=USDT, или legacy /buy SUI/BTC 10
      const first = parts[0].toUpperCase();
      if (first.includes('/')) {
        [base, quote] = first.split('/');
      } else {
        base = first;
        quote = 'USDT';
      }
      amount = parseFloat(parts[1]);
    } else {
      // /buy SUI BTC 10
      base = parts[0].toUpperCase();
      quote = parts[1].toUpperCase();
      amount = parseFloat(parts[2]);
    }

    if (!base || !quote) {
      this.tg.sendReply(`Некорректная пара: base=${base} quote=${quote}`);
      return;
    }
    if (isNaN(amount) || amount <= 0) {
      this.tg.sendReply(`Некорректное количество: ${parts[parts.length - 1]}`);
      return;
    }

    const symbol = `${base}/${quote}`;

    // Check quote currency balance
    const balances = await this.exchange.fetchAllBalances();
    const quoteBal = balances[quote];
    if (!quoteBal || quoteBal.free <= 0) {
      this.tg.sendReply(`Нет свободного ${quote} для покупки. Free: ${quoteBal?.free?.toFixed(4) ?? '0'}`);
      return;
    }

    // Get market precision
    let mp: { pricePrecision: number; amountPrecision: number; minAmount: number; minCost: number };
    try {
      mp = await this.exchange.getMarketPrecision(symbol);
    } catch {
      this.tg.sendReply(`Пара ${symbol} не найдена на бирже`);
      return;
    }

    // Round amount to exchange precision
    const factor = Math.pow(10, mp.amountPrecision);
    const roundedAmount = Math.floor(amount * factor) / factor;

    if (roundedAmount < mp.minAmount) {
      this.tg.sendReply(`Количество ${roundedAmount} < минимум ${mp.minAmount} для ${symbol}`);
      return;
    }

    // Check estimated cost
    let ticker;
    try {
      ticker = await this.exchange.fetchTicker(symbol);
    } catch {
      this.tg.sendReply(`Не удалось получить цену ${symbol}`);
      return;
    }

    const estimatedCost = roundedAmount * ticker.last;
    if (estimatedCost < mp.minCost) {
      this.tg.sendReply(`Стоимость ${estimatedCost.toFixed(2)} ${quote} < минимум ${mp.minCost} для ${symbol}`);
      return;
    }

    if (quoteBal.free < estimatedCost) {
      this.tg.sendReply(`Недостаточно ${quote}: нужно ~${estimatedCost.toFixed(2)}, free: ${quoteBal.free.toFixed(4)}`);
      return;
    }

    // Execute market buy
    try {
      const order = await this.exchange.createMarketBuy(symbol, roundedAmount, 'manual');
      this.exchange.deductCachedBalance(quote, roundedAmount * ticker.last);
      const filledAmount = order.filled > 0 ? order.filled : roundedAmount;
      const fillPrice = order.price || ticker.last;
      const cost = filledAmount * fillPrice;

      // Record trade with strategy='manual'
      this.state.addTrade({
        timestamp: Date.now(),
        symbol,
        side: 'buy',
        amount: filledAmount,
        price: fillPrice,
        cost,
        fee: cost * 0.001,
        strategy: 'manual',
      });

      // Track position
      this.state.addToPosition(symbol, filledAmount, cost);

      // Track non-configured pairs for /orders, /status, /sellall
      const isConfigured = this.config.pairs.some(p => p.symbol === symbol);
      if (!isConfigured) {
        this.state.addManualPair(symbol);
      }

      this.log.info(`Telegram /buy: ${filledAmount} ${base} @ ${fillPrice.toFixed(4)} = ${cost.toFixed(2)} ${quote}`);
      this.tg.sendReply(`/buy выполнен\n${filledAmount} ${base} @ ${fillPrice.toFixed(4)}\nСтоимость: ${cost.toFixed(2)} ${quote}`);
    } catch (err) {
      this.log.error(`Telegram /buy failed: ${sanitizeError(err)}`);
      this.tg.sendReply(`/buy ошибка: ${sanitizeError(err)}`);
    }
  }

  private async cmdOrders(): Promise<void> {
    const lines: string[] = ['<b>ОТКРЫТЫЕ ОРДЕРА</b>'];
    let totalOrders = 0;

    for (const pair of this.config.pairs) {
      try {
        const openOrders = await this.exchange.fetchOpenOrders(pair.symbol);
        if (openOrders.length === 0) {
          lines.push(`${pair.symbol}: нет ордеров`);
          continue;
        }

        totalOrders += openOrders.length;
        const buys = openOrders.filter(o => o.side === 'buy').sort((a, b) => b.price - a.price);
        const sells = openOrders.filter(o => o.side === 'sell').sort((a, b) => a.price - b.price);

        lines.push(`\n<b>${pair.symbol}</b> (${openOrders.length} ордеров)`);

        if (sells.length > 0) {
          lines.push(`SELL (${sells.length}):`);
          for (const o of sells.slice(0, 5)) {
            lines.push(`  ${o.amount} @ ${o.price}`);
          }
          if (sells.length > 5) lines.push(`  ...+${sells.length - 5} ещё`);
        }

        if (buys.length > 0) {
          lines.push(`BUY (${buys.length}):`);
          for (const o of buys.slice(0, 5)) {
            lines.push(`  ${o.amount} @ ${o.price}`);
          }
          if (buys.length > 5) lines.push(`  ...+${buys.length - 5} ещё`);
        }
      } catch (err) {
        lines.push(`${pair.symbol}: ошибка — ${sanitizeError(err)}`);
      }
    }

    // Manual pairs (bought via /buy, not in config)
    const manualPairs = this.state.getManualPairs();
    for (const sym of manualPairs) {
      // Skip if already shown as configured pair
      if (this.config.pairs.some(p => p.symbol === sym)) continue;
      try {
        const openOrders = await this.exchange.fetchOpenOrders(sym);
        if (openOrders.length > 0) {
          totalOrders += openOrders.length;
          lines.push(`\n<b>${sym}</b> (${openOrders.length}, ручная)`);
          for (const o of openOrders.slice(0, 5)) {
            lines.push(`  ${o.side.toUpperCase()} ${o.amount} @ ${o.price}`);
          }
          if (openOrders.length > 5) lines.push(`  ...+${openOrders.length - 5} ещё`);
        }
      } catch { /* skip */ }
    }

    lines.push(`\nВсего: ${totalOrders} ордеров`);
    this.tg.sendReply(lines.join('\n'));
  }

  private async cmdCancelOrders(): Promise<void> {
    let cancelled = 0;

    for (const pair of this.config.pairs) {
      try {
        await this.grid.cancelAll(pair.symbol);
        const orders = await this.exchange.fetchOpenOrders(pair.symbol);
        cancelled += orders.length === 0 ? 1 : 0;
        this.log.info(`Telegram /cancelorders: cancelled all for ${pair.symbol}`);
      } catch (err) {
        this.log.error(`Cancel orders failed for ${pair.symbol}: ${sanitizeError(err)}`);
      }
    }

    // Cancel manual pairs orders too
    for (const sym of this.state.getManualPairs()) {
      if (this.config.pairs.some(p => p.symbol === sym)) continue;
      try {
        await this.exchange.cancelAllOrders(sym);
      } catch { /* skip */ }
    }

    this.state.halted = true;
    this.tg.sendReply(`Все ордера отменены, grid сброшен. Бот остановлен.\n${HALT_HINT}`);
  }

  private async cmdStats(): Promise<void> {
    const lines: string[] = ['<b>📊 Trade Statistics</b>', ''];
    let totalSpent = 0, totalEarned = 0, totalBuyFees = 0, totalSellFees = 0;

    // Fetch tickers in parallel (cache-first, parallelPairs batch size)
    const symbols = this.config.pairs.map(p => p.symbol);
    const chunkSize = this.config.parallelPairs > 0 ? this.config.parallelPairs : 4;
    const tickerMap = new Map<string, Ticker | null>();
    for (let i = 0; i < symbols.length; i += chunkSize) {
      const chunk = symbols.slice(i, i + chunkSize);
      const results = await Promise.allSettled(
        chunk.map(s => this.exchange.getCachedOrFreshTicker(s)),
      );
      results.forEach((r, idx) => {
        tickerMap.set(chunk[idx], r.status === 'fulfilled' ? r.value : null);
      });
    }

    // Сортировка: группа (0=активные, 1=замороженные, 2=deleted), внутри группы — PnL desc.
    const pairsSorted = [...this.config.pairs].sort((a, b) =>
      this.comparePairsForDisplay(a.symbol, b.symbol),
    );

    for (const pair of pairsSorted) {
      const s = this.state.getPairStats(pair.symbol);
      const pnlSign = s.pnl >= 0 ? '+' : '';
      const pnlPct = s.spent > 0 ? (s.pnl / s.spent) * 100 : 0;
      const statsBase2 = pair.symbol.split('/')[0];
      const statsFrozen = this.state.isBuyBlocked(statsBase2);
      const statsSellgrid = this.state.isSellGridActive(statsBase2);
      const statsMarker = (statsSellgrid ? ' 🔻' : '') + (statsFrozen ? ' 🧊' : '');

      // Nearest active buy (highest price < current) and sell (lowest price > current)
      const levels = this.state.getGridLevels(pair.symbol);
      const activeBuys = levels.filter(l => l.side === 'buy' && l.orderId && !l.filled);
      const activeSells = levels.filter(l => l.side === 'sell' && l.orderId && !l.filled);
      const nearestBuy = activeBuys.length > 0 ? Math.max(...activeBuys.map(l => l.price)) : null;
      const nearestSell = activeSells.length > 0 ? Math.min(...activeSells.map(l => l.price)) : null;
      const ticker = tickerMap.get(pair.symbol);
      const px = ticker?.last ?? null;
      const quote = pair.symbol.split('/')[1] ?? 'USDT';
      let marketLine = '';
      if (px === null || px <= 0) {
        marketLine = ' Price: N/A';
      } else {
        const parts: string[] = [`NowPrice ${px.toFixed(4)}`];
        if (nearestBuy !== null) {
          const d = nearestBuy - px;
          const dp = (d / px) * 100;
          parts.push(`↓ ${d >= 0 ? '+' : ''}${d.toFixed(4)} (${dp >= 0 ? '+' : ''}${dp.toFixed(2)}%)`);
        } else {
          parts.push('↓ no buy');
        }
        if (nearestSell !== null) {
          const d = nearestSell - px;
          const dp = (d / px) * 100;
          parts.push(`↑ ${d >= 0 ? '+' : ''}${d.toFixed(4)} (${dp >= 0 ? '+' : ''}${dp.toFixed(2)}%)`);
        } else {
          parts.push('↑ no sell');
        }
        marketLine = ' ' + parts.join(' ') + ` ${quote}`;
      }

      lines.push(
        `<b>${pair.symbol}</b> (${s.buys}B / ${s.sells}S)${statsMarker}`,
        ` Spent: ${s.spent.toFixed(2)} | Earned: ${s.earned.toFixed(2)}`,
        ` Fees: ${s.buyFees.toFixed(3)} (buy) + ${s.sellFees.toFixed(3)} (sell)`,
        ` Realized PnL: ${pnlSign}${s.pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)`,
        marketLine,
        '',
      );
      totalSpent += s.spent;
      totalEarned += s.earned;
      totalBuyFees += s.buyFees;
      totalSellFees += s.sellFees;
    }

    const totalFees = totalBuyFees + totalSellFees;
    const capital = this.lastTickPortfolioValue > 0 ? this.lastTickPortfolioValue : this.state.peakCapital;
    const portfolioPnl = capital - this.state.startingCapital;
    const portfolioSign = portfolioPnl >= 0 ? '+' : '';
    const portfolioPnlPct = this.state.startingCapital > 0 ? (portfolioPnl / this.state.startingCapital) * 100 : 0;
    lines.push(
      `<b>TOTAL</b> (${capital.toFixed(2)} USDT)`,
      ` Start: ${this.state.startingCapital.toFixed(2)} USDT`,
      ` Spent: ${totalSpent.toFixed(2)} | Earned: ${totalEarned.toFixed(2)}`,
      ` Fees: ${totalBuyFees.toFixed(3)} (buy) + ${totalSellFees.toFixed(3)} (sell) = ${totalFees.toFixed(3)}`,
      ` Portfolio PnL: ${portfolioSign}${portfolioPnl.toFixed(2)} (${portfolioSign}${portfolioPnlPct.toFixed(1)}%)`,
    );

    this.tg.sendReply(lines.join('\n'));
  }

  private async cmdResetGrid(): Promise<void> {
    this.log.info('Telegram /regrid: cancelling all orders and resetting grid...');
    let cancelled = 0;

    for (const pair of this.config.pairs) {
      const sym = pair.symbol;
      try {
        await this.grid.cancelAll(sym);
        // Сохраняем sell-уровни с counter-sell metadata (oldBreakEven/originalPlannedSellPrice)
        // чтобы initGrid на следующем тике подхватил их и не потерял trailing-контекст.
        // virtualNewSellPrice и nextStepAt сбрасываются — trailing начнётся заново при следующем downshift.
        const levelsBeforeReset = this.state.getGridLevels(sym);
        const preservedSells = levelsBeforeReset
          .filter(l => l.side === 'sell' && l.oldBreakEven)
          .map(l => ({ ...l, orderId: undefined, filled: false, virtualNewSellPrice: undefined, nextStepAt: undefined }));
        this.state.setGridLevels(sym, preservedSells);
        this.state.setGridInitialized(sym, false);
        this.state.setGridCenterPrice(sym, 0);
        cancelled++;
        this.log.info(`  ${sym}: orders cancelled, grid reset (preserved ${preservedSells.length} sell level(s) with counter-sell metadata)`);
      } catch (err) {
        this.log.error(`  ${sym}: reset failed — ${sanitizeError(err)}`);
      }
    }

    this.tg.sendReply(
      `✅ Grid reset for ${cancelled}/${this.config.pairs.length} pairs\n` +
      `Orders cancelled, grid will rebuild on next tick with current spacing.`,
    );
  }

  // ----------------------------------------------------------
  // Shutdown
  // ----------------------------------------------------------

  async shutdown(cancelOrders: boolean = false): Promise<void> {
    this.log.info('Shutting down ComboManager...');
    if (cancelOrders) {
      for (const pair of this.config.pairs) {
        await this.grid.cancelAll(pair.symbol);
      }
      this.log.info('All grid orders cancelled.');
    } else {
      this.log.info('Soft shutdown — grid orders LEFT OPEN on exchange (will be synced on next start).');
    }
    this.state.shutdown();
    this.log.info('State saved. Bot stopped.');
  }

  isHalted(): boolean {
    return this.state.halted;
  }

  resetHalt(): void {
    this.state.halted = false;
    // Also reset all per-pair halts
    for (const pair of this.config.pairs) {
      this.state.resetPairHalt(pair.symbol);
    }
    this.log.info('Halt reset (global + all pairs). Bot will resume on next tick.');
  }
}
