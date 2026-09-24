import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import yauzl from 'yauzl';
import { CatalogAcquisitionError } from './acquire.js';
import type { ReplayRecord } from './types.js';

export interface ExtractedReplay { replayId: string; path: string }

async function verifyExisting(path: string, replay: ReplayRecord, signal?: AbortSignal): Promise<boolean> {
  let stat;
  try { stat = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile() || stat.size !== replay.byteSize) throw new CatalogAcquisitionError('integrity');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    if (signal?.aborted) throw new CatalogAcquisitionError('cancelled');
    digest.update(chunk);
  }
  if (digest.digest('hex') !== replay.sha256) throw new CatalogAcquisitionError('integrity');
  return true;
}

export async function extractSelectedReplays(
  archivePath: string,
  replays: readonly ReplayRecord[],
  directory: string,
  signal?: AbortSignal,
): Promise<ExtractedReplay[]> {
  const requested = new Map(replays.map((replay) => [replay.zipEntryPath, replay]));
  if (requested.size !== replays.length || requested.has(undefined)) {
    throw new CatalogAcquisitionError('integrity');
  }
  const found = new Map<string, ExtractedReplay>();
  let zip: yauzl.ZipFile;
  try { zip = await yauzl.openPromise(archivePath, { lazyEntries: true, strictFileNames: true }); }
  catch { throw new CatalogAcquisitionError('integrity'); }
  try {
    if (zip.entryCount > 10_000) throw new CatalogAcquisitionError('integrity');
    for await (const entry of zip.eachEntry()) {
      if (signal?.aborted) throw new CatalogAcquisitionError('cancelled');
      const replay = requested.get(entry.fileName);
      if (!replay) continue;
      if (found.has(entry.fileName) || entry.uncompressedSize !== replay.byteSize ||
          entry.fileName.endsWith('/')) throw new CatalogAcquisitionError('integrity');
      const destination = join(directory, `${replay.sha256}.slp`);
      if (await verifyExisting(destination, replay, signal)) {
        found.set(entry.fileName, { replayId: replay.replayId, path: destination });
        continue;
      }
      const temp = join(directory, `.partial-${randomUUID()}`);
      try {
        const stream = await zip.openReadStreamPromise(entry);
        const file = await open(temp, 'wx', 0o600);
        const digest = createHash('sha256');
        let total = 0;
        try {
          for await (const chunk of stream) {
            if (signal?.aborted) throw new CatalogAcquisitionError('cancelled');
            total += chunk.length;
            if (total > replay.byteSize) throw new CatalogAcquisitionError('integrity');
            digest.update(chunk);
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await file.write(chunk, offset);
              if (bytesWritten === 0) throw new CatalogAcquisitionError('storage');
              offset += bytesWritten;
            }
          }
          await file.sync();
        } finally { await file.close(); }
        if (total !== replay.byteSize || digest.digest('hex') !== replay.sha256) {
          throw new CatalogAcquisitionError('integrity');
        }
        try { await link(temp, destination); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' ||
              !(await verifyExisting(destination, replay, signal))) throw error;
        }
        found.set(entry.fileName, { replayId: replay.replayId, path: destination });
      } finally { await rm(temp, { force: true }); }
    }
  } catch (error) {
    if (error instanceof CatalogAcquisitionError) throw error;
    if (['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EIO'].includes(
      (error as NodeJS.ErrnoException).code ?? '')) throw new CatalogAcquisitionError('storage');
    throw new CatalogAcquisitionError('integrity');
  } finally { zip.close(); }
  if (found.size !== replays.length) throw new CatalogAcquisitionError('integrity');
  return replays.map((replay) => found.get(replay.zipEntryPath!)!);
}
