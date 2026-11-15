/**
 * Authenticated encryption for the local secrets vault.
 *
 * Key:    scrypt(master password, random salt) → 256-bit key
 * Cipher: AES-256-GCM with a fresh 96-bit IV for every write
 * AAD:    the envelope header, so tampering with KDF parameters is detected
 *
 * Only node:crypto is used; no third-party cryptography.
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

export const VAULT_FORMAT = 'eanyra-vault';
export const VAULT_VERSION = 1;

/** OWASP-recommended scrypt cost: ~128 MiB, a few hundred ms per unlock. */
export const DEFAULT_KDF = Object.freeze({ name: 'scrypt', N: 2 ** 17, r: 8, p: 1 });
const MIN_PASSWORD_LENGTH = 10;

export class VaultDecryptError extends Error {
  constructor(message = 'Wrong master password or the vault file is damaged.') {
    super(message);
    this.code = 'VAULT_DECRYPT_FAILED';
  }
}

export function assertPasswordStrength(password) {
  if (typeof password !== 'string' || password.normalize('NFKC').length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The master password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }
}

export function newKdfParams(base = DEFAULT_KDF) {
  return { ...base, salt: randomBytes(16).toString('base64') };
}

export async function deriveKey(password, kdf) {
  if (typeof password !== 'string' || !password) throw new Error('A master password is required.');
  if (kdf?.name !== 'scrypt') throw new Error(`Unsupported key derivation: ${kdf?.name}`);
  const { N, r, p } = kdf;
  if (![N, r, p].every(Number.isInteger) || N < 2 ** 14 || N > 2 ** 20 || r < 8 || p < 1) {
    throw new Error('Vault key derivation parameters are invalid.');
  }
  const salt = Buffer.from(kdf.salt, 'base64');
  if (salt.length < 16) throw new Error('Vault salt is invalid.');
  return scrypt(password.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * N * r + 32 * 1024 * 1024 });
}

function header(kdf) {
  return { format: VAULT_FORMAT, version: VAULT_VERSION, kdf, cipher: 'aes-256-gcm' };
}

function aad(head) {
  const { format, version, kdf, cipher } = head;
  return Buffer.from(JSON.stringify({ format, version, kdf, cipher }), 'utf8');
}

/** Encrypt a JSON-serializable value into a self-describing envelope. */
export function seal(key, kdf, value) {
  assertKey(key);
  const head = header(kdf);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(head));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    ...head,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/** Decrypt an envelope. Throws VaultDecryptError for a wrong key or any tampering. */
export function open(key, envelope) {
  assertKey(key);
  assertEnvelope(envelope);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(aad(envelope));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new VaultDecryptError();
  }
}

export function assertEnvelope(envelope) {
  if (!envelope || envelope.format !== VAULT_FORMAT) throw new Error('Not an EANyra vault file.');
  if (envelope.version !== VAULT_VERSION) throw new Error(`Unsupported vault version ${envelope.version}.`);
  if (envelope.cipher !== 'aes-256-gcm') throw new Error(`Unsupported vault cipher ${envelope.cipher}.`);
  for (const field of ['iv', 'tag', 'ciphertext']) {
    if (typeof envelope[field] !== 'string') throw new Error(`Vault file is missing ${field}.`);
  }
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Vault key must be 32 bytes.');
}
