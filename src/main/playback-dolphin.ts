import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createSocket } from 'node:dgram';
import { basename, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DolphinConnection as DolphinConnectionType } from '@slippi/slippi-js/node';

export type PlaybackFailure = 'playback-unavailable' | 'connection-lost' | 'unsupported-playback';

export interface PlaybackDolphinOptions {
  executablePath: string;
  imagePath: string;
  profileDir: string;
  workingDir: string;
  onStarted: (replayId: string) => void;
  onNaturallyCompleted: (replayId: string) => void;
  onFailed: (reason: PlaybackFailure) => void;
}

interface ActiveReplay {
  replayId: string;
  aliasPath: string;
  terminal: TerminalObservation;
  endTimer: ReturnType<typeof setTimeout> | null;
}

/** Combines three independent runtime observations before awarding a completed watch. */
export class TerminalObservation {
  private pathConfirmed = false;
  private terminalFrameDeclared = false;
  private startConfirmed = false;
  private frameConfirmed = false;
  private endConfirmed = false;
  private invalid = false;
  private startedReported = false;

  constructor(readonly expectedLastFrame: number) {
    if (!Number.isInteger(expectedLastFrame) || expectedLastFrame < -123) {
      throw new Error('Replay has no valid terminal frame.');
    }
  }

  confirmPath(): void { this.pathConfirmed = true; }
  confirmStart(): void {
    if (this.pathConfirmed && this.terminalFrameDeclared) this.startConfirmed = true;
  }
  confirmFrame(frame: number): void {
    if (this.startConfirmed && Number.isInteger(frame) && frame >= this.expectedLastFrame) this.frameConfirmed = true;
  }
  confirmEnd(): void {
    if (this.startConfirmed) this.endConfirmed = true;
  }
  invalidate(): void { this.invalid = true; }
  confirmExpectedFrame(frame: number): void {
    if (frame !== this.expectedLastFrame) this.invalid = true;
    else this.terminalFrameDeclared = true;
  }
  shouldReportStart(): boolean {
    if (this.invalid || this.startedReported || !this.pathConfirmed || !this.terminalFrameDeclared || !this.startConfirmed) return false;
    this.startedReported = true;
    return true;
  }
  get complete(): boolean {
    return !this.invalid && this.pathConfirmed && this.terminalFrameDeclared && this.startConfirmed && this.frameConfirmed && this.endConfirmed;
  }
  get endedWithoutTerminalFrame(): boolean {
    return this.endConfirmed && !this.frameConfirmed;
  }
  get isInvalid(): boolean { return this.invalid; }
}

async function unusedSpectatorPort(): Promise<number> {
  const socket = createSocket('udp4');
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      const address = socket.address();
      socket.close();
      if (typeof address === 'string' || address.port < 1024) reject(new Error('No local spectator port available.'));
      else resolve(address.port);
    });
  });
}

function samePath(left: string, right: string): boolean {
  return normalize(left).toLowerCase() === normalize(right).toLowerCase();
}

export class PlaybackDolphin {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: DolphinConnectionType | null = null;
  private active: ActiveReplay | null = null;
  private commPath: string;
  private commandNumber = 0;
  private lastCommandAt = 0;
  private aliases = new Set<string>();
  private stdoutBuffer = '';
  private closing = false;
  private abortSubscription: { signal: AbortSignal; handler: () => void } | null = null;
  private validatedExecutable = false;

  constructor(private readonly options: PlaybackDolphinOptions) {
    this.commPath = join(options.workingDir, 'playback.json');
  }

  async play(replayId: string, replayPath: string, expectedLastFrame: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.closing || this.active) throw new Error('Playback is already active.');
    const executable = await stat(this.options.executablePath);
    const image = await stat(this.options.imagePath);
    const replay = await stat(replayPath);
    if (!executable.isFile() || !image.isFile() || !replay.isFile()) throw new Error('Playback files are unavailable.');
    if (!/^Slippi Dolphin\.exe$/i.test(basename(this.options.executablePath))) {
      throw new Error('The selected executable is not Slippi Playback Dolphin.');
    }
    if (!this.validatedExecutable) {
      const binary = await readFile(this.options.executablePath);
      if (!binary.includes('slippi-input') || !binary.includes('hide-seekbar')) {
        throw new Error('The selected Dolphin lacks Slippi replay playback controls.');
      }
      this.validatedExecutable = true;
    }
    const terminal = new TerminalObservation(expectedLastFrame);
    await mkdir(this.options.workingDir, { recursive: true });
    await mkdir(this.options.profileDir, { recursive: true });
    const aliasPath = join(this.options.workingDir, `${randomUUID()}.slp`);
    await copyFile(replayPath, aliasPath);
    this.aliases.add(aliasPath);
    const abort = (): void => {
      this.active?.terminal.invalidate();
      this.active = null;
      this.child?.kill();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal) this.abortSubscription = { signal, handler: abort };
    try {
      signal?.throwIfAborted();
      if (!this.child) await this.launch(signal);
      signal?.throwIfAborted();
      this.active = { replayId, aliasPath, terminal, endTimer: null };
      await this.publish(aliasPath, signal);
    } catch (error) {
      this.active = null;
      await this.close();
      this.closing = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.clearAbortListener();
    const active = this.active;
    if (active) {
      active.terminal.invalidate();
      if (active.endTimer) clearTimeout(active.endTimer);
      this.active = null;
    }
    if (this.child) await this.publish('invalidpath');
  }

  async close(): Promise<void> {
    this.closing = true;
    this.clearAbortListener();
    const active = this.active;
    if (active) {
      active.terminal.invalidate();
      if (active.endTimer) clearTimeout(active.endTimer);
      this.active = null;
    }
    this.connection?.disconnect();
    this.connection = null;
    const child = this.child;
    if (child) {
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('close', () => resolve());
        child.kill();
      });
    }
    this.child = null;
    for (const alias of this.aliases) await rm(alias, { force: true });
    this.aliases.clear();
    await rm(this.commPath, { force: true });
  }

  private async launch(signal?: AbortSignal): Promise<void> {
    // A neutral initial command keeps Dolphin idle until the spectator handshake is ready.
    await this.publish('invalidpath', signal);
    const port = await unusedSpectatorPort();
    signal?.throwIfAborted();
    const child = spawn(this.options.executablePath, [
      '-b', '-e', this.options.imagePath, '-i', this.commPath,
      '--user', this.options.profileDir, '--slippi-spectator-port', String(port),
      '--cout', '--hide-seekbar'
    ], { shell: false, windowsHide: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdin.end();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    child.stderr.resume();
    child.on('close', () => {
      this.child = null;
      this.connection?.disconnect();
      this.connection = null;
      if (this.active && !this.closing) this.fail('connection-lost');
    });
    child.on('error', () => {
      if (this.active && !this.closing) this.fail('playback-unavailable');
    });
    const slippi = await import('@slippi/slippi-js/node');
    const connection = new slippi.DolphinConnection();
    this.connection = connection;
    connection.on(slippi.ConnectionEvent.MESSAGE, (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return;
      if (message.type === slippi.DolphinMessageType.START_GAME) {
        const active = this.active;
        if (!active) return;
        active.terminal.confirmStart();
        this.maybeReportStart(active);
      } else if (message.type === slippi.DolphinMessageType.END_GAME) {
        const active = this.active;
        if (!active) return;
        active.terminal.confirmEnd();
        this.maybeComplete(active);
        if (this.active === active && active.terminal.endedWithoutTerminalFrame && !active.endTimer) {
          active.endTimer = setTimeout(() => {
            if (this.active === active) this.fail('unsupported-playback');
          }, 1500);
        }
      }
    });
    connection.on(slippi.ConnectionEvent.ERROR, () => this.fail('connection-lost'));
    connection.on(slippi.ConnectionEvent.STATUS_CHANGE, (status) => {
      if (status === slippi.ConnectionStatus.DISCONNECTED && this.active && !this.closing) this.fail('connection-lost');
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        connection.removeListener(slippi.ConnectionEvent.HANDSHAKE, onHandshake);
        child.removeListener('close', onClose);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = (): void => done(new Error('Playback launch cancelled.'));
      const onHandshake = (): void => done();
      const onClose = (): void => done(new Error('Slippi Playback Dolphin closed during startup.'));
      const timer = setTimeout(() => done(new Error('Slippi spectator connection timed out.')), 45000);
      signal?.addEventListener('abort', onAbort, { once: true });
      connection.once(slippi.ConnectionEvent.HANDSHAKE, onHandshake);
      child.once('close', onClose);
      connection.connect('127.0.0.1', port).catch((error: unknown) => {
        done(error instanceof Error ? error : new Error('Slippi spectator connection failed.'));
      });
    });
  }

  private async publish(replayPath: string, signal?: AbortSignal): Promise<void> {
    // The native reader checks file modification time, so separate writes by a second.
    const delay = 1050 - (Date.now() - this.lastCommandAt);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    signal?.throwIfAborted();
    const temp = `${this.commPath}.${randomUUID()}.tmp`;
    const command = {
      mode: 'normal', replay: replayPath, commandId: String(++this.commandNumber),
      gameStation: 'Melee Replay', outputOverlayFiles: false,
      rollbackDisplayMethod: 'off'
    };
    try {
      await writeFile(temp, JSON.stringify(command));
      signal?.throwIfAborted();
      await rename(temp, this.commPath);
      this.lastCommandAt = Date.now();
      signal?.throwIfAborted();
    } finally {
      await rm(temp, { force: true });
    }
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let split = this.stdoutBuffer.indexOf('\n');
    while (split >= 0) {
      const line = this.stdoutBuffer.slice(0, split).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(split + 1);
      this.consumeLine(line);
      split = this.stdoutBuffer.indexOf('\n');
    }
    if (this.stdoutBuffer.length > 16384) this.stdoutBuffer = this.stdoutBuffer.slice(-8192);
  }

  private consumeLine(line: string): void {
    const active = this.active;
    if (!active) return;
    if (line.startsWith('[FILE_PATH] ')) {
      if (samePath(line.slice(12), active.aliasPath)) active.terminal.confirmPath();
      else { this.fail('unsupported-playback'); return; }
      this.maybeReportStart(active);
    } else if (line.startsWith('[GAME_END_FRAME] ')) {
      const frame = Number(line.slice(17));
      active.terminal.confirmExpectedFrame(frame);
      if (active.terminal.isInvalid) { this.fail('unsupported-playback'); return; }
    } else if (line.startsWith('[CURRENT_FRAME] ')) {
      const frame = Number(line.slice(16));
      active.terminal.confirmFrame(frame);
      this.maybeComplete(active);
    }
  }

  private maybeReportStart(active: ActiveReplay): void {
    if (this.active === active && active.terminal.shouldReportStart()) this.options.onStarted(active.replayId);
  }

  private maybeComplete(active: ActiveReplay): void {
    if (this.active !== active || !active.terminal.complete) return;
    if (active.endTimer) clearTimeout(active.endTimer);
    this.active = null;
    this.clearAbortListener();
    this.options.onNaturallyCompleted(active.replayId);
  }

  private fail(reason: PlaybackFailure): void {
    const active = this.active;
    if (!active) return;
    active.terminal.invalidate();
    if (active.endTimer) clearTimeout(active.endTimer);
    this.active = null;
    this.clearAbortListener();
    this.options.onFailed(reason);
  }

  private clearAbortListener(): void {
    const subscription = this.abortSubscription;
    if (!subscription) return;
    subscription.signal.removeEventListener('abort', subscription.handler);
    this.abortSubscription = null;
  }
}
