#!/usr/bin/env node

import { Command } from 'commander';
import { TELEGRAM } from '../../config/app.config.js';
import { loginTelegram } from '../../platforms/telegram/TelegramLogin.js';
import { Credentials, DEFAULT_SESSION } from '../secrets/Credentials.js';
import { assertSessionName } from '../secrets/Vault.js';
import { print } from '../../shared/utils.js';

async function main() {
  const program = new Command()
    .name('login:telegram')
    .description('Log into Telegram via QR (default) and store the session in the encrypted vault.')
    .option('--qr', 'Use QR login (default)')
    .option('--phone', 'Use phone number and verification code instead of QR')
    .option('--session <name>', 'Session name referenced by accounts.json "session"', DEFAULT_SESSION)
    .parse();
  const options = program.opts();
  if (options.qr && options.phone) throw new Error('Choose either --qr or --phone.');
  assertSessionName(options.session);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Run npm run login:telegram in an interactive terminal to scan the QR code and enter 2FA if needed.');
  }
  const credentials = await Credentials.open({ interactive: true });
  if (!credentials.encrypted) {
    print('No encrypted vault yet: the session will be saved to the plaintext root .env. Run `npm run nyra -- vault init` to encrypt it.', 'warning');
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Telegram login cancelled.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const { session } = await loginTelegram({
      method: options.phone ? 'phone' : 'qr',
      config: { ...TELEGRAM, ...credentials.telegramApi() },
      signal: controller.signal,
    });
    await credentials.saveTelegramSession(options.session, session);
    print(`Telegram session "${options.session}" saved${credentials.encrypted ? ' to the encrypted vault' : ' to the root .env'}.`, 'success');
    if (options.session !== DEFAULT_SESSION) {
      print(`Reference it from Telegram accounts in accounts.json: "session": "${options.session}".`, 'info');
    }
    print('Ready for npm run scrape:telegram.', 'info');
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
