import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Library } from './library';
import { clearDownloadCache, managedStorage } from './managed-storage';
import type { ParsedReplay } from './parse-worker';

const temporary: string[] = [];

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function replay(bytes: Buffer): ParsedReplay {
  return {
    hash: hash(bytes), size: bytes.length, playerA: 'A', playerB: 'B',
    characterA: 'Fox', characterB: 'Marth', stage: 'Battlefield',
    playedAt: null, slpVersion: '3.0.0', lastFrame: 100,
  };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('cache cleanup only removes approved unreferenced archives and retains records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'melee-managed-storage-test-'));
  temporary.push(root);
  const managed = join(root, 'managed');
  const catalog = join(managed, 'catalog-assets');
  const reporter = join(managed, 'reporter');
  await mkdir(catalog, { recursive: true });
  await mkdir(reporter);
  const cachedBytes = Buffer.from('reclaimable archive');
  const protectedBytes = Buffer.from('protected archive');
  const unknownBytes = Buffer.from('unknown archive');
  const replayBytes = Buffer.from('playable replay');
  const cache = join(catalog, `${hash(cachedBytes)}.zip`);
  const protectedArchive = join(catalog, `${hash(protectedBytes)}.zip`);
  const unknown = join(catalog, `${hash(unknownBytes)}.zip`);
  const playable = join(catalog, `${hash(replayBytes)}.slp`);
  const original = join(root, 'original.slp');
  const reporterReplay = join(reporter, `${hash(replayBytes)}.slp`);
  await Promise.all([
    writeFile(cache, cachedBytes), writeFile(protectedArchive, protectedBytes),
    writeFile(unknown, unknownBytes), writeFile(playable, replayBytes),
    writeFile(original, replayBytes), writeFile(reporterReplay, replayBytes),
  ]);

  const library = await Library.open(join(root, 'library.sqlite'));
  const replayId = library.addReference(original, replay(replayBytes));
  library.addReference(playable, replay(replayBytes), 'managed');
  library.recordManagedProvenance(hash(replayBytes), protectedArchive, 'original.slp');
  const attemptId = randomUUID();
  library.createAttempt(attemptId, replayId, hash(replayBytes));
  library.markAttemptStarted(attemptId);
  library.recordExposure(attemptId, hash(replayBytes), 'confirmed');
  library.finishAttempt(attemptId, 'completed');
  const approved = new Set([`${hash(cachedBytes)}.zip`, `${hash(protectedBytes)}.zip`]);
  const before = await managedStorage(managed, approved, library.protectedManagedPaths());
  expect(before.downloadCacheBytes).toBe(cachedBytes.length);
  expect(before.totalBytes).toBe(cachedBytes.length + protectedBytes.length + unknownBytes.length +
    replayBytes.length * 2);
  expect(await clearDownloadCache(managed, approved, library.protectedManagedPaths()))
    .toBe(cachedBytes.length);
  expect(await readFile(cache).catch(() => null)).toBeNull();
  expect(await readFile(protectedArchive)).toEqual(protectedBytes);
  expect(await readFile(unknown)).toEqual(unknownBytes);
  expect(await readFile(playable)).toEqual(replayBytes);
  expect(await readFile(reporterReplay)).toEqual(replayBytes);
  expect(await readFile(original)).toEqual(replayBytes);
  expect(library.attempts()[0]).toEqual(expect.objectContaining({ attemptId, status: 'completed' }));
  expect(library.exposures()).toEqual([{ exposureKey: hash(replayBytes), certainty: 'confirmed' }]);
  expect(library.protectedManagedPaths()).toContain(protectedArchive);
  library.close();

  const reopened = await Library.open(join(root, 'library.sqlite'));
  expect(reopened.attempts()[0].attemptId).toBe(attemptId);
  expect(reopened.protectedManagedPaths()).toContain(protectedArchive);
  expect(await managedStorage(managed, approved, reopened.protectedManagedPaths()))
    .toEqual({ totalBytes: before.totalBytes - cachedBytes.length, downloadCacheBytes: 0 });
  reopened.close();
});

test('absent managed storage is empty and clears nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'melee-managed-storage-test-'));
  temporary.push(root);
  const managed = join(root, 'managed');
  expect(await managedStorage(managed, new Set(), [])).toEqual({ totalBytes: 0, downloadCacheBytes: 0 });
  expect(await clearDownloadCache(managed, new Set(), [])).toBe(0);
});
