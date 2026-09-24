import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlippiGame } from '@slippi/slippi-js/node';
import { expect, it } from 'vitest';
import { PlaybackDolphin } from './playback-dolphin';

const executablePath = process.env.MELEE_LIVE_DOLPHIN;
const imagePath = process.env.MELEE_LIVE_IMAGE;
const replayPath = process.env.MELEE_LIVE_REPLAY;

it.skipIf(!executablePath || !imagePath || !replayPath)(
  'observes a full replay ending in the official playback runtime',
  async () => {
    const path = replayPath!;
    const lastFrame = new SlippiGame(path).getMetadata()?.lastFrame;
    expect(typeof lastFrame).toBe('number');
    const root = await mkdtemp(join(tmpdir(), 'melee-replay-live-'));
    let sawStart = false;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const dolphin = new PlaybackDolphin({
      executablePath: executablePath!, imagePath: imagePath!,
      profileDir: join(root, 'profile'), workingDir: join(root, 'working'),
      onStarted: () => { sawStart = true; },
      onNaturallyCompleted: () => resolveCompletion(),
      onFailed: (reason) => rejectCompletion(new Error(reason))
    });
    try {
      await dolphin.play('sample', path, lastFrame!);
      await completion;
      expect(sawStart).toBe(true);
    } finally {
      await dolphin.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 180000
);

it.skipIf(!executablePath || !imagePath || !replayPath)(
  'does not complete an interrupted replay and closes its owned runtime',
  async () => {
    const path = replayPath!;
    const lastFrame = new SlippiGame(path).getMetadata()?.lastFrame;
    expect(typeof lastFrame).toBe('number');
    const root = await mkdtemp(join(tmpdir(), 'melee-replay-live-'));
    const controller = new AbortController();
    let completed = false;
    let resolveStart!: () => void;
    let rejectStart!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    const startTimeout = setTimeout(() => rejectStart(new Error('Playback did not start.')), 45000);
    const dolphin = new PlaybackDolphin({
      executablePath: executablePath!, imagePath: imagePath!,
      profileDir: join(root, 'profile'), workingDir: join(root, 'working'),
      onStarted: () => resolveStart(),
      onNaturallyCompleted: () => { completed = true; },
      onFailed: (reason) => rejectStart(new Error(reason))
    });
    try {
      await dolphin.play('sample', path, lastFrame!, controller.signal);
      await started;
      clearTimeout(startTimeout);
      controller.abort();
      await dolphin.stop();
      await dolphin.close();
      expect(completed).toBe(false);
    } finally {
      clearTimeout(startTimeout);
      await dolphin.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 90000
);
