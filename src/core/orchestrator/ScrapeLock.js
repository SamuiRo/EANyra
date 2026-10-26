import fs from 'node:fs/promises';
import path from 'node:path';
import { DB } from '../../config/app.config.js';

export async function acquireScrapeLock(lockPath = `${DB.storagePath}.scrape.lock`, { isAlive = isProcessAlive } = {}) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!await reclaimStaleLock(lockPath, isAlive)) {
      throw new Error(`Another scrape is running. Lock: ${lockPath}. If the process crashed, remove this file after verifying no scraper is running.`);
    }
    try {
      handle = await fs.open(lockPath, 'wx');
    } catch (retryError) {
      if (retryError.code === 'EEXIST') throw new Error(`Another scrape is running. Lock: ${lockPath}.`);
      throw retryError;
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  } catch (error) {
    await handle.close();
    await fs.unlink(lockPath);
    throw error;
  }
  return async () => {
    await handle.close();
    await fs.unlink(lockPath);
  };
}

// Removes the lock only when its recorded owner process no longer exists.
// A missing or unreadable owner is never reclaimed: the owner may still be
// writing it. A separate guard keeps two reclaimers from deleting each
// other's fresh lock.
async function reclaimStaleLock(lockPath, isAlive) {
  const guardPath = `${lockPath}.reclaim`;
  let guard;
  try {
    guard = await fs.open(guardPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    let owner;
    try {
      owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    } catch (error) {
      // The previous owner released it in the meantime.
      return error.code === 'ENOENT';
    }
    if (!Number.isInteger(owner?.pid) || owner.pid < 1 || isAlive(owner.pid)) return false;
    await fs.unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return true;
  } finally {
    await guard.close();
    await fs.unlink(guardPath);
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return error.code !== 'ESRCH';
  }
}
