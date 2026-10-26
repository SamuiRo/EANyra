import readline from 'node:readline/promises';
import { Writable } from 'node:stream';

export async function askText(query, { input = process.stdin, output = process.stdout, signal } = {}) {
  const rl = readline.createInterface({ input, output, terminal: false });
  const controller = cancelOnClose(rl);
  try {
    return String(await rl.question(query, { signal: combineSignals(signal, controller.signal) })).trim();
  } finally {
    rl.close();
  }
}

export async function askSecret(query, { input = process.stdin, output = process.stdout, signal } = {}) {
  let muted = false;
  const gate = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding);
      callback();
    },
  });
  const rl = readline.createInterface({ input, output: gate, terminal: true });
  const controller = cancelOnClose(rl);
  try {
    const pending = rl.question(query, { signal: combineSignals(signal, controller.signal) });
    muted = true;
    return String(await pending);
  } finally {
    rl.close();
    gate.end();
    output.write('\n');
  }
}

function cancelOnClose(rl) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Terminal input cancelled.'));
  rl.once('SIGINT', cancel);
  rl.once('close', cancel);
  return controller;
}

function combineSignals(external, local) {
  return external ? AbortSignal.any([external, local]) : local;
}
