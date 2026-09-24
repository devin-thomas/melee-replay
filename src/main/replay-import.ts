import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { ParsedReplay } from './parse-worker';

export function parseReplayInWorker(filePath: string): Promise<ParsedReplay> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'parse-worker.js'), { workerData: filePath });
    let settled = false;
    worker.once('message', (message: { ok: boolean; result?: ParsedReplay; error?: string }) => {
      settled = true;
      void worker.terminate();
      if (message.ok && message.result) resolve(message.result);
      else reject(new Error(message.error || 'Replay parsing failed.'));
    });
    worker.once('error', (error) => {
      if (!settled) { settled = true; reject(error); }
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`Replay parser exited unexpectedly (${code}).`));
    });
  });
}
