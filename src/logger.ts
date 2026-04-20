// ============================================================
// Bybit Combo Bot — Logger (winston wrapper)
// ============================================================

import winston from 'winston';
import { Logger as BotLogger } from './types';

export function createLogger(level: string = 'info'): BotLogger {
  // Выделяем File-транспорты в отдельные переменные — чтобы повесить listener
  // на событие 'rotate' (Winston эмитит его при переполнении maxsize и переходе
  // к следующему файлу bot1.log / bot2.log / ...). См. README «Ротация логов».
  const botFileTransport = new winston.transports.File({
    filename: 'bot.log',
    maxsize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
  });
  const errorsFileTransport = new winston.transports.File({
    filename: 'errors.log',
    level: 'error',
    maxsize: 5 * 1024 * 1024,
    maxFiles: 3,
  });

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
      botFileTransport,
      errorsFileTransport,
    ],
  });

  // Уведомление о ротации — срабатывает когда Winston переполнил текущий файл
  // и перешёл на следующий (bot.log → bot1.log → bot2.log → ...). Запись пойдёт
  // уже в НОВЫЙ файл (transport уже переключился). Редкое событие (~раз в 10 MB).
  botFileTransport.on('rotate', (oldFilename: string, newFilename: string) => {
    logger.info(`📋 LOG ROTATED: ${oldFilename} заморожен, новые записи в ${newFilename}`);
  });
  errorsFileTransport.on('rotate', (oldFilename: string, newFilename: string) => {
    logger.info(`📋 ERRORS LOG ROTATED: ${oldFilename} → ${newFilename}`);
  });

  return {
    info: (msg, meta) => logger.info(msg, meta),
    warn: (msg, meta) => logger.warn(msg, meta),
    error: (msg, meta) => logger.error(msg, meta),
    debug: (msg, meta) => logger.debug(msg, meta),
  };
}
