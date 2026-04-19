// ============================================================
// Bybit Combo Bot — Shared constants
// ============================================================

/**
 * Tolerance (%) for position reconciliation with Bybit balance.
 * If |state.positionAmount - Bybit.total| / max > this %, state is adopted from Bybit.
 * Used by both startup sync (ExchangeSync.reconcilePositionsWithBalance)
 * and per-tick reconcile in ComboManager.tick.
 * Lower value = more aggressive drift correction, higher rate of false positives
 * from fee rounding / partial-fill timing.
 */
export const POSITION_RECONCILE_TOLERANCE_PERCENT = 1;
