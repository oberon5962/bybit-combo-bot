// Запуск: npx ts-node restart-bot.ts
// Убивает все node-процессы бота (кроме себя), затем запускает бота заново.
//
// Поиск работающего бота:
//   tasklist /FI "IMAGENAME eq node.exe" /FO TABLE
//   wmic process where "name='node.exe'" get ProcessId,CommandLine
//
// Скрипт restart-bot.ts:
// Находит все node.exe процессы (кроме себя и своего ts-node родителя)
// Убивает их по PID
// Ждёт 1 секунду
// Запускает бота detached (в фоне)
// Выходит

import { execSync, spawn } from 'child_process';
import path from 'path';

const BOT_DIR = path.resolve(__dirname);
const selfPid = process.pid;
const parentPid = process.ppid; // ts-node parent

console.log('Stopping bot...');

try {
  const tasklist = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH', { encoding: 'utf-8' });
  const pids = tasklist.split('\n')
    .map(line => {
      const m = line.match(/"node\.exe","(\d+)"/);
      return m ? parseInt(m[1]) : 0;
    })
    .filter(pid => pid > 0 && pid !== selfPid && pid !== parentPid);

  if (pids.length === 0) {
    console.log('  No running bot found');
  }
  for (const pid of pids) {
    try {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      console.log(`  Killed PID ${pid}`);
    } catch { /* already dead */ }
  }
} catch {
  console.log('  Could not list processes, trying taskkill...');
  try {
    execSync('taskkill /F /IM node.exe', { stdio: 'ignore' });
  } catch { /* no processes */ }
}

// Small delay to let ports/files release
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);

console.log('Starting bot...');
const child = spawn('npx', ['ts-node', 'src/index.ts'], {
  cwd: BOT_DIR,
  detached: true,
  stdio: 'ignore',
  shell: true,
});
child.unref();

console.log(`Bot started (PID: ${child.pid})`);
console.log('Check: tail -5 bot.log');
process.exit(0);
