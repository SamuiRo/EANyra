import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { PATHS } from '../../config/app.config.js';

export function updateTelegramSessionEnv(raw, session) {
  if (typeof session !== 'string' || !/^[A-Za-z0-9+/=_-]+$/.test(session)) {
    throw new Error('Telegram returned an invalid session string.');
  }
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const output = [];
  let replaced = false;
  for (const line of lines) {
    if (/^[\t ]*(?:export[\t ]+)?TELEGRAM_SESSION[\t ]*=/.test(line)) {
      if (!replaced) output.push(`TELEGRAM_SESSION=${session}`);
      replaced = true;
    } else {
      output.push(line);
    }
  }
  if (!replaced) {
    if (output.at(-1) === '') output.pop();
    output.push(`TELEGRAM_SESSION=${session}`, '');
  }
  const updated = output.join(newline);
  const before = dotenv.parse(raw);
  const after = dotenv.parse(updated);
  for (const [key, value] of Object.entries(before)) {
    if (key !== 'TELEGRAM_SESSION' && after[key] !== value) {
      throw new Error('Cannot update TELEGRAM_SESSION without changing other environment values.');
    }
  }
  if (after.TELEGRAM_SESSION !== session) throw new Error('Could not validate the saved Telegram session.');
  return updated;
}

export async function saveTelegramSession(session, envFile = PATHS.envFile) {
  const raw = await fs.readFile(envFile, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const updated = updateTelegramSessionEnv(raw, session);
  const temporary = `${envFile}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, updated, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, envFile);
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return envFile;
}
