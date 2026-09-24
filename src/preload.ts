import { contextBridge, ipcRenderer } from 'electron';
import type { MeleeBridge } from './shared/api';

const bridge: MeleeBridge = {
  snapshot: () => ipcRenderer.invoke('library:snapshot'),
  importFiles: () => ipcRenderer.invoke('library:import-files'),
  importFolder: () => ipcRenderer.invoke('library:import-folder'),
  acquireCatalogItem: (itemId) => ipcRenderer.invoke('catalog:acquire', itemId),
  cancelAcquisition: () => ipcRenderer.invoke('catalog:cancel'),
  onAcquisitionPhase: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, phase: 'preparing' | 'downloading' | 'verifying' | 'ready') => callback(phase);
    ipcRenderer.on('catalog:phase', listener);
    return () => ipcRenderer.removeListener('catalog:phase', listener);
  },
  choosePlaybackDolphin: () => ipcRenderer.invoke('setup:choose-runtime'),
  chooseGameImage: () => ipcRenderer.invoke('setup:choose-image'),
  openSlippiSetup: () => ipcRenderer.invoke('setup:open-official-site')
};

contextBridge.exposeInMainWorld('melee', bridge);
