import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { assertOpaqueId, type AttemptRecord, type ExposureRecord, type ScoreEffect } from '../core/models';
import type { ParsedReplay } from './parse-worker';

export interface LocalReplay {
  id: string;
  hash: string;
  size: number;
  playerA: string;
  playerB: string;
  characterA: string;
  characterB: string;
  stage: string;
  playedAt: string | null;
  slpVersion: string;
  available: boolean;
}

type ReplayRow = Omit<LocalReplay, 'available'>;
type AttemptRow = {
  id: string; itemId: string; revision: string; requestedAt: string;
  startedAt: string | null; endedAt: string | null;
  status: 'preparing' | 'started' | 'completed' | 'interrupted' | 'failed';
};
type LocationRow = { path: string; replayId: string; hash: string; size: number };

function now(): string { return new Date().toISOString(); }

function assertHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid replay hash.');
}

function assertExposureKey(exposureKey: string): void {
  if (!exposureKey || exposureKey.length > 128 || /[\x00-\x1f\x7f]/.test(exposureKey)) {
    throw new Error('Invalid exposure identity.');
  }
}

function inaccessible(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' ||
    code === 'EPERM' || code === 'EBUSY';
}

export class Library {
  private closed = false;
  private constructor(private readonly db: Database.Database) {}

  static async open(filePath: string): Promise<Library> {
    await mkdir(dirname(filePath), { recursive: true });
    const existed = existsSync(filePath);
    const db = new Database(filePath);
    try {
      const version = db.pragma('user_version', { simple: true }) as number;
      if (version > 5) throw new Error('Library was created by a newer version of Melee Replay.');
      if (version < 1) {
        if (existed) await db.backup(`${filePath}.before-v1-backup`);
        db.transaction(() => {
          db.exec(`
            CREATE TABLE replays (
              id TEXT PRIMARY KEY,
              hash TEXT NOT NULL UNIQUE,
              size INTEGER NOT NULL,
              player_a TEXT NOT NULL,
              player_b TEXT NOT NULL,
              character_a TEXT NOT NULL,
              character_b TEXT NOT NULL,
              stage TEXT NOT NULL,
              played_at TEXT,
              slp_version TEXT NOT NULL,
              imported_at TEXT NOT NULL
            );
            CREATE TABLE locations (
              path TEXT PRIMARY KEY,
              replay_id TEXT NOT NULL REFERENCES replays(id),
              ownership TEXT NOT NULL CHECK (ownership IN ('referenced', 'managed')),
              last_verified_at TEXT NOT NULL
            );
            CREATE TABLE attempts (
              id TEXT PRIMARY KEY,
              item_id TEXT NOT NULL,
              requested_at TEXT NOT NULL,
              started_at TEXT,
              ended_at TEXT,
              status TEXT NOT NULL CHECK (status IN ('preparing', 'started', 'completed', 'interrupted', 'failed'))
            );
            CREATE TABLE exposures (
              attempt_id TEXT NOT NULL REFERENCES attempts(id),
              replay_hash TEXT NOT NULL,
              started_at TEXT NOT NULL,
              PRIMARY KEY (attempt_id, replay_hash)
            );
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            PRAGMA user_version = 1;
          `);
        })();
      }
      if (version < 2) {
        if (existed) await db.backup(`${filePath}.before-v2-backup`);
        db.pragma('foreign_keys = OFF');
        try {
          db.transaction(() => {
            db.exec(`
              CREATE TABLE attempts_v2 (
                id TEXT PRIMARY KEY,
                item_id TEXT NOT NULL,
                revision TEXT NOT NULL,
                requested_at TEXT NOT NULL,
                started_at TEXT,
                ended_at TEXT,
                status TEXT NOT NULL CHECK (status IN ('preparing', 'started', 'completed', 'interrupted', 'failed'))
              );
              INSERT INTO attempts_v2
                SELECT id, item_id, 'legacy', requested_at, started_at, ended_at, status FROM attempts;
              CREATE TABLE exposures_v2 (
                attempt_id TEXT NOT NULL REFERENCES attempts_v2(id),
                exposure_key TEXT NOT NULL,
                certainty TEXT NOT NULL CHECK (certainty IN ('confirmed', 'uncertain')),
                started_at TEXT NOT NULL,
                PRIMARY KEY (attempt_id, exposure_key)
              );
              INSERT INTO exposures_v2
                SELECT attempt_id, replay_hash, 'confirmed', started_at FROM exposures;
              DROP TABLE exposures;
              DROP TABLE attempts;
              ALTER TABLE attempts_v2 RENAME TO attempts;
              ALTER TABLE exposures_v2 RENAME TO exposures;
              CREATE TABLE natural_completions (
                attempt_id TEXT NOT NULL REFERENCES attempts(id),
                replay_id TEXT NOT NULL,
                score_effect TEXT NOT NULL CHECK (score_effect IN ('none', 'entrantA', 'entrantB')),
                completed_at TEXT NOT NULL,
                PRIMARY KEY (attempt_id, replay_id)
              );
              PRAGMA user_version = 2;
            `);
          })();
        } finally {
          db.pragma('foreign_keys = ON');
        }
      }
      if (version < 3) {
        if (existed) await db.backup(`${filePath}.before-v3-backup`);
        db.transaction(() => {
          db.exec(`
            ALTER TABLE locations ADD COLUMN verification_state TEXT NOT NULL DEFAULT 'unchecked'
              CHECK (verification_state IN ('unchecked', 'valid', 'invalid'));
            PRAGMA user_version = 3;
          `);
        })();
      }
      if (version < 4) {
        if (existed) await db.backup(`${filePath}.before-v4-backup`);
        db.transaction(() => {
          db.exec(`
            CREATE TABLE pending_launches (
              attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
              exposure_key TEXT NOT NULL,
              requested_at TEXT NOT NULL
            );
            CREATE TABLE managed_replay_sources (
              replay_hash TEXT NOT NULL REFERENCES replays(hash),
              archive_path TEXT NOT NULL,
              entry_path TEXT NOT NULL,
              imported_at TEXT NOT NULL,
              PRIMARY KEY (replay_hash, archive_path, entry_path)
            );
            PRAGMA user_version = 4;
          `);
        })();
      }
      if (version < 5) {
        if (existed) await db.backup(`${filePath}.before-v5-backup`);
        db.transaction(() => {
          db.exec(`
            ALTER TABLE replays ADD COLUMN indexed INTEGER NOT NULL DEFAULT 1
              CHECK (indexed IN (0, 1));
            PRAGMA user_version = 5;
          `);
        })();
      }
      db.pragma('foreign_keys = ON');
      if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Library migration failed integrity check.');
      db.pragma('journal_mode = WAL');
      db.transaction(() => {
        db.exec(`INSERT INTO exposures (attempt_id, exposure_key, certainty, started_at)
          SELECT pending_launches.attempt_id, pending_launches.exposure_key, 'uncertain', pending_launches.requested_at
          FROM pending_launches JOIN attempts ON attempts.id = pending_launches.attempt_id
          WHERE attempts.status IN ('preparing', 'started')
          ON CONFLICT(attempt_id, exposure_key) DO UPDATE SET certainty =
            CASE WHEN exposures.certainty = 'confirmed' THEN 'confirmed' ELSE 'uncertain' END`);
        db.exec('DELETE FROM pending_launches');
        db.prepare("UPDATE attempts SET status = 'interrupted', ended_at = ? WHERE status IN ('preparing', 'started')")
          .run(now());
      })();
      const library = new Library(db);
      await library.refreshAvailability();
      return library;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  addReference(filePath: string, replay: ParsedReplay, ownership: 'referenced' | 'managed' = 'referenced'): string {
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM replays WHERE hash = ?').get(replay.hash) as { id: string } | undefined;
      const id = existing?.id || randomUUID();
      if (!existing) {
        this.db.prepare(`INSERT INTO replays
          (id, hash, size, player_a, player_b, character_a, character_b, stage, played_at, slp_version, imported_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, replay.hash, replay.size, replay.playerA, replay.playerB, replay.characterA,
            replay.characterB, replay.stage, replay.playedAt, replay.slpVersion, new Date().toISOString());
      }
      else this.db.prepare('UPDATE replays SET indexed = 1 WHERE id = ?').run(id);
      this.db.prepare(`INSERT INTO locations (path, replay_id, ownership, last_verified_at, verification_state)
        VALUES (?, ?, ?, ?, 'unchecked')
        ON CONFLICT(path) DO UPDATE SET replay_id = excluded.replay_id,
          ownership = excluded.ownership, last_verified_at = excluded.last_verified_at,
          verification_state = 'unchecked'`)
        .run(filePath, id, ownership, new Date().toISOString());
      return id;
    })();
  }

  replayIdentity(replayId: string): { hash: string; size: number } | null {
    assertOpaqueId(replayId);
    return this.db.prepare('SELECT hash, size FROM replays WHERE id = ?')
      .get(replayId) as { hash: string; size: number } | undefined || null;
  }

  removeFromIndex(replayId: string): void {
    assertOpaqueId(replayId);
    const changed = this.db.prepare('UPDATE replays SET indexed = 0 WHERE id = ? AND indexed = 1')
      .run(replayId);
    if (changed.changes !== 1) throw new Error('Replay is not in the library index.');
  }

  relinkReference(replayId: string, filePath: string, replay: ParsedReplay): void {
    assertOpaqueId(replayId);
    const identity = this.replayIdentity(replayId);
    if (!identity) throw new Error('Replay is not in the library index.');
    if (replay.hash !== identity.hash || replay.size !== identity.size) {
      throw new Error('That file does not match the original replay. Choose the original replay bytes.');
    }
    const linkedId = this.addReference(filePath, replay);
    if (linkedId !== replayId) throw new Error('Replay identity changed while relinking.');
  }

  createAttempt(attemptId: string, itemId: string, revision: string): void {
    assertOpaqueId(attemptId);
    assertOpaqueId(itemId);
    if (!revision || revision.length > 256) throw new Error('Invalid item revision.');
    this.db.prepare(`INSERT INTO attempts (id, item_id, revision, requested_at, status)
      VALUES (?, ?, ?, ?, 'preparing')`).run(attemptId, itemId, revision, now());
  }

  markAttemptStarted(attemptId: string): void {
    assertOpaqueId(attemptId);
    const result = this.db.prepare(`UPDATE attempts SET status = 'started', started_at = ?
      WHERE id = ? AND status = 'preparing'`).run(now(), attemptId);
    if (result.changes !== 1) throw new Error('Attempt could not be started.');
  }

  markLaunchRequested(attemptId: string, exposureKey: string): void {
    assertOpaqueId(attemptId);
    assertExposureKey(exposureKey);
    this.db.transaction(() => {
      const pending = this.db.prepare('SELECT exposure_key AS exposureKey FROM pending_launches WHERE attempt_id = ?')
        .get(attemptId) as { exposureKey: string } | undefined;
      if (pending) {
        if (pending.exposureKey !== exposureKey) throw new Error('Another replay launch is pending.');
        return;
      }
      const result = this.db.prepare(`INSERT INTO pending_launches (attempt_id, exposure_key, requested_at)
        SELECT id, ?, ? FROM attempts WHERE id = ? AND status IN ('preparing', 'started')`)
        .run(exposureKey, now(), attemptId);
      if (result.changes !== 1) throw new Error('Attempt cannot launch a replay.');
    })();
  }

  recordExposure(attemptId: string, exposureKey: string, certainty: 'confirmed' | 'uncertain'): void {
    assertOpaqueId(attemptId);
    assertExposureKey(exposureKey);
    if (certainty !== 'confirmed' && certainty !== 'uncertain') throw new Error('Invalid exposure certainty.');
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO exposures (attempt_id, exposure_key, certainty, started_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(attempt_id, exposure_key) DO UPDATE SET certainty =
          CASE WHEN excluded.certainty = 'confirmed' THEN 'confirmed' ELSE exposures.certainty END`)
        .run(attemptId, exposureKey, certainty, now());
      this.db.prepare('DELETE FROM pending_launches WHERE attempt_id = ? AND exposure_key = ?')
        .run(attemptId, exposureKey);
    })();
  }

  recordNaturalCompletion(attemptId: string, replayId: string, scoreEffect: ScoreEffect): void {
    assertOpaqueId(attemptId);
    assertOpaqueId(replayId);
    if (!['none', 'entrantA', 'entrantB'].includes(scoreEffect)) throw new Error('Invalid score effect.');
    this.db.prepare(`INSERT OR IGNORE INTO natural_completions
      (attempt_id, replay_id, score_effect, completed_at) VALUES (?, ?, ?, ?)`)
      .run(attemptId, replayId, scoreEffect, now());
  }

  finishAttempt(attemptId: string, outcome: 'completed' | 'interrupted' | 'failed'): void {
    assertOpaqueId(attemptId);
    if (!['completed', 'interrupted', 'failed'].includes(outcome)) throw new Error('Invalid attempt outcome.');
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO exposures (attempt_id, exposure_key, certainty, started_at)
        SELECT attempt_id, exposure_key, 'uncertain', requested_at FROM pending_launches
        WHERE attempt_id = ?
        ON CONFLICT(attempt_id, exposure_key) DO UPDATE SET certainty =
          CASE WHEN exposures.certainty = 'confirmed' THEN 'confirmed' ELSE 'uncertain' END`)
        .run(attemptId);
      this.db.prepare('DELETE FROM pending_launches WHERE attempt_id = ?').run(attemptId);
      const result = this.db.prepare(`UPDATE attempts SET status = ?, ended_at = ?
        WHERE id = ? AND status IN ('preparing', 'started')`).run(outcome, now(), attemptId);
      if (result.changes !== 1) throw new Error('Attempt could not be finished.');
    })();
  }

  recordManagedProvenance(replayHash: string, archivePath: string, entryPath: string): void {
    assertHash(replayHash);
    if (!archivePath || !entryPath || /[\x00-\x1f\x7f]/.test(archivePath + entryPath)) {
      throw new Error('Invalid replay source identity.');
    }
    this.db.prepare(`INSERT INTO managed_replay_sources
      (replay_hash, archive_path, entry_path, imported_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(replay_hash, archive_path, entry_path) DO NOTHING`)
      .run(replayHash, archivePath, entryPath, now());
  }

  protectedManagedPaths(): string[] {
    const locations = this.db.prepare('SELECT path FROM locations').all() as { path: string }[];
    const sources = this.db.prepare('SELECT DISTINCT archive_path AS path FROM managed_replay_sources')
      .all() as { path: string }[];
    return [...locations, ...sources].map(({ path }) => path);
  }

  attempts(): AttemptRecord[] {
    const rows = this.db.prepare(`SELECT id, item_id AS itemId, revision, requested_at AS requestedAt,
      started_at AS startedAt, ended_at AS endedAt, status
      FROM attempts ORDER BY requested_at DESC, id DESC`).all() as AttemptRow[];
    return rows.map((row) => ({
      attemptId: row.id, itemId: row.itemId, revision: row.revision,
      status: row.status === 'started' ? 'active' : row.status,
      requestedAt: row.requestedAt,
      ...(row.startedAt ? { startedAt: row.startedAt } : {}),
      ...(row.endedAt ? { endedAt: row.endedAt } : {}),
    }));
  }

  exposures(): ExposureRecord[] {
    const rows = this.db.prepare(`SELECT exposure_key AS exposureKey,
      CASE WHEN MAX(certainty = 'confirmed') THEN 'confirmed' ELSE 'uncertain' END AS certainty
      FROM exposures GROUP BY exposure_key ORDER BY exposure_key`).all() as ExposureRecord[];
    return rows;
  }

  async verifiedPath(hash: string): Promise<string | null> {
    assertHash(hash);
    const rows = this.db.prepare(`SELECT locations.path, locations.replay_id AS replayId,
      replays.hash, replays.size FROM locations
      JOIN replays ON replays.id = locations.replay_id WHERE replays.hash = ?
      ORDER BY CASE locations.ownership WHEN 'managed' THEN 0 ELSE 1 END, locations.path`)
      .all(hash) as LocationRow[];
    for (const row of rows) {
      if (await this.recheckLocation(row)) return row.path;
    }
    return null;
  }

  async refreshAvailability(): Promise<void> {
    const rows = this.db.prepare(`SELECT locations.path, locations.replay_id AS replayId,
      replays.hash, replays.size FROM locations
      JOIN replays ON replays.id = locations.replay_id ORDER BY locations.path`).all() as LocationRow[];
    for (const row of rows) await this.recheckLocation(row);
  }

  private async recheckLocation(row: LocationRow): Promise<boolean> {
    let valid = false;
    try {
      const before = await stat(row.path);
      if (before.isFile() && before.size === row.size) {
        const digest = createHash('sha256');
        for await (const chunk of createReadStream(row.path)) digest.update(chunk);
        const after = await stat(row.path);
        valid = after.isFile() && after.size === before.size &&
          after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs &&
          digest.digest('hex') === row.hash;
      }
    } catch (error) {
      if (!inaccessible(error)) throw error;
    }
    this.db.prepare(`UPDATE locations SET verification_state = ?, last_verified_at = ?
      WHERE path = ? AND replay_id = ?`)
      .run(valid ? 'valid' : 'invalid', now(), row.path, row.replayId);
    return valid;
  }

  list(): LocalReplay[] {
    const rows = this.db.prepare(`SELECT id, hash, size, player_a AS playerA, player_b AS playerB,
      character_a AS characterA, character_b AS characterB, stage, played_at AS playedAt,
      slp_version AS slpVersion FROM replays WHERE indexed = 1 ORDER BY imported_at DESC, id`).all() as ReplayRow[];
    return rows.map((row) => {
      const paths = this.db.prepare(`SELECT path FROM locations
        WHERE replay_id = ? AND verification_state = 'valid'`).all(row.id) as { path: string }[];
      return { ...row, available: paths.some(({ path }) => {
        try { const stat = statSync(path); return stat.isFile() && stat.size === row.size; } catch { return false; }
      }) };
    });
  }

  setting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value || null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
