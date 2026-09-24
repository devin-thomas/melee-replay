import { contextBridge, ipcRenderer } from 'electron';
import type { MeleeBridge } from './shared/api';
import type { SessionView } from './core/session';

const bridge: MeleeBridge = {
  snapshot: () => ipcRenderer.invoke('library:snapshot'),
  importFiles: () => ipcRenderer.invoke('library:import-files'),
  importFolder: () => ipcRenderer.invoke('library:import-folder'),
  importReporterPackage: () => ipcRenderer.invoke('library:import-package'),
  removeIndexedReplay: (replayId) => ipcRenderer.invoke('library:remove-indexed', replayId),
  relinkReplay: (replayId) => ipcRenderer.invoke('library:relink', replayId),
  findReplayInFolder: (replayId) => ipcRenderer.invoke('library:rescan', replayId),
  clearDownloadCache: () => ipcRenderer.invoke('library:clear-download-cache'),
  acquireCatalogItem: (itemId) => ipcRenderer.invoke('catalog:acquire', itemId),
  cancelAcquisition: () => ipcRenderer.invoke('catalog:cancel'),
  onAcquisitionPhase: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, phase: 'preparing' | 'downloading' | 'verifying' | 'ready') => callback(phase);
    ipcRenderer.on('catalog:phase', listener);
    return () => ipcRenderer.removeListener('catalog:phase', listener);
  },
  choosePlaybackDolphin: () => ipcRenderer.invoke('setup:choose-runtime'),
  chooseGameImage: () => ipcRenderer.invoke('setup:choose-image'),
  recheckSetup: () => ipcRenderer.invoke('setup:recheck'),
  openSlippiSetup: () => ipcRenderer.invoke('setup:open-official-site'),
  openThirdPartyNotices: () => ipcRenderer.invoke('app:open-notices'),
  startPractice: (itemId) => ipcRenderer.invoke('session:start', itemId),
  sessionCommand: (command) => ipcRenderer.invoke('session:command', command),
  onSessionChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, view: SessionView) => callback(view);
    ipcRenderer.on('session:changed', listener);
    return () => ipcRenderer.removeListener('session:changed', listener);
  }
};

contextBridge.exposeInMainWorld('melee', bridge);
