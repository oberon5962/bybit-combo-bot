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
  log.info(`Mode: ${config.testnet ? 'TESTNET' : '🟢 LIVE'}`);
  log.info(`Pairs: ${config.pairs.map((p) => `${p.symbol} (${p.allocationPercent}%)`).join(', ')}`);
  log.info(`Tick interval: ${config.tickIntervalSec}s`);
  log.info(`Sync interval: ${config.syncIntervalSec > 0 ? config.syncIntervalSec + 's' : 'disabled'}`);

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
  let shuttingDown = false;   // Prevent ticks during shutdown
  let lastSyncTime = Date.now();

  const runTick = async () => {
    // Prevent ticks during shutdown or if previous tick still running
    if (shuttingDown) return;
    if (tickInProgress) {
      log.warn('Previous tick still running, skipping this tick');
      return;
    }

    tickInProgress = true;
    tickCount++;
    const tickStart = Date.now();

    try {
      // Periodic sync with exchange
      if (config.syncIntervalSec > 0) {
        const timeSinceSync = (Date.now() - lastSyncTime) / 1000;
        if (timeSinceSync >= config.syncIntervalSec) {
          log.info('Periodic sync with Bybit...');
          await sync.syncOnStartup();
          lastSyncTime = Date.now();
        }
      }

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
  const interval = setInterval(runTick, config.tickIntervalSec * 1000);

  // ----------------------------------------------------------
  // Graceful shutdown
  // ----------------------------------------------------------

  let shutdownCount = 0;
  let shutdownInProgress = false;
  const shutdown = async (signal: string) => {
    shutdownCount++;
    shuttingDown = true;
    clearInterval(interval);

    if (shutdownCount === 1) {
      if (shutdownInProgress) return; // guard against duplicate signals
      shutdownInProgress = true;

      log.info(`Received ${signal}. Soft shutdown — keeping grid orders on exchange...`);

      // Wait for current tick to finish before shutting down
      // to prevent race: tick places order AFTER shutdown cancels all
      if (tickInProgress) {
        log.info('Waiting for current tick to finish...');
        const maxWait = 30000; // 30s max wait
        const start = Date.now();
        while (tickInProgress && Date.now() - start < maxWait) {
          await new Promise(r => setTimeout(r, 200));
        }
        if (tickInProgress) {
          log.warn('Tick still running after 30s — proceeding with shutdown');
        }
      }

      await manager.shutdown(false); // soft: keep orders alive
      log.info('Bot stopped. Goodbye!');
      process.exit(0);
    } else if (shutdownCount === 2) {
      // Second Ctrl+C = hard shutdown: cancel all orders
      log.info(`Received ${signal} again. Hard shutdown — cancelling all orders...`);
      await manager.shutdown(true).catch(() => {});
      log.info('All orders cancelled. Bot stopped.');
      process.exit(1);
    } else {
      // Third+ Ctrl+C = force exit immediately
      process.exit(2);
    }
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
