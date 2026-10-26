#!/usr/bin/env node

import { Command } from 'commander';
import { loginTelegram } from '../../platforms/telegram/TelegramLogin.js';
import { saveTelegramSession } from '../../platforms/telegram/sessionEnv.js';
import { print } from '../../shared/utils.js';

async function main() {
  const program = new Command()
    .name('login:telegram')
    .description('Log into Telegram via QR (default) and save TELEGRAM_SESSION to the root .env.')
    .option('--qr', 'Use QR login (default)')
    .option('--phone', 'Use phone number and verification code instead of QR')
    .parse();
  const options = program.opts();
  if (options.qr && options.phone) throw new Error('Choose either --qr or --phone.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Run npm run login:telegram in an interactive terminal to scan the QR code and enter 2FA if needed.');
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Telegram login cancelled.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const { session } = await loginTelegram({ method: options.phone ? 'phone' : 'qr', signal: controller.signal });
    const filename = await saveTelegramSession(session);
    print(`Telegram session saved to ${filename}.`, 'success');
    print('Ready for npm run scrape:telegram. Restart running MCP/daemon processes to load the session.', 'info');
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

main().catch(error => {
  print(`Telegram login failed: ${error.message}`, 'error');
  process.exitCode = 1;
}).finally(() => {
  // GramJS QR polling can leave an outstanding refresh timer after cancellation.
  // Network cleanup has finished; do not keep a cancelled login alive for it.
  process.exit(process.exitCode ?? 0);
});
