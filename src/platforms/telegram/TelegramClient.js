import os from 'os';
import readline from 'readline/promises';

import { PKG, TELEGRAM } from '../../config/app.config.js';
import { print } from '../../shared/utils.js';

export class TelegramClient {
  constructor(config = TELEGRAM) {
    this.config      = config;
    this.client      = null;
    this.isConnected = false;
  }

  async connect() {
    if (this.isConnected && this.client) return this.client;

    this.#validateConfig();

    const { MTProtoClient, StringSession } = await loadGramJs();
    const session = new StringSession(this.config.session ?? '');

    this.client = new MTProtoClient(
      session,
      this.config.apiId,
      this.config.apiHash,
      {
        deviceModel:       `${PKG.name}@${os.hostname()}`,
        systemVersion:     os.version() || 'unknown',
        appVersion:        PKG.version,
        useWSS:            true,
        testServers:       false,
        connectionRetries: this.config.connectionRetries,
      },
    );

    print('[Telegram] Connecting via MTProto...', 'system');
    await this.client.start({
      phoneNumber: () => this.#readCredential('Phone number: '),
      password:    () => this.#readCredential('Password (if enabled): '),
      phoneCode:   () => this.#readCredential('Verification code: '),
      onError:     error => {
        print(`[Telegram] Authentication error: ${error.message}`, 'error');
      },
    });

    this.isConnected = true;
    print('[Telegram] MTProto client connected.', 'success');

    return this.client;
  }

  getSessionString() {
    return this.client?.session?.save?.() ?? '';
  }

  async disconnect() {
    if (!this.client || !this.isConnected) return;
    await this.client.disconnect();
    this.isConnected = false;
    print('[Telegram] MTProto client disconnected.', 'system');
  }

  #validateConfig() {
    if (!this.config.apiId || !this.config.apiHash) {
      throw new Error(
        'TELEGRAM_API_ID and TELEGRAM_API_HASH are required for Telegram scraping.',
      );
    }

    if (!this.config.session && !this.config.interactiveLogin) {
      throw new Error(
        'TELEGRAM_SESSION is not set. Run `npm run login:telegram` to generate one, ' +
        'then save the printed session string in .env.',
      );
    }
  }

  async #readCredential(label) {
    if (!this.config.interactiveLogin) {
      throw new Error(
        'Telegram session is missing or expired. Run `npm run login:telegram` ' +
        'to generate a fresh TELEGRAM_SESSION.',
      );
    }

    const rl = readline.createInterface({
      input:  process.stdin,
      output: process.stdout,
    });

    try {
      return await rl.question(label);
    } finally {
      rl.close();
    }
  }
}

async function loadGramJs() {
  try {
    const [{ TelegramClient: MTProtoClient }, { StringSession }] = await Promise.all([
      import('telegram'),
      import('telegram/sessions/index.js'),
    ]);
    return { MTProtoClient, StringSession };
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'The "telegram" package is required for Telegram scraping. Run `npm install` first.',
      );
    }
    throw error;
  }
}
