/**
 * Two-stage shutdown on SIGINT / SIGTERM:
 *   1st signal → `graceful()` (finish the current step, save sessions, release locks)
 *   2nd signal, or `timeoutMs` elapsed → `process.exit(130)`
 *
 * @param {{ graceful: (signal: string) => Promise<void>, timeoutMs?: number,
 *           log?: (message: string) => void }} opts
 * @returns {() => void} removes the handlers
 */
export function onShutdown({ graceful, timeoutMs = 120_000, log = message => process.stderr.write(`${message}\n`) }) {
  let stopping = false;
  const handler = async signal => {
    if (stopping) {
      log('Forced stop.');
      process.exit(130);
    }
    stopping = true;
    log(`${signal}: stopping gracefully (sessions are saved, the current account finishes). Press Ctrl+C again to force.`);
    const timer = setTimeout(() => {
      log(`Graceful stop took longer than ${Math.round(timeoutMs / 1000)}s; forcing.`);
      process.exit(130);
    }, timeoutMs);
    timer.unref();
    try {
      await graceful(signal);
      process.exit(process.exitCode ?? 0);
    } catch (error) {
      log(`Stop failed: ${error.message}`);
      process.exit(1);
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.removeListener('SIGINT', handler);
    process.removeListener('SIGTERM', handler);
  };
}

/** setTimeout-based sleep that resolves early when `signal` aborts. */
export function abortableSleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
