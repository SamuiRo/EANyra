import { TELEGRAM } from '../../config/app.config.js';
import { sessionOf, DEFAULT_SESSION } from '../../config/accountConfig.js';
import { TelegramBotGateway } from './TelegramBotGateway.js';
import { TelegramClient } from './TelegramClient.js';
import { TelegramPublishGateway } from './TelegramPublishGateway.js';

/** The bot or MTProto session configured for one channel in accounts.json. */
export function buildGatewayFor(credentials, defaultTransport = TELEGRAM.publishTransport) {
  return entry => {
    const transport = entry.publish_transport ?? defaultTransport;
    if (!['bot', 'mtproto'].includes(transport)) throw new Error('Telegram publish transport must be bot or mtproto.');
    if (transport === 'bot') return new TelegramBotGateway({ token: credentials.botToken(entry.bot ?? DEFAULT_SESSION) });
    return new TelegramPublishGateway({ clientManager: new TelegramClient(credentials.telegramConfig(sessionOf(entry))) });
  };
}
