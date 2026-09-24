import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { PracticeItem, ReplaySegment, SessionEvent, SessionView } from '../core';
import type { ParsedReplay } from './parse-worker';

vi.mock('./replay-import', () => ({
  parseReplayInWorker: async (path: string): Promise<ParsedReplay> => {
    const bytes = await readFile(path);
    return parsed(bytes);
  },
}));

vi.mock('./playback-dolphin', () => ({
  PlaybackDolphin: class {
    async play(): Promise<void> {}
    async stop(): Promise<void> {}
    async close(): Promise<void> {}
  },
}));

import { Library } from './library';
import { PracticeController } from './practice-controller';

const paths: string[] = [];
const id = (last: number): string => `00000000-0000-4000-8000-${last.toString(16).padStart(12, '0')}`;

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function parsed(bytes: Buffer): ParsedReplay {
  return {
    hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
    playerA: 'Entrant A', playerB: 'Entrant B',
    characterA: 'First character', characterB: 'Second character',
    stage: 'Synthetic stage', playedAt: null, slpVersion: '3.0.0', lastFrame: 100,
  };
}

function segment(replayId: string, number: number, bytes: Buffer,
  scoreEffect: ReplaySegment['scoreEffect']): ReplaySegment {
  return {
    replayId, exposureKey: parsed(bytes).hash, officialGameNumber: number,
    characters: ['First character', 'Second character'], scoreEffect,
  };
}

function syntheticSet(first: Buffer, second: Buffer, tail: Buffer,
  longer: boolean): PracticeItem {
  return {
    itemId: id(80), revision: 'shared-revision', kind: 'set', verification: 'verified',
    format: 'bo5', terminalRule: { kind: 'target-wins', target: 3 },
    context: { event: 'Synthetic event', entrants: ['Entrant A', 'Entrant B'],
      openingCharacters: ['First character', 'Second character'] },
    segments: [
      segment(id(1), 1, first, 'entrantA'),
      segment(id(2), 2, second, 'entrantA'),
      segment(longer ? id(4) : id(3), 3, tail, longer ? 'entrantB' : 'entrantA'),
      ...(longer ? [segment(id(5), 4, Buffer.from('unseen later replay'), 'entrantA')] : []),
    ],
  };
}

async function send(controller: PracticeController, event: SessionEvent): Promise<SessionView> {
  const dispatch = Reflect.get(controller, 'dispatch') as (event: SessionEvent) => Promise<SessionView>;
  return dispatch.call(controller, event);
}

it('starts from a shared opening even when an unseen tail is missing, then fails without scoring it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'melee-prefix-test-'));
  paths.push(root);
  const runtime = join(root, 'runtime.exe');
  const image = join(root, 'game.iso');
  await writeFile(runtime, 'runtime');
  await writeFile(image, Buffer.from([71, 65, 76, 69, 48, 49, 0, 2]));

  const first = Buffer.from('synthetic opening replay');
  const second = Buffer.from('synthetic second replay');
  const shortTail = Buffer.from('synthetic short tail');
  const missingTail = Buffer.from('synthetic missing tail');
  const library = await Library.open(join(root, 'library.sqlite'));
  for (const [name, bytes] of [['first', first], ['second', second], ['short-tail', shortTail]] as const) {
    const path = join(root, `${name}.slp`);
    await writeFile(path, bytes);
    library.addReference(path, parsed(bytes));
  }
  const shortItem = syntheticSet(first, second, shortTail, false);
  const longItem = syntheticSet(first, second, missingTail, true);
  const options = { library, userDataDir: root, runtimePaths: () => ({ executablePath: runtime, imagePath: image }),
    publish: (_view: SessionView) => undefined };
  const short = new PracticeController({ ...options, resolveItem: () => shortItem });
  const long = new PracticeController({ ...options, resolveItem: () => longItem });
  try {
    const shortView = await short.start(id(80));
    const longView = await long.start(id(80));
    expect(shortView).toEqual(longView);
    expect(shortView.phase).toBe('starting');
    expect(JSON.stringify(shortView)).not.toContain('tail');

    await send(long, { type: 'PLAYBACK_STARTED', replayId: id(1) });
    await send(long, { type: 'NATURAL_COMPLETION', replayId: id(1), callerVerifiedNaturalCompletion: true });
    await long.command('next');
    await send(long, { type: 'PLAYBACK_STARTED', replayId: id(2) });
    await send(long, { type: 'NATURAL_COMPLETION', replayId: id(2), callerVerifiedNaturalCompletion: true });
    const failed = await long.command('next');
    expect(failed.phase).toBe('failed');
    expect(failed.failureReason).toBe('asset-unavailable');
    expect(failed.observedScore).toEqual([2, 0]);
    expect(library.attempts().find((attempt) => attempt.itemId === id(80) && attempt.status === 'failed'))
      .toBeDefined();
    expect(library.exposures()).toHaveLength(2);
  } finally {
    await Promise.all([short.shutdown(), long.shutdown()]);
    library.close();
  }
});
