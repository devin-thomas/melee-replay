import { parentPort, workerData } from 'node:worker_threads';
import { createReadStream, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SlippiGame, characters, stages } from '@slippi/slippi-js/node';

export interface ParsedReplay {
  hash: string;
  size: number;
  playerA: string;
  playerB: string;
  characterA: string;
  characterB: string;
  stage: string;
  playedAt: string | null;
  slpVersion: string;
}

const MAX_REPLAY_BYTES = 256 * 1024 * 1024;

function safeName(value: string | undefined): string {
  const name = value?.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 48);
  return name || 'Unknown Player';
}

async function parseReplay(filePath: string): Promise<ParsedReplay> {
  const before = statSync(filePath);
  if (!before.isFile() || before.size === 0 || before.size > MAX_REPLAY_BYTES) {
    throw new Error('Replay exceeds the supported file limit or is empty.');
  }

  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.length;
    if (bytes > MAX_REPLAY_BYTES) throw new Error('Replay exceeds the supported file limit.');
    digest.update(chunk);
  }

  const game = new SlippiGame(filePath);
  const settings = game.getSettings();
  if (!settings || settings.isTeams || settings.players.length !== 2 || !game.getGameEnd()) {
    throw new Error('Replay is incomplete or is not a supported singles game.');
  }
  const [a, b] = [...settings.players].sort((left, right) => left.playerIndex - right.playerIndex);
  const after = statSync(filePath);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes !== after.size) {
    throw new Error('Replay changed while it was being imported. Retry after recording finishes.');
  }

  const metadata = game.getMetadata();
  const playedAt = metadata?.startAt && !Number.isNaN(Date.parse(metadata.startAt))
    ? new Date(metadata.startAt).toISOString()
    : null;

  return {
    hash: digest.digest('hex'),
    size: bytes,
    playerA: safeName(a.displayName || a.connectCode),
    playerB: safeName(b.displayName || b.connectCode),
    characterA: a.characterId === undefined ? 'Unknown' : characters.getCharacterName(a.characterId),
    characterB: b.characterId === undefined ? 'Unknown' : characters.getCharacterName(b.characterId),
    stage: settings.stageId === undefined ? 'Unknown Stage' : stages.getStageName(settings.stageId),
    playedAt,
    slpVersion: settings.slpVersion || 'unknown'
  };
}

if (!parentPort || typeof workerData !== 'string') throw new Error('Invalid replay parser invocation.');
parseReplay(workerData).then(
  (result) => parentPort?.postMessage({ ok: true, result }),
  (error: unknown) => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Replay parsing failed.' })
);
