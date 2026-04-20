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
  amount: number;        // количество монет в ордере
  side: 'buy' | 'sell';
  orderId?: string;
  filled: boolean;
  placedAt?: number;     // timestamp когда ордер выставлен
  // Источник sell-уровня (для правильного preserve при force-rebalance):
  //   'counter' — counter-sell от конкретного buy-fill (oldBreakEven = actualPrice×1.005) — сохраняется halving
  //   'orphan'  — orphan-sell от uncovered балансa (position-level break-even)
  //   'initial' — initial-grid-sell из первичной сетки (position-level break-even)
  //   undefined — legacy pre-sellSource-feature, детектируется через оригинальность oldBreakEven
  sellSource?: 'counter' | 'orphan' | 'initial';
  // Counter-sell trailing (rebalance DOWN):
  oldBreakEven?: number;              // нижняя граница trailing (только для шага 2)
  originalPlannedSellPrice?: number;  // стартовая цена sell при создании counter-sell
  virtualNewSellPrice?: number;       // целевая цена spacing после ребаланса (шаг 1)
  nextStepAt?: number;                // timestamp следующего шага midpoint (шаг 4)
}

export interface PairState {
  // DCA
  lastDcaBuyTime: number;
  dcaTotalInvested: number;
  dcaTotalBought: number;

  // Grid
  gridLevels: GridLevelState[];
  gridInitialized: boolean;
  gridCenterPrice: number;    // цена при инициализации сетки (для расчёта drift)

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

  // Trade statistics (cumulative, persisted)
  statBuys: number;         // total buy trades count
  statSells: number;        // total sell trades count
  statSpent: number;        // total USDT spent on buys
  statEarned: number;       // total USDT earned from sells
  statBuyFees: number;      // fees paid on buys
  statSellFees: number;     // fees paid on sells
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

  // Pairs bought manually via /buy that are NOT in config.pairs (e.g. "DOGE/USDT")
  manualPairs: string[];

  // Base currencies with buy-freeze enabled (e.g. ["XRP", "AAVE"]) — bot will not auto-buy these
  blockedBuyBases: string[];

  // Base currencies with sellgrid mode enabled — after each sell fill, place new sell higher (ladder)
  sellGridBases: string[];

  // Base currencies with full freeze: no buy/sell orders placed, only SL/TP allowed
  frozenPairs: string[];

  // Symbols (full, e.g. "DOT/USDT") marked as deleted — no trading, hidden from summary/stats/status
  deletedPairs: string[];

  // Telegram lastUpdateId — persisted to avoid replaying commands on restart
  telegramUpdateId: number;
}

export interface TradeEntry {
  timestamp: number;
  symbol: string;
  side: 'buy' | 'sell';
  amount: number;
  price: number;
  cost: number;
  fee: number;       // estimated trading fee in USDT (0.1% of cost for Bybit spot)
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
    manualPairs: [],
    blockedBuyBases: [],
    sellGridBases: [],
    frozenPairs: [],
    deletedPairs: [],
    telegramUpdateId: 0,
  };
}

function createEmptyPairState(): PairState {
  return {
    lastDcaBuyTime: 0,
    dcaTotalInvested: 0,
    dcaTotalBought: 0,
    gridLevels: [],
    gridInitialized: false,
    gridCenterPrice: 0,
    positionAmount: 0,
    positionCostBasis: 0,
    halted: false,
    cooldownUntil: 0,
    consecutiveSL: 0,
    trailingPeak: 0,
    statBuys: 0,
    statSells: 0,
    statSpent: 0,
    statEarned: 0,
    statBuyFees: 0,
    statSellFees: 0,
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
      // Windows crash recovery: if main file is missing, try .tmp then .bak
      const tmpFile = STATE_FILE + '.tmp';
      const bakFile = STATE_FILE + '.bak';
      if (!fs.existsSync(STATE_FILE)) {
        if (fs.existsSync(tmpFile)) {
          this.log.warn(`State file missing but .tmp found — recovering from ${tmpFile}`);
          fs.renameSync(tmpFile, STATE_FILE);
        } else if (fs.existsSync(bakFile)) {
          this.log.warn(`State file missing but .bak found — recovering from ${bakFile}`);
          fs.copyFileSync(bakFile, STATE_FILE);
        }
      }
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
        state.manualPairs = Array.isArray(parsed.manualPairs) ? parsed.manualPairs : [];
        state.blockedBuyBases = Array.isArray(parsed.blockedBuyBases) ? parsed.blockedBuyBases.map((s: string) => String(s).toUpperCase()) : [];
        state.sellGridBases = Array.isArray(parsed.sellGridBases) ? parsed.sellGridBases.map((s: string) => String(s).toUpperCase()) : [];
        state.frozenPairs = Array.isArray(parsed.frozenPairs) ? parsed.frozenPairs.map((s: string) => String(s).toUpperCase()) : [];
        state.deletedPairs = Array.isArray(parsed.deletedPairs) ? parsed.deletedPairs.map((s: string) => String(s)) : [];
        state.telegramUpdateId = typeof parsed.telegramUpdateId === 'number' ? parsed.telegramUpdateId : 0;

        // Restore per-pair state with validation
        if (parsed.pairs && typeof parsed.pairs === 'object') {
          for (const [symbol, pairData] of Object.entries(parsed.pairs)) {
            const pd = pairData as Record<string, unknown>;
            state.pairs[symbol] = {
              lastDcaBuyTime: typeof pd.lastDcaBuyTime === 'number' ? pd.lastDcaBuyTime : 0,
              dcaTotalInvested: typeof pd.dcaTotalInvested === 'number' ? pd.dcaTotalInvested : 0,
              dcaTotalBought: typeof pd.dcaTotalBought === 'number' ? pd.dcaTotalBought : 0,
              gridLevels: Array.isArray(pd.gridLevels)
                ? (pd.gridLevels as any[]).map((l: any) => ({ ...l, amount: l.amount ?? 0, placedAt: l.placedAt ?? undefined })) as GridLevelState[]
                : [],
              gridInitialized: typeof pd.gridInitialized === 'boolean' ? pd.gridInitialized : false,
              gridCenterPrice: typeof pd.gridCenterPrice === 'number' ? pd.gridCenterPrice : 0,
              positionAmount: typeof pd.positionAmount === 'number' ? pd.positionAmount : 0,
              positionCostBasis: typeof pd.positionCostBasis === 'number' ? pd.positionCostBasis : 0,
              halted: typeof pd.halted === 'boolean' ? pd.halted : false,
              haltReason: typeof pd.haltReason === 'string' ? pd.haltReason : undefined,
              cooldownUntil: typeof pd.cooldownUntil === 'number' ? pd.cooldownUntil : 0,
              consecutiveSL: typeof pd.consecutiveSL === 'number' ? pd.consecutiveSL : 0,
              trailingPeak: typeof pd.trailingPeak === 'number' ? pd.trailingPeak : 0,
              statBuys: typeof pd.statBuys === 'number' ? pd.statBuys : 0,
              statSells: typeof pd.statSells === 'number' ? pd.statSells : 0,
              statSpent: typeof pd.statSpent === 'number' ? pd.statSpent : 0,
              statEarned: typeof pd.statEarned === 'number' ? pd.statEarned : 0,
              statBuyFees: typeof pd.statBuyFees === 'number' ? pd.statBuyFees : 0,
              statSellFees: typeof pd.statSellFees === 'number' ? pd.statSellFees : 0,
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

  /** Immediate flush — use for critical state changes (fills, position updates) that must survive a crash. */
  saveCritical(): void {
    this.dirty = true;
    this.flushToDisk();
  }

  flushToDisk(): void {
    if (!this.dirty) return;
    try {
      const json = JSON.stringify(this.state, null, 2);
      const tmpFile = STATE_FILE + '.tmp';
      const bakFile = STATE_FILE + '.bak';
      // Windows: rename can fail with EPERM if antivirus/indexer holds a handle.
      // Strategy: try rename first (faster), fallback to direct write (always works).
      try {
        fs.writeFileSync(tmpFile, json, 'utf-8');
        if (fs.existsSync(STATE_FILE)) {
          try { fs.copyFileSync(STATE_FILE, bakFile); } catch { /* best effort */ }
        }
        fs.renameSync(tmpFile, STATE_FILE);
      } catch {
        // Fallback: write directly to the state file (not atomic but reliable on Windows)
        fs.writeFileSync(STATE_FILE, json, 'utf-8');
        // Clean up .tmp if it exists
        try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
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
  setGridLevels(symbol: string, levels: GridLevelState[], critical: boolean = false): void {
    // Previous zombie filter dropped sells with amount=0 + no orderId + no filled + no metadata.
    // That also removed legit grid-init sells awaiting placement (placeGridOrders sets amount later).
    // Levels without price or with NaN are still invalid; other states are valid in-progress.
    this.getPairState(symbol).gridLevels = levels.filter(
      l => typeof l.price === 'number' && isFinite(l.price) && l.price > 0,
    );
    if (critical) this.saveCritical();
    else this.save();
  }
  isGridInitialized(symbol: string): boolean {
    return this.getPairState(symbol).gridInitialized;
  }
  setGridInitialized(symbol: string, val: boolean): void {
    this.getPairState(symbol).gridInitialized = val;
    if (!val) {
      this.getPairState(symbol).gridCenterPrice = 0; // сброс центра при деинициализации
    }
    this.save();
  }
  getGridCenterPrice(symbol: string): number {
    return this.getPairState(symbol).gridCenterPrice;
  }
  setGridCenterPrice(symbol: string, price: number): void {
    this.getPairState(symbol).gridCenterPrice = price;
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
    this.saveCritical(); // position changes must survive crash
  }
  reducePosition(symbol: string, amount: number): void {
    const ps = this.getPairState(symbol);
    if (ps.positionAmount < 1e-12) {
      // Position is essentially zero — reset to avoid division by near-zero
      ps.positionAmount = 0;
      ps.positionCostBasis = 0;
      this.saveCritical();
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
    this.saveCritical(); // position changes must survive crash
  }
  resetPosition(symbol: string): void {
    const ps = this.getPairState(symbol);
    ps.positionAmount = 0;
    ps.positionCostBasis = 0;
    this.saveCritical();
  }
  /** Overwrite position directly (used by sync reconciliation with exchange balance). */
  setPosition(symbol: string, amount: number, costBasis: number): void {
    const ps = this.getPairState(symbol);
    ps.positionAmount = amount;
    ps.positionCostBasis = costBasis;
    this.saveCritical();
  }

  // Trade statistics
  recordTradeStat(symbol: string, side: 'buy' | 'sell', cost: number, fee: number): void {
    const ps = this.getPairState(symbol);
    if (side === 'buy') {
      ps.statBuys++;
      ps.statSpent += cost;
      ps.statBuyFees += fee;
    } else {
      ps.statSells++;
      ps.statEarned += cost;
      ps.statSellFees += fee;
    }
    this.save();
  }
  getPairStats(symbol: string): { buys: number; sells: number; spent: number; earned: number; buyFees: number; sellFees: number; totalFees: number; pnl: number } {
    const ps = this.getPairState(symbol);
    const totalFees = ps.statBuyFees + ps.statSellFees;
    return {
      buys: ps.statBuys,
      sells: ps.statSells,
      spent: ps.statSpent,
      earned: ps.statEarned,
      buyFees: ps.statBuyFees,
      sellFees: ps.statSellFees,
      totalFees,
      pnl: ps.statEarned - ps.statSpent - totalFees,
    };
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
    // Update per-pair cumulative statistics
    this.recordTradeStat(trade.symbol, trade.side as 'buy' | 'sell', trade.cost, trade.fee);
    this.saveCritical(); // trade records must survive crash
  }

  getRecentTrades(symbol?: string): TradeEntry[] {
    if (symbol) {
      return this.state.recentTrades.filter((t) => t.symbol === symbol);
    }
    return this.state.recentTrades;
  }

  // Manual pairs (bought via /buy, not in config)
  getManualPairs(): string[] {
    return this.state.manualPairs;
  }
  addManualPair(symbol: string): void {
    if (!this.state.manualPairs.includes(symbol)) {
      this.state.manualPairs.push(symbol);
      this.saveCritical(); // manual pair must survive crash — addTrade/addToPosition already committed
    }
  }
  removeManualPair(symbol: string): void {
    this.state.manualPairs = this.state.manualPairs.filter(s => s !== symbol);
    this.saveCritical();
  }

  // Buy-freeze per base currency
  getBlockedBuyBases(): string[] { return this.state.blockedBuyBases ?? []; }
  isBuyBlocked(base: string): boolean { return (this.state.blockedBuyBases ?? []).includes(base.toUpperCase()); }
  addBlockedBuyBase(base: string): boolean {
    const up = base.toUpperCase();
    if (!this.state.blockedBuyBases) this.state.blockedBuyBases = [];
    if (this.state.blockedBuyBases.includes(up)) return false;
    this.state.blockedBuyBases.push(up);
    this.saveCritical();
    return true;
  }
  removeBlockedBuyBase(base: string): boolean {
    const up = base.toUpperCase();
    const before = this.state.blockedBuyBases?.length ?? 0;
    this.state.blockedBuyBases = (this.state.blockedBuyBases ?? []).filter(b => b !== up);
    if (this.state.blockedBuyBases.length === before) return false;
    this.saveCritical();
    return true;
  }

  // Sellgrid mode per base currency
  getSellGridBases(): string[] { return this.state.sellGridBases ?? []; }
  isSellGridActive(base: string): boolean { return (this.state.sellGridBases ?? []).includes(base.toUpperCase()); }
  addSellGridBase(base: string): boolean {
    const up = base.toUpperCase();
    if (!this.state.sellGridBases) this.state.sellGridBases = [];
    if (this.state.sellGridBases.includes(up)) return false;
    this.state.sellGridBases.push(up);
    this.saveCritical();
    return true;
  }
  removeSellGridBase(base: string): boolean {
    const up = base.toUpperCase();
    const before = this.state.sellGridBases?.length ?? 0;
    this.state.sellGridBases = (this.state.sellGridBases ?? []).filter(b => b !== up);
    if (this.state.sellGridBases.length === before) return false;
    this.saveCritical();
    return true;
  }

  // Full freeze per base currency (no buy/sell orders, only SL/TP allowed)
  getFrozenPairs(): string[] { return this.state.frozenPairs ?? []; }
  isPairFrozen(base: string): boolean { return (this.state.frozenPairs ?? []).includes(base.toUpperCase()); }
  addFrozenPair(base: string): boolean {
    const up = base.toUpperCase();
    if (!this.state.frozenPairs) this.state.frozenPairs = [];
    if (this.state.frozenPairs.includes(up)) return false;
    this.state.frozenPairs.push(up);
    this.saveCritical();
    return true;
  }
  removeFrozenPair(base: string): boolean {
    const up = base.toUpperCase();
    const before = this.state.frozenPairs?.length ?? 0;
    this.state.frozenPairs = (this.state.frozenPairs ?? []).filter(b => b !== up);
    if (this.state.frozenPairs.length === before) return false;
    this.saveCritical();
    return true;
  }

  // Deleted pairs (full symbol, e.g. "DOT/USDT")
  getDeletedPairs(): string[] { return this.state.deletedPairs ?? []; }
  isPairDeleted(symbol: string): boolean { return (this.state.deletedPairs ?? []).includes(symbol); }
  markPairDeleted(symbol: string): void {
    if (!this.state.deletedPairs) this.state.deletedPairs = [];
    if (!this.state.deletedPairs.includes(symbol)) {
      this.state.deletedPairs.push(symbol);
      this.saveCritical();
    }
  }
  unmarkPairDeleted(symbol: string): void {
    this.state.deletedPairs = (this.state.deletedPairs ?? []).filter(s => s !== symbol);
    this.saveCritical();
  }

  // Telegram update offset (persisted to avoid replaying commands on restart)
  get telegramUpdateId(): number { return this.state.telegramUpdateId; }
  set telegramUpdateId(val: number) { this.state.telegramUpdateId = val; this.save(); }

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
