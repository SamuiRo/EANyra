#!/usr/bin/env node

import { TELEGRAM } from '../../config/app.config.js';
import { TelegramClient } from '../../platforms/telegram/TelegramClient.js';
import { print } from '../../shared/utils.js';

async function main() {
  const client = new TelegramClient({
    ...TELEGRAM,
    interactiveLogin: true,
  });

  await client.connect();
  try {
    const session = client.getSessionString();
    if (!session) {
      throw new Error('Telegram did not return a session string.');
    }

    print('Telegram session generated. Store this value as TELEGRAM_SESSION in .env:', 'success');
    console.log(session);
    print('Session is ready for `npm run scrape:telegram`.', 'info');
  } finally {
    await client.disconnect();
  }
}

main().catch(error => {
  print(`Telegram login failed: ${error.message}`, 'error');
  process.exitCode = 1;
});
