import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, rmdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  initialSession,
  projectSession,
  transitionSession,
  type PracticeItem,
  type SafeFailureReason,
  type SessionEffect,
  type SessionEvent,
  type SessionState,
  type SessionView,
} from '../core';
import { Library } from './library';
import { entrantOrderedCharacters } from './catalog/characters';
import { parseReplayInWorker } from './replay-import';
import { PlaybackDolphin } from './playback-dolphin';

interface RuntimePaths {
  executablePath: string;
  imagePath: string;
}

interface PreparedReplay {
  path: string;
  hash: string;
  lastFrame: number;
  stage: string;
  characters: readonly [string, string];
}

export interface PracticeControllerOptions {
  library: Library;
  userDataDir: string;
  resolveItem(itemId: string): PracticeItem | null;
  runtimePaths(): RuntimePaths | null;
  publish(view: SessionView): void;
}

class PreflightError extends Error {
  constructor(readonly reason: SafeFailureReason) {
    super(reason);
  }
}

export class PracticeController {
  private state: SessionState = initialSession();
  private queue: Promise<unknown> = Promise.resolve();
  private adapter: PlaybackDolphin | null = null;
  private prepared = new Map<string, PreparedReplay>();
  private aliasDir: string | null = null;
  private aliases: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private operationAbort: AbortController | null = null;

  constructor(private readonly options: PracticeControllerOptions) {
    this.timer = setInterval(() => {
      if (this.state.phase === 'intermission-countdown') {
        void this.dispatch({ type: 'TICK' });
      }
    }, 250);
  }

  view(): SessionView {
    return projectSession(this.state, performance.now());
  }

  activeItemId(): string | null {
    return this.active() ? this.state.item?.itemId ?? null : null;
  }

  start(itemId: string): Promise<SessionView> {
    if (this.state.phase !== 'idle') return Promise.reject(new Error('Finish or leave the current practice session first.'));
    const item = this.options.resolveItem(itemId);
    if (!item) return Promise.reject(new Error('Selected replay is unavailable.'));
    this.operationAbort = new AbortController();
    return this.dispatch({ type: 'START', item, attemptId: randomUUID() });
  }

  command(command: 'stop' | 'hold' | 'next' | 'leave' | 'practice-again'): Promise<SessionView> {
    if (command === 'stop') this.operationAbort?.abort();
    if (command === 'practice-again' && this.state.phase === 'completed') this.operationAbort = new AbortController();
    const event: SessionEvent = command === 'practice-again'
      ? { type: 'PRACTICE_AGAIN', attemptId: randomUUID() }
      : { type: command.toUpperCase() as 'STOP' | 'HOLD' | 'NEXT' | 'LEAVE' };
    return this.dispatch(event);
  }

  suspend(): void {
    if (this.state.phase === 'preparing' || this.state.phase === 'starting' || this.state.phase === 'playing') {
      this.operationAbort?.abort();
    }
    void this.dispatch({ type: 'SUSPEND' });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.operationAbort?.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.active()) await this.dispatch({ type: 'STOP' });
    await this.closeAdapter();
    await this.clearAliases();
  }

  private active(): boolean {
    return ['preparing', 'starting', 'playing', 'intermission-countdown', 'intermission-held']
      .includes(this.state.phase);
  }

  private dispatch(event: SessionEvent): Promise<SessionView> {
    const pending = this.queue.then(async () => {
      await this.apply(event);
      return this.view();
    });
    this.queue = pending.catch(async (error: unknown) => {
      console.error('Practice transition failed:', error instanceof Error ? error.message : 'Unknown error');
      this.operationAbort?.abort();
      try { await this.closeAdapter(); } catch (closeError) {
        console.error('Playback cleanup failed:', closeError instanceof Error ? closeError.message : 'Unknown error');
      }
      await this.clearAliases();
      if (this.active()) {
        this.state = { ...this.state, phase: 'failed', failureReason: 'preparation-failed', deadlineMs: undefined };
        this.options.publish(this.view());
      }
    });
    return pending;
  }

  private async apply(event: SessionEvent): Promise<void> {
    const transition = transitionSession(this.state, event, performance.now());
    if (transition.state === this.state && transition.effects.length === 0) return;
    this.options.library.transaction(() => {
      for (const effect of transition.effects) this.persistEffect(effect);
    });
    this.state = transition.state;
    this.options.publish(this.view());
    for (const effect of transition.effects) await this.runEffect(effect);
    if (event.type === 'LEAVE' && this.state.phase === 'idle') {
      await this.closeAdapter();
      await this.clearAliases();
      this.prepared.clear();
    }
    if (event.type === 'NATURAL_COMPLETION' && this.state.phase === 'completed') {
      await this.closeAdapter();
      await this.clearAliases();
    }
  }

  private persistEffect(effect: SessionEffect): void {
    switch (effect.type) {
      case 'create-attempt':
        this.options.library.createAttempt(effect.attemptId, effect.itemId, effect.revision);
        break;
      case 'record-attempt-start':
        this.options.library.markAttemptStarted(effect.attemptId);
        break;
      case 'record-exposure':
        this.options.library.recordExposure(effect.attemptId, effect.exposureKey, 'confirmed');
        break;
      case 'record-uncertain-exposure':
        this.options.library.recordExposure(effect.attemptId, effect.exposureKey, 'uncertain');
        break;
      case 'record-natural-completion':
        this.options.library.recordNaturalCompletion(effect.attemptId, effect.replayId, effect.scoreEffect);
        break;
      case 'finish-attempt':
        this.options.library.finishAttempt(effect.attemptId, effect.outcome);
        break;
    }
  }

  private async runEffect(effect: SessionEffect): Promise<void> {
    switch (effect.type) {
      case 'request-preflight':
        try {
          await this.preflight();
          if (!this.operationAbort?.signal.aborted) await this.apply({ type: 'PREFLIGHT_READY' });
        } catch (error) {
          if (this.operationAbort?.signal.aborted) break;
          const reason = error instanceof PreflightError ? error.reason : 'preparation-failed';
          console.warn('Practice preflight failed:', reason);
          await this.apply({ type: 'PREPARATION_FAILED', reason });
        }
        break;
      case 'launch-replay':
        try {
          await this.launch(effect.replayId);
        } catch (error) {
          if (this.operationAbort?.signal.aborted) break;
          const reason = error instanceof PreflightError ? error.reason : 'playback-unavailable';
          console.warn('Practice playback launch failed:', reason);
          await this.apply({ type: 'PLAYBACK_FAILED', reason });
        }
        break;
      case 'stop-owned-playback':
        await this.adapter?.stop();
        await this.closeAdapter();
        await this.clearAliases();
        break;
    }
  }

  private async preflight(): Promise<void> {
    const runtime = this.options.runtimePaths();
    if (!runtime) throw new PreflightError('playback-unavailable');
    const executable = await stat(runtime.executablePath).catch(() => null);
    if (!executable?.isFile()) throw new PreflightError('playback-unavailable');
    const image = await open(runtime.imagePath, 'r').catch(() => null);
    if (!image) throw new PreflightError('playback-unavailable');
    try {
      const header = Buffer.alloc(8);
      const result = await image.read(header, 0, header.length, 0);
      if (result.bytesRead !== 8 || header.toString('ascii', 0, 6) !== 'GALE01' || header[7] !== 2) {
        throw new PreflightError('unsupported-playback');
      }
    } finally {
      await image.close();
    }
    const item = this.state.item!;
    const segments = item.kind === 'set' ? item.segments : [item.segment];
    this.prepared.clear();
    for (const segment of segments) {
      if (this.operationAbort?.signal.aborted) return;
      const path = await this.options.library.verifiedPath(segment.exposureKey);
      if (!path) throw new PreflightError('asset-unavailable');
      const parsed = await parseReplayInWorker(path).catch(() => null);
      if (!parsed || parsed.hash !== segment.exposureKey) throw new PreflightError('asset-unavailable');
      const characters = segment.player1Entrant && segment.player2Entrant
        ? entrantOrderedCharacters({ player1Entrant: segment.player1Entrant,
            player2Entrant: segment.player2Entrant }, [parsed.characterA, parsed.characterB])
        : [parsed.characterA, parsed.characterB] as const;
      if (segment.player1Entrant && (characters[0] !== segment.characters[0] ||
          characters[1] !== segment.characters[1])) throw new PreflightError('asset-unavailable');
      this.prepared.set(segment.replayId, { path, hash: parsed.hash, lastFrame: parsed.lastFrame,
        stage: parsed.stage, characters });
    }
    if (this.operationAbort?.signal.aborted) return;
    if (item.kind === 'set') {
      this.state = { ...this.state, item: { ...item, segments: item.segments.map((segment) => {
        const parsed = this.prepared.get(segment.replayId)!;
        return { ...segment, stage: parsed.stage, characters: parsed.characters };
      }) } };
    } else {
      const parsed = this.prepared.get(item.segment.replayId)!;
      this.state = { ...this.state, item: { ...item,
        segment: { ...item.segment, stage: parsed.stage, characters: parsed.characters } } };
    }
    const adapter = new PlaybackDolphin({
      executablePath: runtime.executablePath,
      imagePath: runtime.imagePath,
      profileDir: join(this.options.userDataDir, 'playback-profile'),
      workingDir: join(this.options.userDataDir, 'playback-working'),
      onStarted: (replayId) => {
        if (this.adapter === adapter && !this.shuttingDown) void this.dispatch({ type: 'PLAYBACK_STARTED', replayId });
      },
      onNaturallyCompleted: (replayId) => {
        if (this.adapter === adapter && !this.shuttingDown) {
          void this.dispatch({ type: 'NATURAL_COMPLETION', replayId, callerVerifiedNaturalCompletion: true });
        }
      },
      onFailed: (reason) => {
        if (this.adapter === adapter && !this.shuttingDown) void this.dispatch({ type: 'PLAYBACK_FAILED', reason });
      },
    });
    this.adapter = adapter;
  }

  private async launch(replayId: string): Promise<void> {
    const prepared = this.prepared.get(replayId);
    if (!prepared || !this.adapter) throw new PreflightError('asset-unavailable');
    const current = await this.options.library.verifiedPath(prepared.hash);
    if (current !== prepared.path) throw new PreflightError('asset-unavailable');
    const parsed = await parseReplayInWorker(current).catch(() => null);
    if (!parsed || parsed.hash !== prepared.hash || parsed.lastFrame !== prepared.lastFrame) {
      throw new PreflightError('asset-unavailable');
    }
    if (!this.aliasDir) {
      this.aliasDir = join(this.options.userDataDir, 'playback-working', this.state.attemptId!);
      await mkdir(this.aliasDir, { recursive: true });
    }
    const alias = join(this.aliasDir, `${randomUUID()}.slp`);
    await copyFile(current, alias);
    const copied = await parseReplayInWorker(alias).catch(() => null);
    if (!copied || copied.hash !== prepared.hash || copied.lastFrame !== prepared.lastFrame) {
      await unlink(alias).catch(() => undefined);
      throw new PreflightError('asset-unavailable');
    }
    this.aliases.push(alias);
    this.options.library.markLaunchRequested(this.state.attemptId!, prepared.hash);
    await this.adapter.play(replayId, alias, prepared.lastFrame, this.operationAbort?.signal);
  }

  private async closeAdapter(): Promise<void> {
    const adapter = this.adapter;
    this.adapter = null;
    if (adapter) await adapter.close();
  }

  private async clearAliases(): Promise<void> {
    for (const alias of this.aliases.splice(0)) await unlink(alias).catch(() => undefined);
    const aliasDir = this.aliasDir;
    this.aliasDir = null;
    if (aliasDir) await rmdir(aliasDir).catch(() => undefined);
  }
}
