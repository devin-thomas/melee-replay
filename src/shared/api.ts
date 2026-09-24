import type { SessionView } from '../core/session';

export interface ReplayCard {
  id: string;
  source: 'catalog' | 'local';
  kind: 'standalone' | 'set';
  playerA: string;
  playerB: string;
  openingA: string;
  openingB: string;
  event: string | null;
  playedAt: string | null;
  availability: 'ready' | 'missing' | 'downloadable';
  practiceStatus: 'unseen' | 'incomplete' | 'completed';
}

export interface SetupView {
  playbackDolphin: string | null;
  gameImage: string | null;
}

export interface PracticeHistoryEntry {
  attemptId: string;
  itemId: string;
  label: string;
  event: string | null;
  status: 'completed' | 'interrupted' | 'failed';
  requestedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface AppSnapshot {
  cards: ReplayCard[];
  history: PracticeHistoryEntry[];
  setup: SetupView;
  session: SessionView;
  managedStorage: { totalBytes: number; downloadCacheBytes: number };
}

export interface ImportSummary {
  scanned: number;
  imported: number;
  duplicates: number;
  rejected: number;
  cancelled: boolean;
}

export interface MeleeBridge {
  snapshot(): Promise<AppSnapshot>;
  importFiles(): Promise<ImportSummary>;
  importFolder(): Promise<ImportSummary>;
  importReporterPackage(): Promise<ImportSummary>;
  removeIndexedReplay(replayId: string): Promise<void>;
  relinkReplay(replayId: string): Promise<boolean>;
  findReplayInFolder(replayId: string): Promise<boolean>;
  clearDownloadCache(): Promise<number>;
  acquireCatalogItem(itemId: string): Promise<void>;
  cancelAcquisition(): Promise<void>;
  onAcquisitionPhase(callback: (phase: 'preparing' | 'downloading' | 'verifying' | 'ready') => void): () => void;
  choosePlaybackDolphin(): Promise<SetupView>;
  chooseGameImage(): Promise<SetupView>;
  recheckSetup(): Promise<SetupView>;
  openSlippiSetup(): Promise<void>;
  openThirdPartyNotices(): Promise<void>;
  startPractice(itemId: string): Promise<SessionView>;
  sessionCommand(command: 'stop' | 'hold' | 'next' | 'leave' | 'practice-again'): Promise<SessionView>;
  onSessionChanged(callback: (view: SessionView) => void): () => void;
}
