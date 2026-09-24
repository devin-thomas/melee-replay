import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Library } from './library';
import { parseReplayInWorker } from './replay-import';
import sampleCatalog from '../../data/catalog-v1.json';
import { createPracticeCard, type PracticeItem as DomainPracticeItem } from '../core';
import { acquireSelectedItem, CatalogAcquisitionError } from './catalog/acquire';
import { extractSelectedReplays } from './catalog/extract';
import { validateCatalogManifest } from './catalog/manifest';
import type { ApprovedSourceScope, PracticeItem as CatalogPracticeItem } from './catalog/types';
import type { AppSnapshot, ImportSummary, ReplayCard, SetupView } from '../shared/api';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const MAX_IMPORT_FILES = 500;
let mainWindow: BrowserWindow;
let library: Library;
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
    context: { entrants: [item.entrantA, item.entrantB], openingCharacters: [null, null],
      event: item.eventContext },
    segments: item.segments.map((segment, index) => {
      const replay = catalogReplays.get(segment.replayId)!;
      return { replayId: replay.replayId, exposureKey: replay.sha256,
        officialGameNumber: index + 1, characters: [null, null], scoreEffect: segment.scoreEffect };
    })
  };
}

function sharedCard(item: DomainPracticeItem, availability: 'ready' | 'downloadable' | 'unavailable',
  sourceArchiveMiB?: number): ReplayCard {
  const card = createPracticeCard(item, [], [], availability);
  return {
    id: card.itemId, kind: card.kind,
    playerA: card.context.entrants[0], playerB: card.context.entrants[1],
    openingA: card.context.openingCharacters[0] || 'Unknown',
    openingB: card.context.openingCharacters[1] || 'Unknown',
    event: card.context.event || null, playedAt: card.context.date || null,
    availability: card.availability === 'unavailable' ? 'missing' : card.availability,
    practiceStatus: card.status,
    ...(sourceArchiveMiB === undefined ? {} : { sourceArchiveMiB })
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

function snapshot(): AppSnapshot {
  const local = library.list();
  const localByHash = new Map(local.map((record) => [record.hash, record]));
  const catalogHashes = new Set(catalog.replays.map((replay) => replay.sha256));
  const cards: ReplayCard[] = catalog.items.map((item) => {
    const replayIds = item.kind === 'standalone' ? [item.replayId] : item.segments.map((segment) => segment.replayId);
    const ready = replayIds.every((id) => localByHash.get(catalogReplays.get(id)!.sha256)?.available);
    const sourceArchiveMiB = item.kind === 'set'
      ? Math.ceil(catalogAssets.get(catalogReplays.get(item.segments[0].replayId)!.assetId)!.byteSize / 1048576)
      : undefined;
    return sharedCard(domainItem(item), ready ? 'ready' : 'downloadable', sourceArchiveMiB);
  });
  for (const record of local) {
    if (catalogHashes.has(record.hash)) continue;
    cards.push(sharedCard({
      itemId: record.id, revision: record.hash, kind: 'standalone',
      context: { entrants: [record.playerA, record.playerB],
        openingCharacters: [record.characterA, record.characterB], date: record.playedAt || undefined },
      segment: { replayId: record.id, exposureKey: record.hash,
        officialGameNumber: 1, characters: [record.characterA, record.characterB], scoreEffect: 'none' }
    }, record.available ? 'ready' : 'unavailable'));
  }
  return { cards, setup: setupView() };
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
  ipcMain.handle('setup:choose-runtime', async (event) => {
    requireMainFrame(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Playback Dolphin', extensions: ['exe'] }]
    });
    if (!result.canceled) {
      const path = result.filePaths[0];
      const stat = await lstat(path);
      if (!stat.isFile() || !/^Dolphin.*\.exe$/i.test(basename(path))) throw new Error('Select a Slippi Playback Dolphin executable.');
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
      if (!stat.isFile() || !['.iso', '.gcm'].includes(extname(path).toLowerCase())) throw new Error('Select a supported game image.');
      library.setSetting('gameImage', path);
    }
    return setupView();
  });
  ipcMain.handle('setup:open-official-site', async (event) => {
    requireMainFrame(event);
    await shell.openExternal('https://slippi.gg/downloads');
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

app.whenReady().then(async () => {
  library = await Library.open(join(app.getPath('userData'), 'library.sqlite'));
  createWindow();
  registerIpc();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((error: unknown) => {
  dialog.showErrorBox('Melee Replay could not start', error instanceof Error ? error.message : 'Unknown startup error.');
  app.quit();
});

app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', () => { library?.close(); });
