import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import Database from 'better-sqlite3';
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

export class Library {
  private closed = false;
  private constructor(private readonly db: Database.Database) {}

  static async open(filePath: string): Promise<Library> {
    await mkdir(dirname(filePath), { recursive: true });
    const existed = existsSync(filePath);
    const db = new Database(filePath);
    try {
      const version = db.pragma('user_version', { simple: true }) as number;
      if (version > 1) throw new Error('Library was created by a newer version of Melee Replay.');
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
      db.pragma('foreign_keys = ON');
      db.pragma('journal_mode = WAL');
      db.prepare("UPDATE attempts SET status = 'interrupted', ended_at = ? WHERE status IN ('preparing', 'started')")
        .run(new Date().toISOString());
      return new Library(db);
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
      this.db.prepare(`INSERT INTO locations (path, replay_id, ownership, last_verified_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET replay_id = excluded.replay_id,
          ownership = excluded.ownership, last_verified_at = excluded.last_verified_at`)
        .run(filePath, id, ownership, new Date().toISOString());
      return id;
    })();
  }

  list(): LocalReplay[] {
    const rows = this.db.prepare(`SELECT id, hash, size, player_a AS playerA, player_b AS playerB,
      character_a AS characterA, character_b AS characterB, stage, played_at AS playedAt,
      slp_version AS slpVersion FROM replays ORDER BY imported_at DESC, id`).all() as ReplayRow[];
    return rows.map((row) => {
      const paths = this.db.prepare('SELECT path FROM locations WHERE replay_id = ?').all(row.id) as { path: string }[];
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

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
