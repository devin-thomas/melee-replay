import { app, BrowserWindow, dialog, ipcMain, powerMonitor, shell } from 'electron';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Library } from './library';
import { PracticeController } from './practice-controller';
import { parseReplayInWorker } from './replay-import';
import { extractReporterPackage } from './reporter-package';
import sampleCatalog from '../../data/catalog-v1.json';
import { createPracticeCard, type AttemptRecord, type ExposureRecord,
  type PracticeItem as DomainPracticeItem } from '../core';
import { acquireSelectedItem, CatalogAcquisitionError } from './catalog/acquire';
import { extractSelectedReplays } from './catalog/extract';
import { validateCatalogManifest } from './catalog/manifest';
import type { ApprovedSourceScope, PracticeItem as CatalogPracticeItem } from './catalog/types';
import type { AppSnapshot, ImportSummary, ReplayCard, SetupView } from '../shared/api';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;
const squirrelStartup: boolean = process.platform === 'win32' && require('electron-squirrel-startup') === true;
if (process.platform === 'win32') app.setAppUserModelId('com.squirrel.MeleeReplay.Melee Replay');

const MAX_IMPORT_FILES = 500;
let mainWindow: BrowserWindow;
let library: Library;
let practice: PracticeController;
let importing = false;
let acquisition: AbortController | null = null;

const approvedSources: readonly ApprovedSourceScope[] = [{
  sourceId: 'huggingface-slippi-public-v3.7',
  downloadScopes: [{
    origin: 'https://huggingface.co',
    pathPrefix: '/datasets/erickfm/slippi-public-dataset-v3.7/resolve/c82be5f6e43f3388555cfe0cf8652580601f396d/'
  }],
  redirectScopes: [{ origin: 'https://us.aws.cdn.hf.co', pathPrefix: '/xet-bridge-us/' }]
}, {
  sourceId: 'slippi-official-summit-11',
  downloadScopes: [{
    origin: 'https://storage.googleapis.com',
    pathPrefix: '/slippi.appspot.com/replays/bundles/'
  }],
  redirectScopes: []
}, {
  sourceId: 'ausmash-public-results',
  downloadScopes: [{
    origin: 'https://ausmashstorage.blob.core.windows.net',
    pathPrefix: '/ausmash-content/'
  }],
  redirectScopes: []
}];
const catalog = validateCatalogManifest(sampleCatalog, approvedSources);
const catalogReplays = new Map(catalog.replays.map((replay) => [replay.replayId, replay]));
const catalogAssets = new Map(catalog.assets.map((asset) => [asset.assetId, asset]));

function domainItem(item: CatalogPracticeItem): DomainPracticeItem {
  if (item.kind === 'standalone') {
    const replay = catalogReplays.get(item.replayId)!;
    return {
      itemId: item.itemId,
      revision: catalog.catalogRevision,
      kind: 'standalone',
      context: { entrants: [replay.participants.player1, replay.participants.player2],
        openingCharacters: item.openingCharacters },
      segment: { replayId: item.replayId, exposureKey: replay.sha256,
        officialGameNumber: 1, characters: item.openingCharacters, scoreEffect: 'none' }
    };
  }
  return {
    itemId: item.itemId,
    revision: catalog.catalogRevision,
    kind: 'set', verification: 'verified',
    format: item.bestOf === 3 ? 'bo3' : item.bestOf === 5 ? 'bo5' : 'unknown',
    terminalRule: item.bestOf === null ? { kind: 'verified-source-terminal' }
      : { kind: 'target-wins', target: item.bestOf === 3 ? 2 : 3 },
    context: { entrants: [item.entrantA, item.entrantB], openingCharacters: item.segments[0].openingCharacters,
      event: item.eventContext },
    segments: item.segments.map((segment, index) => {
      const replay = catalogReplays.get(segment.replayId)!;
      return { replayId: replay.replayId, exposureKey: replay.sha256,
        officialGameNumber: index + 1, characters: segment.openingCharacters,
        player1Entrant: segment.player1Entrant, player2Entrant: segment.player2Entrant,
        scoreEffect: segment.scoreEffect };
    })
  };
}

function sharedCard(item: DomainPracticeItem, availability: 'ready' | 'downloadable' | 'unavailable',
  attempts: readonly AttemptRecord[], exposures: readonly ExposureRecord[],
  source: 'catalog' | 'local'): ReplayCard {
  const card = createPracticeCard(item, attempts, exposures, availability);
  return {
    id: card.itemId, kind: card.kind, source,
    playerA: card.context.entrants[0], playerB: card.context.entrants[1],
    openingA: card.context.openingCharacters[0] || 'Unknown',
    openingB: card.context.openingCharacters[1] || 'Unknown',
    event: card.context.event || null, playedAt: card.context.date || null,
    availability: card.availability === 'unavailable' ? 'missing' : card.availability,
    practiceStatus: card.status,
  };
}

function requireMainFrame(event: Electron.IpcMainInvokeEvent): void {
  if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Rejected request from an untrusted frame.');
  }
}

function setupView(): SetupView {
  const playbackDolphin = library.setting('playbackDolphin');
  const gameImage = library.setting('gameImage');
  return {
    playbackDolphin: playbackDolphin && existsSync(playbackDolphin) ? basename(playbackDolphin) : null,
    gameImage: gameImage && existsSync(gameImage) ? basename(gameImage) : null
  };
}

async function hasMeleeHeader(path: string): Promise<boolean> {
  const file = await open(path, 'r').catch(() => null);
  if (!file) return false;
  try {
    const bytes = Buffer.alloc(8);
    const result = await file.read(bytes, 0, bytes.length, 0);
    return result.bytesRead === 8 && bytes.toString('ascii', 0, 6) === 'GALE01' && bytes[7] === 2;
  } finally {
    await file.close();
  }
}

async function hasPlaybackMarkers(path: string): Promise<boolean> {
  if (basename(path).toLowerCase() !== 'slippi dolphin.exe') return false;
  const binary = await readFile(path).catch(() => null);
  return !!binary && binary.includes('slippi-input') && binary.includes('hide-seekbar');
}

async function detectLocalSetup(): Promise<void> {
  const runtime = join(app.getPath('appData'), 'Slippi Launcher', 'playback', 'Slippi Dolphin.exe');
  if (!library.setting('playbackDolphin') && await hasPlaybackMarkers(runtime)) {
    library.setSetting('playbackDolphin', runtime);
  }
  if (library.setting('gameImage')) return;
  const settings = join(app.getPath('appData'), 'Dolphin Emulator', 'Config', 'Dolphin.ini');
  const ini = await readFile(settings, 'utf8').catch(() => '');
  const roots = [...ini.matchAll(/^ISOPath\d+\s*=\s*(.+)\s*$/gm)].map((match) => match[1].trim());
  for (const root of roots) {
    if (!isAbsolute(root) || root.startsWith('\\\\')) continue;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !/\.iso$|\.gcm$/i.test(entry.name) ||
          !/melee|gale01/i.test(entry.name)) continue;
      const candidate = join(root, entry.name);
      if (await hasMeleeHeader(candidate)) {
        library.setSetting('gameImage', candidate);
        return;
      }
    }
  }
}

function runtimePaths(): { executablePath: string; imagePath: string } | null {
  const executablePath = library.setting('playbackDolphin');
  const imagePath = library.setting('gameImage');
  return executablePath && imagePath ? { executablePath, imagePath } : null;
}

function localDomainItem(record: ReturnType<Library['list']>[number]): DomainPracticeItem {
  return {
    itemId: record.id, revision: record.hash, kind: 'standalone',
    context: { entrants: [record.playerA, record.playerB],
      openingCharacters: [record.characterA, record.characterB], date: record.playedAt || undefined },
    segment: { replayId: record.id, exposureKey: record.hash,
      officialGameNumber: 1, characters: [record.characterA, record.characterB], scoreEffect: 'none' }
  };
}

function resolvePracticeItem(itemId: string): DomainPracticeItem | null {
  const selected = catalog.items.find((item) => item.itemId === itemId);
  if (selected) return domainItem(selected);
  const local = library.list().find((record) => record.id === itemId);
  return local ? localDomainItem(local) : null;
}

function snapshot(): AppSnapshot {
  const local = library.list();
  const attempts = library.attempts();
  const exposures = library.exposures();
  const localByHash = new Map(local.map((record) => [record.hash, record]));
  const catalogHashes = new Set(catalog.replays.map((replay) => replay.sha256));
  const cards: ReplayCard[] = catalog.items.map((item) => {
    const replayIds = item.kind === 'standalone' ? [item.replayId] : item.segments.map((segment) => segment.replayId);
    const ready = replayIds.every((id) => localByHash.get(catalogReplays.get(id)!.sha256)?.available);
    return sharedCard(domainItem(item), ready ? 'ready' : 'downloadable', attempts, exposures, 'catalog');
  });
  for (const record of local) {
    if (catalogHashes.has(record.hash)) continue;
    cards.push(sharedCard(localDomainItem(record), record.available ? 'ready' : 'unavailable',
      attempts, exposures, 'local'));
  }
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const history = attempts.flatMap((attempt) => {
    if (attempt.status !== 'completed' && attempt.status !== 'interrupted' && attempt.status !== 'failed') return [];
    const card = cardsById.get(attempt.itemId);
    return [{
      attemptId: attempt.attemptId,
      itemId: attempt.itemId,
      label: card ? card.playerA + ' vs ' + card.playerB : 'Past practice item',
      event: card?.event ?? null,
      status: attempt.status,
      requestedAt: attempt.requestedAt,
      startedAt: attempt.startedAt ?? null,
      endedAt: attempt.endedAt ?? null,
    }];
  });
  return { cards, setup: setupView(), session: practice.view(), history };
}

async function enumerateFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  const rootReal = await realpath(root);
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const childReal = await realpath(path);
        const childRelative = relative(rootReal, childReal);
        if (childRelative === '..' || childRelative.startsWith(`..${sep}`) || isAbsolute(childRelative)) continue;
        pending.push(path);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.slp') {
        files.push(path);
        if (files.length > MAX_IMPORT_FILES) throw new Error(`Import is limited to ${MAX_IMPORT_FILES} replay files at a time.`);
      }
    }
  }
  return files;
}

async function importPaths(paths: string[]): Promise<ImportSummary> {
  if (importing) throw new Error('An import is already running.');
  importing = true;
  const summary: ImportSummary = { scanned: paths.length, imported: 0, duplicates: 0, rejected: 0, cancelled: false };
  try {
    const knownHashes = new Set(library.list().map((record) => record.hash));
    for (const path of paths) {
      try {
        const parsed = await parseReplayInWorker(path);
        library.addReference(path, parsed);
        if (!(await library.verifiedPath(parsed.hash))) throw new Error('Imported replay changed during validation.');
        if (knownHashes.has(parsed.hash)) summary.duplicates += 1;
        else { summary.imported += 1; knownHashes.add(parsed.hash); }
      } catch (error) {
        summary.rejected += 1;
        console.warn('Replay import rejected:', error instanceof Error ? error.message : 'Unknown parsing failure');
      }
    }
    return summary;
  } finally {
    importing = false;
  }
}

function registerIpc(): void {
  ipcMain.handle('library:snapshot', (event) => {
    requireMainFrame(event);
    return snapshot();
  });
  ipcMain.handle('library:import-files', async (event) => {
    requireMainFrame(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Slippi replays', extensions: ['slp'] }]
    });
    if (result.canceled) return { scanned: 0, imported: 0, duplicates: 0, rejected: 0, cancelled: true } satisfies ImportSummary;
    if (result.filePaths.length > MAX_IMPORT_FILES) throw new Error(`Import is limited to ${MAX_IMPORT_FILES} replay files at a time.`);
    return importPaths(result.filePaths);
  });
  ipcMain.handle('library:import-folder', async (event) => {
    requireMainFrame(event);
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled) return { scanned: 0, imported: 0, duplicates: 0, rejected: 0, cancelled: true } satisfies ImportSummary;
    return importPaths(await enumerateFiles(result.filePaths[0]));
  });
  ipcMain.handle('library:import-package', async (event) => {
    requireMainFrame(event);
    if (importing) throw new Error('An import is already running.');
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'], filters: [{ name: 'Replay Reporter package', extensions: ['zip'] }]
    });
    if (result.canceled) return { scanned: 0, imported: 0, duplicates: 0, rejected: 0, cancelled: true } satisfies ImportSummary;
    const archivePath = result.filePaths[0];
    const archiveStat = await lstat(archivePath);
    if (!archiveStat.isFile() || extname(archivePath).toLowerCase() !== '.zip') {
      throw new Error('Select a Replay Reporter ZIP package.');
    }
    importing = true;
    try {
      const files = await extractReporterPackage(archivePath, join(app.getPath('userData'), 'managed', 'reporter'));
      const summary: ImportSummary = { scanned: files.length, imported: 0, duplicates: 0, rejected: 0, cancelled: false };
      const knownHashes = new Set(library.list().map((record) => record.hash));
      for (const file of files) {
        try {
          const parsed = await parseReplayInWorker(file.path);
          if (parsed.hash !== file.hash || parsed.size !== file.size) throw new Error('Replay changed during package import.');
          library.addReference(file.path, parsed, 'managed');
          if (!(await library.verifiedPath(parsed.hash))) throw new Error('Replay changed during package import.');
          library.recordManagedProvenance(parsed.hash, file.archivePath, file.entryPath);
          if (knownHashes.has(parsed.hash)) summary.duplicates += 1;
          else { summary.imported += 1; knownHashes.add(parsed.hash); }
        } catch (error) {
          summary.rejected += 1;
          console.warn('Package replay rejected:', error instanceof Error ? error.message : 'Unknown parsing failure');
        }
      }
      return summary;
    } finally { importing = false; }
  });
  ipcMain.handle('library:remove-indexed', (event, replayId: unknown) => {
    requireMainFrame(event);
    if (typeof replayId !== 'string' || catalog.items.some((item) => item.itemId === replayId) ||
        practice.activeItemId() === replayId) throw new Error('This replay cannot be removed during practice.');
    library.removeFromIndex(replayId);
  });
  ipcMain.handle('library:relink', async (event, replayId: unknown) => {
    requireMainFrame(event);
    if (typeof replayId !== 'string' || catalog.items.some((item) => item.itemId === replayId) ||
        practice.activeItemId() === replayId || !library.replayIdentity(replayId)) {
      throw new Error('Selected replay cannot be relinked.');
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'], filters: [{ name: 'Slippi replay', extensions: ['slp'] }]
    });
    if (result.canceled) return false;
    const path = result.filePaths[0];
    const file = await lstat(path);
    if (!file.isFile() || extname(path).toLowerCase() !== '.slp') throw new Error('Select a Slippi replay file.');
    const parsed = await parseReplayInWorker(path);
    library.relinkReference(replayId, path, parsed);
    if (!(await library.verifiedPath(parsed.hash))) throw new Error('The replay changed during relinking.');
    return true;
  });
  ipcMain.handle('library:rescan', async (event, replayId: unknown) => {
    requireMainFrame(event);
    if (typeof replayId !== 'string' || catalog.items.some((item) => item.itemId === replayId) ||
        practice.activeItemId() === replayId) throw new Error('Selected replay cannot be rescanned.');
    const identity = library.replayIdentity(replayId);
    if (!identity) throw new Error('Selected replay is not in the library.');
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled) return false;
    for (const path of await enumerateFiles(result.filePaths[0])) {
      let parsed;
      try { parsed = await parseReplayInWorker(path); }
      catch { continue; }
      if (parsed.hash !== identity.hash || parsed.size !== identity.size) continue;
      library.relinkReference(replayId, path, parsed);
      if (!(await library.verifiedPath(parsed.hash))) throw new Error('The replay changed during rescan.');
      return true;
    }
    return false;
  });
  ipcMain.handle('catalog:acquire', async (event, itemId: unknown) => {
    requireMainFrame(event);
    if (typeof itemId !== 'string' || !catalog.items.some((item) => item.itemId === itemId)) {
      throw new Error('Selected replay is unavailable.');
    }
    if (acquisition) throw new Error('A replay is already being prepared.');
    acquisition = new AbortController();
    try {
      const item = catalog.items.find((entry) => entry.itemId === itemId)!;
      const replayIds = item.kind === 'standalone' ? [item.replayId]
        : item.segments.map((segment) => segment.replayId);
      const selectedReplays = replayIds.map((id) => catalogReplays.get(id)!);
      const files = await acquireSelectedItem(catalog, itemId, join(app.getPath('userData'), 'managed'), approvedSources, {
        signal: acquisition.signal,
        onPhase: (phase) => { if (phase !== 'ready') mainWindow.webContents.send('catalog:phase', phase); }
      });
      mainWindow.webContents.send('catalog:phase', 'verifying');
      for (const file of files) {
        const asset = catalogAssets.get(file.assetId)!;
        const relevant = selectedReplays.filter((replay) => replay.assetId === file.assetId);
        const extracted = asset.format === 'zip'
          ? await extractSelectedReplays(file.path, relevant, dirname(file.path), acquisition.signal)
          : relevant.map((replay) => ({ replayId: replay.replayId, path: file.path }));
        for (const entry of extracted) {
          const replay = catalogReplays.get(entry.replayId)!;
          const parsed = await parseReplayInWorker(entry.path);
          if (parsed.hash !== replay.sha256 || parsed.size !== replay.byteSize) {
            throw new Error('Downloaded replay did not pass playback validation.');
          }
          library.addReference(entry.path, parsed, 'managed');
          if (!(await library.verifiedPath(parsed.hash))) throw new Error('Downloaded replay changed during validation.');
        }
      }
      mainWindow.webContents.send('catalog:phase', 'ready');
    } catch (error) {
      if (error instanceof CatalogAcquisitionError) throw error;
      console.warn('Catalog preparation failed:', error);
      throw new Error('The selected replay could not be prepared.');
    } finally {
      acquisition = null;
    }
  });
  ipcMain.handle('catalog:cancel', (event) => {
    requireMainFrame(event);
    acquisition?.abort();
  });
  ipcMain.handle('session:start', (event, itemId: unknown) => {
    requireMainFrame(event);
    if (typeof itemId !== 'string') throw new Error('Selected replay is unavailable.');
    return practice.start(itemId);
  });
  ipcMain.handle('session:command', (event, command: unknown) => {
    requireMainFrame(event);
    if (command !== 'stop' && command !== 'hold' && command !== 'next' &&
        command !== 'leave' && command !== 'practice-again') {
      throw new Error('Unknown practice command.');
    }
    return practice.command(command);
  });
  ipcMain.handle('setup:choose-runtime', async (event) => {
    requireMainFrame(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Playback Dolphin', extensions: ['exe'] }]
    });
    if (!result.canceled) {
      const path = result.filePaths[0];
      const stat = await lstat(path);
      if (!stat.isFile() || !(await hasPlaybackMarkers(path))) throw new Error('Select an official Slippi Playback Dolphin executable.');
      library.setSetting('playbackDolphin', path);
    }
    return setupView();
  });
  ipcMain.handle('setup:choose-image', async (event) => {
    requireMainFrame(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Game image', extensions: ['iso', 'gcm'] }]
    });
    if (!result.canceled) {
      const path = result.filePaths[0];
      const stat = await lstat(path);
      if (!stat.isFile() || !['.iso', '.gcm'].includes(extname(path).toLowerCase()) ||
          !(await hasMeleeHeader(path))) throw new Error('Select a supported Melee game image.');
      library.setSetting('gameImage', path);
    }
    return setupView();
  });
  ipcMain.handle('setup:recheck', async (event) => {
    requireMainFrame(event);
    await detectLocalSetup();
    await library.refreshAvailability();
    const runtime = runtimePaths();
    if (!runtime) throw new Error('Select Playback Dolphin and a Melee game image in Setup.');
    const executable = await lstat(runtime.executablePath).catch(() => null);
    if (!executable?.isFile() || !(await hasPlaybackMarkers(runtime.executablePath))) {
      throw new Error('Select a valid Slippi Playback Dolphin executable.');
    }
    if (!(await hasMeleeHeader(runtime.imagePath))) {
      throw new Error('Select a valid Melee game image.');
    }
    return setupView();
  });
  ipcMain.handle('setup:open-official-site', async (event) => {
    requireMainFrame(event);
    await shell.openExternal('https://slippi.gg/downloads');
  });
  ipcMain.handle('app:open-notices', async (event) => {
    requireMainFrame(event);
    const path = app.isPackaged
      ? join(process.resourcesPath, 'third-party', 'NOTICES.md')
      : join(app.getAppPath(), 'third-party', 'NOTICES.md');
    const file = await lstat(path);
    if (!file.isFile()) throw new Error('Third-party notices are unavailable.');
    const error = await shell.openPath(path);
    if (error) throw new Error('Could not open third-party notices.');
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 850,
    minHeight: 620,
    backgroundColor: '#111d21',
    title: 'Melee Replay',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else mainWindow.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
}

if (!squirrelStartup) app.whenReady().then(async () => {
  library = await Library.open(join(app.getPath('userData'), 'library.sqlite'));
  await detectLocalSetup();
  practice = new PracticeController({
    library, userDataDir: app.getPath('userData'), resolveItem: resolvePracticeItem,
    runtimePaths,
    publish: (view) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('session:changed', view); }
  });
  createWindow();
  registerIpc();
  powerMonitor.on('suspend', () => practice.suspend());
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((error: unknown) => {
  dialog.showErrorBox('Melee Replay could not start', error instanceof Error ? error.message : 'Unknown startup error.');
  app.quit();
});

let quitReady = false;
if (!squirrelStartup) app.on('window-all-closed', () => { app.quit(); });
if (!squirrelStartup) app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  void (async () => {
    try { await practice?.shutdown(); }
    finally {
      library?.close();
      quitReady = true;
      app.quit();
    }
  })();
});
