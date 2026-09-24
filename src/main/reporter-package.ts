import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import yauzl from 'yauzl';

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 512;
const MAX_REPLAYS = 256;
const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_REPLAY_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;

export interface ReporterReplay {
  path: string;
  hash: string;
  size: number;
  archivePath: string;
  entryPath: string;
}

interface EntryDescriptor {
  fileName: string;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
}

interface PackageManifest {
  context: EntryDescriptor;
  replays: EntryDescriptor[];
  byName: Map<string, EntryDescriptor>;
}

function invalid(): Error { return new Error('The replay package is invalid or exceeds supported limits.'); }

function normalizedEntryName(name: string): string {
  const normalized = name.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\/$/, '');
  if (!normalized || normalized.length > 512 || normalized.startsWith('/') ||
      normalized.includes('\\') || /[\x00-\x1f\x7f:]/.test(normalized)) throw invalid();
  const parts = normalized.split('/');
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..' ||
    part.endsWith(' ') || part.endsWith('.') || part.length > 240 ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw invalid();
  return normalized;
}

function checkEntry(entry: yauzl.Entry): EntryDescriptor {
  normalizedEntryName(entry.fileName);
  const unixMode = entry.externalFileAttributes >>> 16;
  const fileType = unixMode & 0xf000;
  // ZIP members may carry Unix symlinks or Windows reparse points; neither belongs in a replay package.
  if (fileType === 0xa000 || (entry.externalFileAttributes & 0x400) !== 0) throw invalid();
  if (!Number.isSafeInteger(entry.compressedSize) || !Number.isSafeInteger(entry.uncompressedSize) ||
      entry.compressedSize < 0 || entry.uncompressedSize < 0 ||
      (entry.compressedSize === 0 && entry.uncompressedSize !== 0) ||
      (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO)) throw invalid();
  return {
    fileName: entry.fileName, compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize, crc32: entry.crc32,
  };
}

function sameEntry(actual: yauzl.Entry, expected: EntryDescriptor): boolean {
  return actual.fileName === expected.fileName && actual.compressedSize === expected.compressedSize &&
    actual.uncompressedSize === expected.uncompressedSize && actual.crc32 === expected.crc32;
}

async function inspect(zipPath: string): Promise<PackageManifest> {
  const zip = await yauzl.openPromise(zipPath, { lazyEntries: true, strictFileNames: true });
  try {
    if (zip.entryCount > MAX_ENTRIES) throw invalid();
    const byName = new Map<string, EntryDescriptor>();
    const normalized = new Set<string>();
    const replays: EntryDescriptor[] = [];
    let context: EntryDescriptor | undefined;
    let total = 0;
    for await (const entry of zip.eachEntry()) {
      const descriptor = checkEntry(entry);
      const key = normalizedEntryName(entry.fileName);
      if (normalized.has(key)) throw invalid();
      normalized.add(key);
      if (entry.fileName.endsWith('/')) continue;
      total += entry.uncompressedSize;
      if (total > MAX_TOTAL_UNCOMPRESSED) throw invalid();
      if (entry.fileName === 'context.json') {
        if (entry.uncompressedSize === 0 || entry.uncompressedSize > MAX_CONTEXT_BYTES) throw invalid();
        await readBoundedContext(zip, entry);
        context = descriptor;
      } else if (entry.fileName.toLowerCase().endsWith('.slp')) {
        if (entry.uncompressedSize === 0 || entry.uncompressedSize > MAX_REPLAY_BYTES ||
            replays.length >= MAX_REPLAYS) throw invalid();
        replays.push(descriptor);
      } else {
        throw invalid();
      }
      byName.set(entry.fileName, descriptor);
    }
    if (!context || !replays.length) throw invalid();
    return { context, replays, byName };
  } finally { zip.close(); }
}

async function readBoundedContext(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<void> {
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_CONTEXT_BYTES) {
      stream.destroy();
      throw invalid();
    }
    chunks.push(chunk);
  }
  let context: unknown;
  try { context = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw invalid(); }
  if (typeof context !== 'object' || context === null || Array.isArray(context)) throw invalid();
}

async function extractReplay(zip: yauzl.ZipFile, entry: yauzl.Entry, directory: string): Promise<ReporterReplay & { created: boolean }> {
  const temporary = join(directory, `.reporter-${randomUUID()}.partial`);
  const stream = await zip.openReadStreamPromise(entry);
  const file = await open(temporary, 'wx', 0o600);
  const digest = createHash('sha256');
  let total = 0;
  try {
    try {
      for await (const chunk of stream) {
        total += chunk.length;
        if (total > MAX_REPLAY_BYTES || total > entry.uncompressedSize) {
          stream.destroy();
          throw invalid();
        }
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await file.write(chunk, offset);
          if (bytesWritten === 0) throw new Error('Could not write the replay package.');
          offset += bytesWritten;
        }
      }
      await file.sync();
    } finally { await file.close(); }
    if (total !== entry.uncompressedSize) throw invalid();
    const hash = digest.digest('hex');
    const destination = join(directory, `${hash}.slp`);
    let created = false;
    try { await link(temporary, destination); created = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await lstat(destination);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== total) throw invalid();
      const verify = createHash('sha256');
      for await (const chunk of createReadStream(destination)) verify.update(chunk);
      if (verify.digest('hex') !== hash) throw invalid();
    }
    return { path: destination, hash, size: total, archivePath: '', entryPath: entry.fileName, created };
  } finally { await rm(temporary, { force: true }); }
}

export async function extractReporterPackage(archivePath: string, managedDir: string): Promise<ReporterReplay[]> {
  const archiveBefore = await stat(archivePath);
  if (!archiveBefore.isFile() || archiveBefore.size === 0 || archiveBefore.size > MAX_ARCHIVE_BYTES) throw invalid();
  await mkdir(managedDir, { recursive: true });
  const directory = resolve(managedDir);
  const destinationStat = await lstat(directory);
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink() ||
      (await realpath(directory)).toLocaleLowerCase('en-US') !== directory.toLocaleLowerCase('en-US')) throw invalid();
  const manifest = await inspect(archivePath);
  const zip = await yauzl.openPromise(archivePath, { lazyEntries: true, strictFileNames: true });
  const extracted: Array<ReporterReplay & { created: boolean }> = [];
  const seen = new Set<string>();
  try {
    for await (const entry of zip.eachEntry()) {
      const descriptor = checkEntry(entry);
      const expected = manifest.byName.get(entry.fileName);
      if (entry.fileName.endsWith('/')) continue;
      if (!expected || !sameEntry(entry, expected) || seen.has(entry.fileName)) throw invalid();
      seen.add(entry.fileName);
      if (entry.fileName === manifest.context.fileName) await readBoundedContext(zip, entry);
      else extracted.push(await extractReplay(zip, entry, directory));
    }
    if (seen.size !== manifest.byName.size || extracted.length !== manifest.replays.length) throw invalid();
    const archiveAfter = await stat(archivePath);
    if (archiveAfter.size !== archiveBefore.size || archiveAfter.mtimeMs !== archiveBefore.mtimeMs ||
        archiveAfter.ctimeMs !== archiveBefore.ctimeMs) throw new Error('The replay package changed during import.');
    return extracted.map(({ created: _created, ...replay }) => ({ ...replay, archivePath }));
  } catch (error) {
    const cleanup = await Promise.allSettled(extracted.filter((replay) => replay.created)
      .map((replay) => rm(replay.path, { force: true })));
    const failures = cleanup.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError([error, ...failures.map((result) => result.reason)],
      'Could not clean up an invalid replay package.');
    throw error;
  } finally { zip.close(); }
}
