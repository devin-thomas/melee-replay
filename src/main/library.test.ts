import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { Library } from './library';
import type { ParsedReplay } from './parse-worker';

const temporary: string[] = [];

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'melee-library-test-'));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function replay(bytes: Buffer): ParsedReplay {
  return {
    hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
    playerA: 'A', playerB: 'B', characterA: 'Fox', characterB: 'Marth',
    stage: 'Battlefield', playedAt: null, slpVersion: '3.0.0', lastFrame: 100,
  };
}

test('history persists and interrupted sessions recover without losing exposure', async () => {
  const root = await workspace();
  const file = join(root, 'library.sqlite');
  const attemptId = randomUUID();
  const itemId = randomUUID();
  const replayId = randomUUID();
  const first = await Library.open(file);
  first.createAttempt(attemptId, itemId, 'revision-1');
  first.markAttemptStarted(attemptId);
  first.recordExposure(attemptId, 'sample-hash', 'uncertain');
  first.recordExposure(attemptId, 'sample-hash', 'confirmed');
  first.recordNaturalCompletion(attemptId, replayId, 'entrantA');
  first.close();

  const recovered = await Library.open(file);
  expect(recovered.attempts()).toEqual([expect.objectContaining({
    attemptId, itemId, revision: 'revision-1', status: 'interrupted',
    startedAt: expect.any(String), endedAt: expect.any(String),
  })]);
  expect(recovered.exposures()).toEqual([{ exposureKey: 'sample-hash', certainty: 'confirmed' }]);
  const secondId = randomUUID();
  recovered.createAttempt(secondId, itemId, 'revision-2');
  recovered.markAttemptStarted(secondId);
  recovered.finishAttempt(secondId, 'completed');
  expect(recovered.attempts().find((item) => item.attemptId === secondId)?.status).toBe('completed');
  recovered.close();

  const db = new Database(file, { readonly: true });
  expect(db.prepare('SELECT COUNT(*) AS count FROM natural_completions').get()).toEqual({ count: 1 });
  db.close();
});

test('v1 migration makes a backup and retains attempts and exposure', async () => {
  const root = await workspace();
  const file = join(root, 'library.sqlite');
  const attemptId = randomUUID();
  const itemId = randomUUID();
  const db = new Database(file);
  db.exec(`
    CREATE TABLE replays (id TEXT PRIMARY KEY, hash TEXT UNIQUE, size INTEGER,
      player_a TEXT, player_b TEXT, character_a TEXT, character_b TEXT,
      stage TEXT, played_at TEXT, slp_version TEXT, imported_at TEXT);
    CREATE TABLE locations (path TEXT PRIMARY KEY, replay_id TEXT REFERENCES replays(id),
      ownership TEXT, last_verified_at TEXT);
    CREATE TABLE attempts (id TEXT PRIMARY KEY, item_id TEXT, requested_at TEXT,
      started_at TEXT, ended_at TEXT, status TEXT);
    CREATE TABLE exposures (attempt_id TEXT REFERENCES attempts(id), replay_hash TEXT,
      started_at TEXT, PRIMARY KEY (attempt_id, replay_hash));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    PRAGMA user_version = 1;
  `);
  db.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?)')
    .run(attemptId, itemId, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:01.000Z',
      '2020-01-01T00:00:02.000Z', 'completed');
  db.prepare('INSERT INTO exposures VALUES (?, ?, ?)')
    .run(attemptId, 'legacy-hash', '2020-01-01T00:00:01.000Z');
  db.close();

  const library = await Library.open(file);
  expect(library.attempts()).toEqual([expect.objectContaining({
    attemptId, itemId, revision: 'legacy', status: 'completed',
  })]);
  expect(library.exposures()).toEqual([{ exposureKey: 'legacy-hash', certainty: 'confirmed' }]);
  library.close();
  const backup = new Database(`${file}.before-v2-backup`, { readonly: true });
  expect(backup.pragma('user_version', { simple: true })).toBe(1);
  backup.close();
});

test('verifiedPath rejects a same-size replay replacement', async () => {
  const root = await workspace();
  const file = join(root, 'library.sqlite');
  const replayFile = join(root, 'local.slp');
  const bytes = Buffer.from('first replay bytes');
  await writeFile(replayFile, bytes);
  const data = replay(bytes);
  const library = await Library.open(file);
  library.addReference(replayFile, data);
  expect(await library.verifiedPath(data.hash)).toBe(replayFile);
  expect(library.list()[0].available).toBe(true);
  await writeFile(replayFile, Buffer.from('other replay bytes'));
  expect((await readFile(replayFile)).length).toBe(bytes.length);
  expect(await library.verifiedPath(data.hash)).toBeNull();
  expect(library.list()[0].available).toBe(false);
  await writeFile(replayFile, bytes);
  await library.refreshAvailability();
  expect(library.list()[0].available).toBe(true);
  expect(await readFile(replayFile)).toEqual(bytes);
  library.close();
});

test('startup rechecks all saved locations and retains history when files change', async () => {
  const root = await workspace();
  const file = join(root, 'library.sqlite');
  const firstPath = join(root, 'first.slp');
  const secondPath = join(root, 'second.slp');
  const bytes = Buffer.from('first replay bytes');
  const changed = Buffer.from('other replay bytes');
  await writeFile(firstPath, bytes);
  await writeFile(secondPath, bytes);
  const data = replay(bytes);
  const attemptId = randomUUID();
  const library = await Library.open(file);
  library.addReference(firstPath, data);
  library.addReference(secondPath, data);
  library.createAttempt(attemptId, randomUUID(), 'revision-1');
  library.markAttemptStarted(attemptId);
  library.recordExposure(attemptId, data.hash, 'confirmed');
  library.finishAttempt(attemptId, 'completed');
  library.close();

  await writeFile(firstPath, changed);
  const reopened = await Library.open(file);
  expect(reopened.list()[0].available).toBe(true);
  expect(await reopened.verifiedPath(data.hash)).toBe(secondPath);
  await writeFile(secondPath, changed);
  await reopened.refreshAvailability();
  expect(reopened.list()[0].available).toBe(false);
  expect(reopened.attempts()[0]).toEqual(expect.objectContaining({ attemptId, status: 'completed' }));
  expect(reopened.exposures()).toEqual([{ exposureKey: data.hash, certainty: 'confirmed' }]);
  reopened.close();
  const final = await Library.open(file);
  expect(final.list()[0].available).toBe(false);
  final.close();
});

test('recovery distinguishes preflight from a requested replay launch', async () => {
  const root = await workspace();
  const file = join(root, 'library.sqlite');
  const itemId = randomUUID();
  const preflightId = randomUUID();
  const launchId = randomUUID();
  const library = await Library.open(file);
  library.createAttempt(preflightId, itemId, 'revision-1');
  library.createAttempt(launchId, itemId, 'revision-1');
  library.markLaunchRequested(launchId, 'replay-exposure-key');
  library.close();

  const recovered = await Library.open(file);
  expect(recovered.attempts().map((attempt) => attempt.status)).toEqual(['interrupted', 'interrupted']);
  expect(recovered.exposures()).toEqual([
    { exposureKey: 'replay-exposure-key', certainty: 'uncertain' },
  ]);
  recovered.close();
});

test('confirmed start clears pending launch and local source provenance stays backstage', async () => {
  const root = await workspace();
  const file = join(root, 'library.sqlite');
  const replayFile = join(root, 'local.slp');
  const bytes = Buffer.from('first replay bytes');
  await writeFile(replayFile, bytes);
  const data = replay(bytes);
  const attemptId = randomUUID();
  const library = await Library.open(file);
  library.addReference(replayFile, data, 'managed');
  library.recordManagedProvenance(data.hash, join(root, 'source.zip'), 'replays/game.slp');
  library.createAttempt(attemptId, randomUUID(), 'revision-1');
  library.markLaunchRequested(attemptId, data.hash);
  library.markAttemptStarted(attemptId);
  library.recordExposure(attemptId, data.hash, 'confirmed');
  library.close();

  const recovered = await Library.open(file);
  expect(recovered.exposures()).toEqual([{ exposureKey: data.hash, certainty: 'confirmed' }]);
  expect(JSON.stringify(recovered.list())).not.toContain('source.zip');
  recovered.close();
  const db = new Database(file, { readonly: true });
  expect(db.prepare('SELECT COUNT(*) AS count FROM pending_launches').get()).toEqual({ count: 0 });
  expect(db.prepare('SELECT archive_path AS archivePath, entry_path AS entryPath FROM managed_replay_sources').get())
    .toEqual({ archivePath: join(root, 'source.zip'), entryPath: 'replays/game.slp' });
  db.close();
});

test('removing an imported replay from the index retains source bytes and practice history', async () => {
  const root = await workspace();
  const file = join(root, 'library.sqlite');
  const replayFile = join(root, 'original.slp');
  const bytes = Buffer.from('original replay bytes');
  const data = replay(bytes);
  const attemptId = randomUUID();
  await writeFile(replayFile, bytes);

  const library = await Library.open(file);
  const replayId = library.addReference(replayFile, data);
  library.createAttempt(attemptId, replayId, data.hash);
  library.markAttemptStarted(attemptId);
  library.finishAttempt(attemptId, 'completed');
  library.removeFromIndex(replayId);
  expect(library.list()).toEqual([]);
  expect(library.replayIdentity(replayId)).toEqual({ hash: data.hash, size: data.size });
  expect(library.attempts()[0]).toEqual(expect.objectContaining({ attemptId, itemId: replayId }));
  expect(await readFile(replayFile)).toEqual(bytes);
  library.close();

  const reopened = await Library.open(file);
  expect(reopened.list()).toEqual([]);
  expect(reopened.addReference(replayFile, data)).toBe(replayId);
  expect(reopened.list()).toEqual([expect.objectContaining({ id: replayId })]);
  reopened.close();
});

test('relink requires matching bytes and preserves the original replay identity', async () => {
  const root = await workspace();
  const file = join(root, 'library.sqlite');
  const original = join(root, 'original.slp');
  const replacement = join(root, 'replacement.slp');
  const moved = join(root, 'moved.slp');
  const originalBytes = Buffer.from('original replay bytes');
  const replacementBytes = Buffer.from('different replay data');
  const data = replay(originalBytes);
  await writeFile(original, originalBytes);
  await writeFile(replacement, replacementBytes);
  await writeFile(moved, originalBytes);

  const library = await Library.open(file);
  const replayId = library.addReference(original, data);
  await writeFile(original, replacementBytes);
  await library.refreshAvailability();
  expect(library.list()[0].available).toBe(false);
  expect(() => library.relinkReference(replayId, replacement, replay(replacementBytes)))
    .toThrow('does not match the original replay');
  expect(library.list()[0].available).toBe(false);
  library.relinkReference(replayId, moved, data);
  expect(await library.verifiedPath(data.hash)).toBe(moved);
  expect(library.list()[0]).toEqual(expect.objectContaining({ id: replayId, available: true }));
  expect(await readFile(moved)).toEqual(originalBytes);
  library.close();
});
