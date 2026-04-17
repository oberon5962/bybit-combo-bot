// ============================================================
// Bybit Combo Bot — Telegram Notifications & Commands
// ============================================================
//
// Отправляет уведомления в Telegram через Bot API.
// Дублирует ключевые сообщения из лога: summary, сделки, алерты.
// Принимает команды от пользователя через getUpdates polling.
// ============================================================

import https from 'https';
import { TelegramConfig, Logger } from './types';

export interface TelegramCommand {
  command: string;    // e.g. 'status', 'buy', 'stop'
  args: string;       // e.g. 'SUI/USDT 10' or ''
  chatId: string;
  messageId: number;
  confirmed?: boolean; // true = user clicked Да via inline keyboard
}

export class TelegramNotifier {
  private config: TelegramConfig;
  private log: Logger;
  private queue: string[] = [];
  private sending = false;
  private lastSummaryTick = 0;
  private lastUpdateId = 0;
  private apiHostname: string;
  private apiPort: number;
  private processedCallbackIds: Set<string> = new Set(); // dedup against double-click on inline buttons
  private processedCallbackOrder: string[] = []; // FIFO to cap Set size

  constructor(config: TelegramConfig, log: Logger) {
    this.config = config;
    this.log = log;
    const parsed = this.parseApiUrl(config.telegramApiUrl);
    this.apiHostname = parsed.hostname;
    this.apiPort = parsed.port;
  }

  getLastUpdateId(): number { return this.lastUpdateId; }
  setLastUpdateId(id: number): void { this.lastUpdateId = id; }
  updateConfig(config: TelegramConfig): void {
    this.config = config;
    const parsed = this.parseApiUrl(config.telegramApiUrl);
    this.apiHostname = parsed.hostname;
    this.apiPort = parsed.port;
  }

  private parseApiUrl(url: string): { hostname: string; port: number } {
    if (!url) return { hostname: 'api.telegram.org', port: 443 };
    try {
      const u = new URL(url.startsWith('http') ? url : `https://${url}`);
      return { hostname: u.hostname, port: u.port ? Number(u.port) : 443 };
    } catch {
      return { hostname: 'api.telegram.org', port: 443 };
    }
  }

  // ----------------------------------------------------------
  // Public API — Notifications
  // ----------------------------------------------------------

  /** Send startup message with legend */
  sendStartup(mode: string, pairs: string): void {
    this.log.info(`Telegram: enabled=${this.config.enabled}, token=${this.config.botToken ? 'set' : 'empty'}, chatId=${this.config.chatId || 'empty'}, api=${this.apiHostname}`);
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

  /** Send reply to a command — always sends if telegram is enabled (ignores sendSummary/sendFills/sendAlerts flags) */
  sendReply(text: string): void {
    if (!this.config.enabled) return;
    this.enqueue(text);
  }

  /** Send /buy currency selection menu: buttons with base tickers + [Другая] + [Ввести вручную] */
  sendBuyMenu(currencies: string[]): void {
    if (!this.config.enabled) return;
    const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
    // 4 per row
    for (let i = 0; i < currencies.length; i += 4) {
      buttons.push(currencies.slice(i, i + 4).map(c => ({ text: c, callback_data: `buymenu:${c}` })));
    }
    buttons.push([
      { text: '🔤 Другая', callback_data: 'buyother' },
      { text: '✏️ Ввести вручную', callback_data: 'buycustom' },
    ]);
    buttons.push([{ text: '❌ Отмена', callback_data: 'cancel' }]);
    const payload = JSON.stringify({
      chat_id: this.config.chatId,
      text: '🛒 Выбери валюту для покупки:',
      reply_markup: { inline_keyboard: buttons },
    });
    this.sendRaw(payload);
  }

  /** Send /freezebuy currency menu. frozen[] marks already-blocked bases with 🧊 icon. */
  sendFreezeMenu(currencies: string[], frozen: string[]): void {
    if (!this.config.enabled) return;
    const fzSet = new Set(frozen.map(c => c.toUpperCase()));
    const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < currencies.length; i += 4) {
      buttons.push(currencies.slice(i, i + 4).map(c => ({
        text: fzSet.has(c.toUpperCase()) ? `${c} 🧊` : c,
        callback_data: `freezemenu:${c}`,
      })));
    }
    buttons.push([{ text: '❌ Отмена', callback_data: 'cancel' }]);
    const payload = JSON.stringify({
      chat_id: this.config.chatId,
      text: '🧊 Выбери валюту для заморозки покупок:',
      reply_markup: { inline_keyboard: buttons },
    });
    this.sendRaw(payload);
  }

  /** Send /sellgrid currency menu. active[] marks already-enabled bases with 🔻 icon. */
  sendSellGridMenu(currencies: string[], active: string[]): void {
    if (!this.config.enabled) return;
    const actSet = new Set(active.map(c => c.toUpperCase()));
    const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < currencies.length; i += 4) {
      buttons.push(currencies.slice(i, i + 4).map(c => ({
        text: actSet.has(c.toUpperCase()) ? `${c} 🔻` : c,
        callback_data: `sellgridmenu:${c}`,
      })));
    }
    buttons.push([{ text: '❌ Отмена', callback_data: 'cancel' }]);
    const payload = JSON.stringify({
      chat_id: this.config.chatId,
      text: '🔻 Выбери валюту для sellgrid-режима (ladder распродажи):',
      reply_markup: { inline_keyboard: buttons },
    });
    this.sendRaw(payload);
  }

  /** Send /unsellgrid menu — only currencies with active sellgrid. */
  sendUnsellGridMenu(active: string[]): void {
    if (!this.config.enabled) return;
    if (active.length === 0) {
      this.sendReply('Нет активных sellgrid-режимов.');
      return;
    }
    const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < active.length; i += 4) {
      buttons.push(active.slice(i, i + 4).map(c => ({ text: c, callback_data: `unsellgridmenu:${c}` })));
    }
    buttons.push([{ text: '❌ Отмена', callback_data: 'cancel' }]);
    const payload = JSON.stringify({
      chat_id: this.config.chatId,
      text: '✅ Выбери валюту для отключения sellgrid:',
      reply_markup: { inline_keyboard: buttons },
    });
    this.sendRaw(payload);
  }

  /** Send /unfreezebuy menu — only frozen currencies. */
  sendUnfreezeMenu(frozen: string[]): void {
    if (!this.config.enabled) return;
    if (frozen.length === 0) {
      this.sendReply('Нет замороженных валют.');
      return;
    }
    const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < frozen.length; i += 4) {
      buttons.push(frozen.slice(i, i + 4).map(c => ({ text: c, callback_data: `unfreezemenu:${c}` })));
    }
    buttons.push([{ text: '❌ Отмена', callback_data: 'cancel' }]);
    const payload = JSON.stringify({
      chat_id: this.config.chatId,
      text: '✅ Выбери валюту для разморозки:',
      reply_markup: { inline_keyboard: buttons },
    });
    this.sendRaw(payload);
  }

  /** Send /buy amount selection menu: preset USDT amounts + Отмена */
  sendBuyAmountMenu(currency: string, presets: number[]): void {
    if (!this.config.enabled) return;
    const row = presets.map(n => ({ text: `$${n}`, callback_data: `buysum:${currency}:${n}` }));
    const payload = JSON.stringify({
      chat_id: this.config.chatId,
      text: `🛒 <b>${currency}</b> — сколько USDT потратить?`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          row,
          [{ text: '❌ Отмена', callback_data: 'cancel' }],
        ],
      },
    });
    this.sendRaw(payload);
  }

  /** Send reply with inline keyboard [Да] [Нет] for confirmation */
  sendConfirmation(text: string, callbackData: string): void {
    if (!this.config.enabled) return;
    const fullData = `confirm:${callbackData}`;
    if (Buffer.byteLength(fullData, 'utf-8') > 64) {
      this.sendReply('⚠️ Слишком длинная команда для подтверждения. Сократите аргументы.');
      return;
    }
    const payload = JSON.stringify({
      chat_id: this.config.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Да', callback_data: fullData },
          { text: '❌ Нет', callback_data: 'cancel' },
        ]],
      },
    });
    this.sendRaw(payload);
  }

  // ----------------------------------------------------------
  // Public API — Command Polling
  // ----------------------------------------------------------

  /** Poll Telegram for new commands. Returns parsed commands from configured chatId only. */
  async pollCommands(): Promise<TelegramCommand[]> {
    if (!this.config.enabled) return [];

    try {
      const updates = await this.getUpdates();
      const commands: TelegramCommand[] = [];

      for (const update of updates) {
        // Track offset to avoid re-processing
        if (update.update_id >= this.lastUpdateId) {
          this.lastUpdateId = update.update_id + 1;
        }

        // Handle callback_query (inline keyboard button press)
        const cb = update.callback_query;
        if (cb) {
          const cbChatId = String(cb.message?.chat?.id ?? '');
          if (cbChatId !== this.config.chatId) continue;

          // Dedup: guard against double-click producing two identical callbacks
          if (this.processedCallbackIds.has(cb.id)) {
            this.answerCallbackQuery(cb.id);
            continue;
          }
          this.processedCallbackIds.add(cb.id);
          this.processedCallbackOrder.push(cb.id);
          if (this.processedCallbackOrder.length > 200) {
            const evicted = this.processedCallbackOrder.shift();
            if (evicted) this.processedCallbackIds.delete(evicted);
          }

          // Answer callback to remove "loading" spinner
          this.answerCallbackQuery(cb.id);

          const data = cb.data ?? '';
          if (data === 'cancel') {
            this.sendReply('❌ Отменено');
            continue;
          }
          // /buy wizard steps — emitted as internal commands (names prefixed with _)
          if (data.startsWith('buymenu:')) {
            commands.push({ command: '_buymenu', args: data.substring('buymenu:'.length), chatId: cbChatId, messageId: cb.message?.message_id ?? 0, confirmed: true });
            continue;
          }
          if (data.startsWith('buysum:')) {
            commands.push({ command: '_buysum', args: data.substring('buysum:'.length), chatId: cbChatId, messageId: cb.message?.message_id ?? 0, confirmed: true });
            continue;
          }
          if (data === 'buycustom') {
            commands.push({ command: '_buycustom', args: '', chatId: cbChatId, messageId: cb.message?.message_id ?? 0, confirmed: true });
            continue;
          }
          if (data === 'buyother') {
            commands.push({ command: '_buyother', args: '', chatId: cbChatId, messageId: cb.message?.message_id ?? 0, confirmed: true });
            continue;
          }
          if (data.startsWith('freezemenu:')) {
            commands.push({ command: '_freezemenu', args: data.substring('freezemenu:'.length), chatId: cbChatId, messageId: cb.message?.message_id ?? 0, confirmed: true });
            continue;
          }
          if (data.startsWith('unfreezemenu:')) {
            commands.push({ command: '_unfreezemenu', args: data.substring('unfreezemenu:'.length), chatId: cbChatId, messageId: cb.message?.message_id ?? 0, confirmed: true });
            continue;
          }
          if (data.startsWith('sellgridmenu:')) {
            commands.push({ command: '_sellgridmenu', args: data.substring('sellgridmenu:'.length), chatId: cbChatId, messageId: cb.message?.message_id ?? 0, confirmed: true });
            continue;
          }
          if (data.startsWith('unsellgridmenu:')) {
            commands.push({ command: '_unsellgridmenu', args: data.substring('unsellgridmenu:'.length), chatId: cbChatId, messageId: cb.message?.message_id ?? 0, confirmed: true });
            continue;
          }
          if (data.startsWith('confirm:')) {
            // Check confirmation timeout
            const msgDate = cb.message?.date ?? 0; // unix seconds
            const timeoutSec = this.config.confirmationTimeoutSec;
            if (timeoutSec > 0 && msgDate > 0) {
              const ageSec = Math.floor(Date.now() / 1000) - msgDate;
              if (ageSec > timeoutSec) {
                this.sendReply(`⏰ Подтверждение устарело (${ageSec}с > ${timeoutSec}с). Повторите команду.`);
                continue;
              }
            }
            // Parse "confirm:command:args"
            const payload = data.substring('confirm:'.length);
            const colonIdx = payload.indexOf(':');
            const command = colonIdx > 0 ? payload.substring(0, colonIdx) : payload;
            const args = colonIdx > 0 ? payload.substring(colonIdx + 1) : '';
            commands.push({
              command,
              args,
              chatId: cbChatId,
              messageId: cb.message?.message_id ?? 0,
              confirmed: true,
            });
          }
          continue;
        }

        const msg = update.message;
        if (!msg || !msg.text) continue;

        const chatId = String(msg.chat?.id ?? '');

        // Security: only accept commands from configured chatId
        if (chatId !== this.config.chatId) {
          this.log.warn(`Telegram: ignoring message from unknown chat ${chatId}`);
          continue;
        }

        const text = msg.text.trim();
        if (!text.startsWith('/')) continue;

        // Parse: /command args
        const spaceIdx = text.indexOf(' ');
        const command = (spaceIdx > 0 ? text.substring(1, spaceIdx) : text.substring(1)).toLowerCase();
        const args = spaceIdx > 0 ? text.substring(spaceIdx + 1).trim() : '';

        // Strip @botname suffix (e.g. /status@MyBot → status)
        const atIdx = command.indexOf('@');
        const cleanCommand = atIdx > 0 ? command.substring(0, atIdx) : command;

        commands.push({
          command: cleanCommand,
          args,
          chatId,
          messageId: msg.message_id ?? 0,
        });
      }

      return commands;
    } catch (err) {
      this.log.error(`Telegram pollCommands failed: ${err}`);
      return [];
    }
  }

  // ----------------------------------------------------------
  // Telegram API — setMyCommands
  // ----------------------------------------------------------

  registerCommands(): void {
    const commands = [
      { command: 'start', description: 'Cписок команд' },
      { command: 'status', description: 'Сводка: капитал, PnL, позиции' },
      { command: 'stats', description: 'Статистика торговли по парам' },
      { command: 'orders', description: 'Открытые ордера' },
      { command: 'stop', description: 'Остановить торговлю' },
      { command: 'run', description: 'Возобновить торговлю' },
      { command: 'regrid', description: 'Перестройка торговой сетки со сбросом ордеров' },
      { command: 'freezebuy', description: 'Заморозить покупки по валюте: /freezebuy XRP' },
      { command: 'unfreezebuy', description: 'Разморозить покупки: /unfreezebuy XRP' },
      { command: 'sellgrid', description: 'Распродать валюту + freezebuy: /sellgrid XRP' },
      { command: 'unsellgrid', description: 'Перестать распродавать валюту + unfreezebuy: /unsellgrid XRP' },
      { command: 'cancelorders', description: 'Отменить все ордера + остановить бота' },
      { command: 'buy', description: 'Купить кол-во валюты за USDT: /buy SUI USDT 10' },
      { command: 'sellall', description: 'Продать всё + cancelorders' }
    ];

    const payload = JSON.stringify({ commands });
    const options = {
      hostname: this.apiHostname,
      port: this.apiPort,
      path: `/bot${this.config.botToken}/setMyCommands`,
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
          this.log.info('Telegram: commands menu registered');
        } else {
          this.log.error(`Telegram setMyCommands failed: ${res.statusCode} ${data.slice(0, 200)}`);
        }
      });
    });

    req.on('error', (err) => { this.log.error(`Telegram setMyCommands error: ${err}`); });
    req.on('timeout', () => { req.destroy(); this.log.error('Telegram setMyCommands timeout'); });
    req.write(payload);
    req.end();
  }

  // ----------------------------------------------------------
  // Telegram API — getUpdates
  // ----------------------------------------------------------

  private getUpdates(): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        timeout: '0',
        allowed_updates: JSON.stringify(['message', 'callback_query']),
      });
      if (this.lastUpdateId > 0) {
        params.set('offset', String(this.lastUpdateId));
      }

      const options = {
        hostname: this.apiHostname,
        port: this.apiPort,
        path: `/bot${this.config.botToken}/getUpdates?${params.toString()}`,
        method: 'GET',
        timeout: 5000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok && Array.isArray(parsed.result)) {
              resolve(parsed.result);
            } else {
              reject(new Error(`Telegram getUpdates: ${data.slice(0, 200)}`));
            }
          } catch (e) {
            reject(new Error(`Telegram getUpdates parse error: ${e}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Telegram getUpdates timeout')); });
      req.end();
    });
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
        hostname: this.apiHostname,
        port: this.apiPort,
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

  /** Send raw JSON payload to sendMessage (for inline keyboards etc.) */
  private sendRaw(payload: string): void {
    const options = {
      hostname: this.apiHostname,
      port: this.apiPort,
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
        if (res.statusCode !== 200) {
          this.log.error(`Telegram sendRaw failed: ${res.statusCode} ${data.slice(0, 200)}`);
        }
      });
    });

    req.on('error', (err) => { this.log.error(`Telegram sendRaw error: ${err}`); });
    req.on('timeout', () => { req.destroy(); this.log.error('Telegram sendRaw timeout'); });
    req.write(payload);
    req.end();
  }

  /** Answer callback query to remove loading spinner on inline button */
  private answerCallbackQuery(callbackQueryId: string): void {
    const payload = JSON.stringify({ callback_query_id: callbackQueryId });
    const options = {
      hostname: this.apiHostname,
      port: this.apiPort,
      path: `/bot${this.config.botToken}/answerCallbackQuery`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 5000,
    };

    const req = https.request(options, () => {});
    req.on('error', () => {});
    req.write(payload);
    req.end();
  }
}
