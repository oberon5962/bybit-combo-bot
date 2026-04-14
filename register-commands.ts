// One-time script: register Telegram bot command menu
import { loadConfig } from './src/config';
import { TelegramNotifier } from './src/telegram';
import { createLogger } from './src/logger';

const log = createLogger('info');
const config = loadConfig();
const tg = new TelegramNotifier(config.telegram, log);
tg.registerCommands();
console.log('setMyCommands sent — check bot.log for result');
