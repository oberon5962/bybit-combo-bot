// ============================================================
// Bybit Combo Bot — Entry Point
// ============================================================
//
// Usage:
//   1. Copy .env.example → .env and add your Bybit API keys
//   2. npm install
//   3. npm run dev       (development with ts-node)
//   4. npm run build && npm start  (production)
//
// IMPORTANT: Start with USE_TESTNET=true in your .env file!
// ============================================================

import { loadConfig } from './config';
import { createLogger } from './logger';
import { BybitExchange } from './exchange';
import { ComboManager } from './strategies/combo-manager';
import { StateManager } from './state';
import { ExchangeSync } from './sync';

async function main(): Promise<void> {
  const log = createLogger('info');

  log.info('='.repeat(60));
  log.info('  Bybit Combo Bot — Grid + DCA + Indicators');
  log.info('='.repeat(60));

  // Load config
  const config = loadConfig();
  log.info(`Mode: ${config.testnet ? 'TESTNET' : '🔴 LIVE'}`);
  log.info(`Pairs: ${config.pairs.map((p) => `${p.symbol} (${p.allocationPercent}%)`).join(', ')}`);
  log.info(`Tick interval: ${config.tickIntervalMs / 1000}s`);

  // Initialize exchange
  const exchange = new BybitExchange(config, log);

  // Initialize state manager (loads saved state from bot-state.json)
  const state = new StateManager(log);

  // ----------------------------------------------------------
  // Sync with Bybit — verify state against real exchange data
  // ----------------------------------------------------------
  const sync = new ExchangeSync(config, exchange, state, log);
  const portfolio = await sync.syncOnStartup();

  if (portfolio.totalValueUSDT <= 0) {
    log.error('No balance on Bybit! Fund your account or check API permissions.');
    process.exit(1);
  }

  // Initialize combo manager
  const manager = new ComboManager(config, exchange, log, state);
  await manager.init();

  // ----------------------------------------------------------
  // Main loop
  // ----------------------------------------------------------

  let tickCount = 0;
  let tickInProgress = false; // Guard against overlapping ticks

  const runTick = async () => {
    // Prevent concurrent ticks if previous tick is still running (slow API, etc.)
    if (tickInProgress) {
      log.warn('Previous tick still running, skipping this tick');
      return;
    }

    tickInProgress = true;
    tickCount++;
    const tickStart = Date.now();

    try {
      log.debug(`--- Tick #${tickCount} ---`);
      await manager.tick();
    } catch (err) {
      log.error(`Tick #${tickCount} failed: ${err}`);
    } finally {
      tickInProgress = false;
    }

    const elapsed = Date.now() - tickStart;
    log.debug(`Tick #${tickCount} completed in ${elapsed}ms`);
  };

  // Run first tick immediately
  await runTick();

  // Schedule recurring ticks
  const interval = setInterval(runTick, config.tickIntervalMs);

  // ----------------------------------------------------------
  // Graceful shutdown
  // ----------------------------------------------------------

  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}. Shutting down gracefully...`);
    clearInterval(interval);
    await manager.shutdown();
    log.info('Bot stopped. Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep process alive
  log.info('Bot is running. Press Ctrl+C to stop.');
}

// ----------------------------------------------------------
// Start
// ----------------------------------------------------------

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
