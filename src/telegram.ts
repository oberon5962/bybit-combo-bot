// ============================================================
// Bybit Combo Bot — Telegram Notifications
// ============================================================
//
// Отправляет уведомления в Telegram через Bot API.
// Дублирует ключевые сообщения из лога: summary, сделки, алерты.
// ============================================================

import https from 'https';
import { TelegramConfig, Logger } from './types';

export class TelegramNotifier {
  private config: TelegramConfig;
  private log: Logger;
  private queue: string[] = [];
  private sending = false;
  private lastSummaryTick = 0;

  constructor(config: TelegramConfig, log: Logger) {
    this.config = config;
    this.log = log;
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  /** Send startup message with legend */
  sendStartup(mode: string, pairs: string): void {
    this.log.info(`Telegram: enabled=${this.config.enabled}, token=${this.config.botToken ? 'set' : 'empty'}, chatId=${this.config.chatId || 'empty'}`);
    if (!this.config.enabled) return;
    const text = [
      `🤖 <b>Bybit Combo Bot запущен</b>`,
      `Mode: <b>${mode}</b>`,
      `Pairs: ${pairs}`,
    ].join('\n');
    this.enqueue(text);
  }

  /** Send summary (throttled by summaryIntervalTicks) */
  sendSummary(currentTick: number, text: string): void {
    if (!this.config.enabled || !this.config.sendSummary) return;
    if (currentTick - this.lastSummaryTick < this.config.summaryIntervalTicks) return;
    this.lastSummaryTick = currentTick;
    this.enqueue(text);
  }

  /** Send trade fill notification */
  sendFill(text: string): void {
    if (!this.config.enabled || !this.config.sendFills) return;
    this.enqueue(text);
  }

  /** Send alert (SL/TP/halt/panic/cooldown) */
  sendAlert(text: string): void {
    if (!this.config.enabled || !this.config.sendAlerts) return;
    this.enqueue(text);
  }

  // ----------------------------------------------------------
  // Queue & Send
  // ----------------------------------------------------------

  private enqueue(text: string): void {
    this.queue.push(text);
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.sending || this.queue.length === 0) return;
    this.sending = true;

    while (this.queue.length > 0) {
      const text = this.queue.shift()!;
      try {
        await this.sendMessage(text);
        const short = text.replace(/<[^>]+>/g, '').replace(/\n/g, ' ').slice(0, 50);
        this.log.info(`Telegram sent: ${short}`);
      } catch (err) {
        this.log.error(`Telegram send failed: ${err}`);
      }
      // Rate limit: Telegram allows ~30 msg/sec, but we're conservative
      if (this.queue.length > 0) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    this.sending = false;
  }

  private sendMessage(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        chat_id: this.config.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });

      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${this.config.botToken}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 10000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`Telegram API ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Telegram request timeout')); });
      req.write(payload);
      req.end();
    });
  }
}
