import QRCode from 'qrcode';
import { TELEGRAM } from '../../config/app.config.js';
import { createMTProtoClient, closeMTProtoClient, validateTelegramApiConfig } from './TelegramClient.js';
import { askSecret, askText } from '../../shared/prompt.js';

export function telegramLoginUrl(token) {
  if (!token || !Buffer.from(token).length) throw new Error('Telegram returned an empty QR login token.');
  return `tg://login?token=${Buffer.from(token).toString('base64url')}`;
}

export async function renderTelegramQr({ token }, output = process.stdout) {
  const image = await QRCode.toString(telegramLoginUrl(token), { type: 'terminal', small: true });
  output.write(`\n${image}\n`);
}

export async function loginTelegram({
  method = 'qr', config = TELEGRAM, signal,
  createClient = createMTProtoClient,
  renderQr = renderTelegramQr,
  readPassword = hint => askSecret(`2FA password${hint ? ` (${hint})` : ''}: `, { signal }),
  readPhone = () => askText('Phone number (+country code): ', { signal }),
  readCode = () => askSecret('Verification code: ', { signal }),
  log = message => process.stdout.write(`${message}\n`),
} = {}) {
  if (!['qr', 'phone'].includes(method)) throw new Error('Telegram login method must be qr or phone.');
  validateTelegramApiConfig(config);
  signal?.throwIfAborted();
  // Login and runtime use the same device identity, but a login starts fresh.
  const client = await createClient({ ...config, session: '' });
  try {
    signal?.throwIfAborted();
    await abortable(client.connect(), signal);
    signal?.throwIfAborted();
    const credentials = { apiId: config.apiId, apiHash: config.apiHash };
    const passwordParams = {
      password: hint => { signal?.throwIfAborted(); return readPassword(hint); },
      onError: async error => {
        log(`Telegram authentication error: ${error.errorMessage ?? error.message}`);
        // A mistyped 2FA password may be retried; other failures stop auth.
        return error.errorMessage !== 'PASSWORD_HASH_INVALID';
      },
    };
    let user;
    if (method === 'qr') {
      log('Telegram on your phone: Settings > Devices > Link Desktop Device. Scan the QR code.');
      log('The QR code refreshes automatically. No login code is needed. Press Ctrl+C to cancel.');
      user = await abortable(client.signInUserWithQrCode(credentials, {
        ...passwordParams,
        qrCode: async qr => {
          signal?.throwIfAborted();
          await renderQr(qr);
        },
      }), signal);
    } else {
      user = await abortable(client.signInUser(credentials, {
        ...passwordParams, phoneNumber: readPhone, phoneCode: readCode,
      }), signal);
    }
    signal?.throwIfAborted();
    if (!await abortable(client.checkAuthorization(), signal)) {
      throw new Error('Telegram did not confirm authorization. The session was not saved.');
    }
    const session = client.session.save();
    if (!session) throw new Error('Telegram did not return an authorized session.');
    return { session, user };
  } finally {
    await closeMTProtoClient(client);
  }
}

function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
