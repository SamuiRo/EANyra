import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export function loadInstanceEnvironment(projectRoot, env = process.env) {
  const envFile = path.join(projectRoot, '.env');
  const loaded = dotenv.config({ path: envFile, processEnv: env });
  if (loaded.error && loaded.error.code !== 'ENOENT') throw loaded.error;
  const instanceDir = path.resolve(projectRoot, env.INSTANCE_DIR || 'instance');
  // Keep worker selection stable, including when INSTANCE_DIR came from .env.
  env.INSTANCE_DIR = instanceDir;
  return { envFile, instanceDir };
}

export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const selected = loadInstanceEnvironment(PROJECT_ROOT);
export const INSTANCE_DIR = selected.instanceDir;
export const INSTANCE_ENV_PATH = selected.envFile;

export function instancePath(name, fallback) {
  const raw = process.env[name];
  return raw ? path.resolve(INSTANCE_DIR, raw) : fallback;
}
