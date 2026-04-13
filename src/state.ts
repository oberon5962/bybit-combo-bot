// ============================================================
// Bybit Combo Bot — State Persistence
// ============================================================
//
// Сохраняет состояние бота в JSON-файл при каждом изменении.
// При перезапуске загружает состояние и продолжает с того же
// места: Grid-ордера, DCA-таймеры, статистика, пиковый капитал.
// ============================================================

import fs from 'fs';
import path from 'path';
import { Logger } from './types';

const STATE_FILE = path.join(process.cwd(), 'bot-state.json');

// ----------------------------------------------------------
// State shape
// ----------------------------------------------------------

export interface GridLevelState {
  price: number;
  side: 'buy' | 'sell';
  orderId?: string;
  filled: boolean;
}

export interface PairState {
  // DCA
  lastDcaBuyTime: number;
  dcaTotalInvested: number;
  dcaTotalBought: number;

  // Grid
  gridLevels: GridLevelState[];
  gridInitialized: boolean;

  // Position tracking (for stop-loss / take-profit)
  positionAmount: number;     // total crypto held (accumulated from buys, reduced by sells)
  positionCostBasis: number;  // total USDT spent on current position

  // Per-pair halt (SL/TP triggered — pair paused, other pairs continue)
  halted: boolean;
  haltReason?: string;

  // Cooldown after SL
  cooldownUntil: number;    // timestamp когда cooldown заканчивается (0 = нет)
  consecutiveSL: number;    // счётчик SL подряд

  // Trailing SL
  trailingPeak: number;     // максимальная цена с момента входа (0 = не активирован)
}

export interface BotState {
  // Per-pair state
  pairs: Record<string, PairState>;

  // Risk management
  peakCapital: number;
  startingCapital: number;

  // Bot meta
  lastTickTime: number;
  totalTicks: number;
  halted: boolean;

  // Trade history (last 100 trades)
  recentTrades: TradeEntry[];
}

export interface TradeEntry {
  timestamp: number;
  symbol: string;
  side: 'buy' | 'sell';
  amount: number;
  price: number;
  cost: number;
  strategy: string;
}

// ----------------------------------------------------------
// Default empty state
// ----------------------------------------------------------

function createEmptyState(): BotState {
  return {
    pairs: {},
    peakCapital: 0,
    startingCapital: 0,
    lastTickTime: 0,
    totalTicks: 0,
    halted: false,
    recentTrades: [],
  };
}

function createEmptyPairState(): PairState {
  return {
    lastDcaBuyTime: 0,
    dcaTotalInvested: 0,
    dcaTotalBought: 0,
    gridLevels: [],
    gridInitialized: false,
    positionAmount: 0,
    positionCostBasis: 0,
    halted: false,
    cooldownUntil: 0,
    consecutiveSL: 0,
    trailingPeak: 0,
  };
}

// ----------------------------------------------------------
// StateManager
// ----------------------------------------------------------

export class StateManager {
  private state: BotState;
  private log: Logger;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty: boolean = false;

  constructor(log: Logger) {
    this.log = log;
    this.state = this.load();
  }

  // ----------------------------------------------------------
  // Load from disk
  // ----------------------------------------------------------

  private load(): BotState {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        const parsed = JSON.parse(raw);

        // Validate essential fields — merge with defaults for missing properties
        const state = createEmptyState();
        state.peakCapital = typeof parsed.peakCapital === 'number' ? parsed.peakCapital : 0;
        state.startingCapital = typeof parsed.startingCapital === 'number' ? parsed.startingCapital : 0;
        state.lastTickTime = typeof parsed.lastTickTime === 'number' ? parsed.lastTickTime : 0;
        state.totalTicks = typeof parsed.totalTicks === 'number' ? parsed.totalTicks : 0;
        state.halted = typeof parsed.halted === 'boolean' ? parsed.halted : false;
        state.recentTrades = Array.isArray(parsed.recentTrades) ? parsed.recentTrades : [];

        // Restore per-pair state with validation
        if (parsed.pairs && typeof parsed.pairs === 'object') {
          for (const [symbol, pairData] of Object.entries(parsed.pairs)) {
            const pd = pairData as Record<string, unknown>;
            state.pairs[symbol] = {
              lastDcaBuyTime: typeof pd.lastDcaBuyTime === 'number' ? pd.lastDcaBuyTime : 0,
              dcaTotalInvested: typeof pd.dcaTotalInvested === 'number' ? pd.dcaTotalInvested : 0,
              dcaTotalBought: typeof pd.dcaTotalBought === 'number' ? pd.dcaTotalBought : 0,
              gridLevels: Array.isArray(pd.gridLevels) ? pd.gridLevels as GridLevelState[] : [],
              gridInitialized: typeof pd.gridInitialized === 'boolean' ? pd.gridInitialized : false,
              positionAmount: typeof pd.positionAmount === 'number' ? pd.positionAmount : 0,
              positionCostBasis: typeof pd.positionCostBasis === 'number' ? pd.positionCostBasis : 0,
              halted: typeof pd.halted === 'boolean' ? pd.halted : false,
              haltReason: typeof pd.haltReason === 'string' ? pd.haltReason : undefined,
              cooldownUntil: typeof pd.cooldownUntil === 'number' ? pd.cooldownUntil : 0,
              consecutiveSL: typeof pd.consecutiveSL === 'number' ? pd.consecutiveSL : 0,
              trailingPeak: typeof pd.trailingPeak === 'number' ? pd.trailingPeak : 0,
            };
          }
        }

        this.log.info(`State loaded from ${STATE_FILE}`, {
          ticks: state.totalTicks,
          pairs: Object.keys(state.pairs).length,
          trades: state.recentTrades.length,
        });
        return state;
      }
    } catch (err) {
      this.log.error(`Failed to load state, starting fresh: ${err}`);
    }
    this.log.info('No saved state found, starting fresh');
    return createEmptyState();
  }

  // ----------------------------------------------------------
  // Save to disk (debounced — writes at most once per second)
  // ----------------------------------------------------------

  save(): void {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.flushToDisk();
        this.saveTimer = null;
      }, 1000);
    }
  }

  flushToDisk(): void {
    if (!this.dirty) return;
    try {
      const json = JSON.stringify(this.state, null, 2);
      // Atomic write: write to temp file, then rename (rename is atomic on same filesystem)
      const tmpFile = STATE_FILE + '.tmp';
      fs.writeFileSync(tmpFile, json, 'utf-8');
      fs.renameSync(tmpFile, STATE_FILE);
      this.dirty = false;
      this.log.debug('State saved to disk');
    } catch (err) {
      this.log.error(`Failed to save state: ${err}`);
    }
  }

  // ----------------------------------------------------------
  // Getters / Setters
  // ----------------------------------------------------------

  getState(): BotState {
    return this.state;
  }

  getPairState(symbol: string): PairState {
    if (!this.state.pairs[symbol]) {
      this.state.pairs[symbol] = createEmptyPairState();
    }
    return this.state.pairs[symbol];
  }

  // Risk management
  get peakCapital(): number { return this.state.peakCapital; }
  set peakCapital(val: number) { this.state.peakCapital = val; this.save(); }

  get startingCapital(): number { return this.state.startingCapital; }
  set startingCapital(val: number) { this.state.startingCapital = val; this.save(); }

  get halted(): boolean { return this.state.halted; }
  set halted(val: boolean) { this.state.halted = val; this.save(); }

  // Tick tracking
  get totalTicks(): number { return this.state.totalTicks; }
  recordTick(): void {
    this.state.totalTicks++;
    this.state.lastTickTime = Date.now();
    this.save();
  }

  // DCA
  getLastDcaBuyTime(symbol: string): number {
    return this.getPairState(symbol).lastDcaBuyTime;
  }
  setLastDcaBuyTime(symbol: string, time: number): void {
    this.getPairState(symbol).lastDcaBuyTime = time;
    this.save();
  }
  getDcaStats(symbol: string): { totalInvested: number; totalBought: number } {
    const ps = this.getPairState(symbol);
    return { totalInvested: ps.dcaTotalInvested, totalBought: ps.dcaTotalBought };
  }
  addDcaPurchase(symbol: string, cost: number, amount: number): void {
    const ps = this.getPairState(symbol);
    ps.dcaTotalInvested += cost;
    ps.dcaTotalBought += amount;
    this.save();
  }

  // Grid
  getGridLevels(symbol: string): GridLevelState[] {
    return this.getPairState(symbol).gridLevels;
  }
  setGridLevels(symbol: string, levels: GridLevelState[]): void {
    this.getPairState(symbol).gridLevels = levels;
    this.save();
  }
  isGridInitialized(symbol: string): boolean {
    return this.getPairState(symbol).gridInitialized;
  }
  setGridInitialized(symbol: string, val: boolean): void {
    this.getPairState(symbol).gridInitialized = val;
    this.save();
  }

  // Position tracking (for stop-loss / take-profit)
  getPosition(symbol: string): { amount: number; costBasis: number; avgEntryPrice: number } {
    const ps = this.getPairState(symbol);
    return {
      amount: ps.positionAmount,
      costBasis: ps.positionCostBasis,
      avgEntryPrice: ps.positionAmount > 0 ? ps.positionCostBasis / ps.positionAmount : 0,
    };
  }
  addToPosition(symbol: string, amount: number, cost: number): void {
    const ps = this.getPairState(symbol);
    ps.positionAmount += amount;
    ps.positionCostBasis += cost;
    this.save();
  }
  reducePosition(symbol: string, amount: number): void {
    const ps = this.getPairState(symbol);
    if (ps.positionAmount < 1e-10) {
      // Position is essentially zero — reset to avoid division by near-zero
      ps.positionAmount = 0;
      ps.positionCostBasis = 0;
      this.save();
      return;
    }
    // Reduce cost basis proportionally
    const fraction = Math.min(amount / ps.positionAmount, 1);
    ps.positionCostBasis = Math.max(0, ps.positionCostBasis * (1 - fraction));
    ps.positionAmount = Math.max(0, ps.positionAmount - amount);
    // Clamp to zero to avoid floating point drift
    if (ps.positionAmount < 1e-12) {
      ps.positionAmount = 0;
      ps.positionCostBasis = 0;
    }
    this.save();
  }
  resetPosition(symbol: string): void {
    const ps = this.getPairState(symbol);
    ps.positionAmount = 0;
    ps.positionCostBasis = 0;
    this.save();
  }

  // Per-pair halt
  isPairHalted(symbol: string): boolean {
    return this.getPairState(symbol).halted;
  }
  haltPair(symbol: string, reason?: string): void {
    const ps = this.getPairState(symbol);
    ps.halted = true;
    ps.haltReason = reason;
    this.save();
  }
  getHaltReason(symbol: string): string | undefined {
    return this.getPairState(symbol).haltReason;
  }
  resetPairHalt(symbol: string): void {
    const ps = this.getPairState(symbol);
    ps.halted = false;
    ps.haltReason = undefined;
    this.save();
  }

  // Cooldown
  setCooldown(symbol: string, untilTimestamp: number): void {
    const ps = this.getPairState(symbol);
    ps.cooldownUntil = untilTimestamp;
    this.save();
  }
  getCooldownUntil(symbol: string): number {
    return this.getPairState(symbol).cooldownUntil;
  }
  clearCooldown(symbol: string): void {
    const ps = this.getPairState(symbol);
    ps.cooldownUntil = 0;
    this.save();
  }
  incrementConsecutiveSL(symbol: string): number {
    const ps = this.getPairState(symbol);
    ps.consecutiveSL++;
    this.save();
    return ps.consecutiveSL;
  }
  resetConsecutiveSL(symbol: string): void {
    const ps = this.getPairState(symbol);
    ps.consecutiveSL = 0;
    this.save();
  }
  getConsecutiveSL(symbol: string): number {
    return this.getPairState(symbol).consecutiveSL;
  }

  // Trailing SL
  updateTrailingPeak(symbol: string, price: number): void {
    const ps = this.getPairState(symbol);
    if (price > ps.trailingPeak) {
      ps.trailingPeak = price;
      this.save();
    }
  }
  getTrailingPeak(symbol: string): number {
    return this.getPairState(symbol).trailingPeak;
  }
  resetTrailingPeak(symbol: string): void {
    const ps = this.getPairState(symbol);
    ps.trailingPeak = 0;
    this.save();
  }
  // Check if ALL pairs are halted (used for global halt message)
  areAllPairsHalted(): boolean {
    return Object.values(this.state.pairs).length > 0 &&
      Object.values(this.state.pairs).every(p => p.halted);
  }

  // Trade history
  addTrade(trade: TradeEntry): void {
    this.state.recentTrades.push(trade);
    // Keep only last 500 trades (~2 days of active grid trading)
    if (this.state.recentTrades.length > 500) {
      this.state.recentTrades = this.state.recentTrades.slice(-500);
    }
    this.save();
  }

  getRecentTrades(symbol?: string): TradeEntry[] {
    if (symbol) {
      return this.state.recentTrades.filter((t) => t.symbol === symbol);
    }
    return this.state.recentTrades;
  }

  // ----------------------------------------------------------
  // Cleanup on shutdown
  // ----------------------------------------------------------

  shutdown(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.flushToDisk();
    this.log.info('State flushed to disk on shutdown');
  }
}
