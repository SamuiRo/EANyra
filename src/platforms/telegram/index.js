import { TelegramScraper } from './TelegramScraper.js';

export { TelegramClient } from './TelegramClient.js';
export { TelegramScraper } from './TelegramScraper.js';
export {
  buildTelegramMessageUrl,
  isTelegramContentMessage,
  normalizeTelegramChannel,
  normalizeTelegramDate,
  parseTelegramMessage,
} from './TelegramMessageParser.js';

export const PLATFORM_ID = 'telegram';
export const displayName = 'Telegram';

export function createScraper(options) {
  return new TelegramScraper(options);
}
