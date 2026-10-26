import { fork } from 'node:child_process';

export class TelegramPublishRequests {
  constructor({ spawn = fork, timeoutMs = 30000 } = {}) {
    this.spawn = spawn;
    this.timeoutMs = timeoutMs;
    this.children = new Set();
  }

  execute(operation, args = {}) {
    if (this.children.size >= 4) throw new Error('Too many Telegram publication requests. Wait for an existing request to finish.');
    return new Promise((resolve, reject) => {
      // GramJS and CLI database logging stay in a child process, away from MCP stdout.
      const child = this.spawn(new URL('./telegramPublishWorker.js', import.meta.url), [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, execArgv: [],
      });
      this.children.add(child);
      let outcome;
      let finished = false;
      const finish = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.children.delete(child);
        if (error || outcome?.error) reject(new Error(outcome?.error ?? error));
        else resolve(outcome.result);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish('Telegram publication worker timed out. Use telegram_post_get with the same request_id to inspect durable state. Never create a new request to retry an uncertain publication blindly.');
      }, this.timeoutMs);
      child.on('message', message => { outcome = message; });
      child.once('error', error => finish(error.message));
      child.once('exit', code => finish(code === 0 && outcome ? null : 'Telegram publication worker stopped. Inspect telegram_post_get before retrying.'));
      try {
        child.send({ operation, args }, error => {
          if (error) { child.kill(); finish(error.message); }
        });
      } catch (error) {
        child.kill();
        finish(error.message);
      }
    });
  }

  close() {
    for (const child of this.children) child.kill();
  }
}
