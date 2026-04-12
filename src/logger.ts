// ============================================================
// Bybit Combo Bot — Logger (winston wrapper)
// ============================================================

import winston from 'winston';
import { Logger as BotLogger } from './types';

export function createLogger(level: string = 'info'): BotLogger {
  const logger = winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length > 0
          ? ` | ${JSON.stringify(meta)}`
          : '';
        return `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}${metaStr}`;
      }),
    ),
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({
        filename: 'bot.log',
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
      }),
      new winston.transports.File({
        filename: 'errors.log',
        level: 'error',
        maxsize: 5 * 1024 * 1024,
        maxFiles: 3,
      }),
    ],
  });

  return {
    info: (msg, meta) => logger.info(msg, meta),
    warn: (msg, meta) => logger.warn(msg, meta),
    error: (msg, meta) => logger.error(msg, meta),
    debug: (msg, meta) => logger.debug(msg, meta),
  };
}
