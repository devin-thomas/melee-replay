export interface ReplayCard {
  id: string;
  kind: 'standalone' | 'set';
  playerA: string;
  playerB: string;
  openingA: string;
  openingB: string;
  event: string | null;
  playedAt: string | null;
  availability: 'ready' | 'missing' | 'downloadable';
  practiceStatus: 'unseen' | 'incomplete' | 'completed';
  sourceArchiveMiB?: number;
}

export interface SetupView {
  playbackDolphin: string | null;
  gameImage: string | null;
}

export interface AppSnapshot {
  cards: ReplayCard[];
  setup: SetupView;
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
  acquireCatalogItem(itemId: string): Promise<void>;
  cancelAcquisition(): Promise<void>;
  onAcquisitionPhase(callback: (phase: 'preparing' | 'downloading' | 'verifying' | 'ready') => void): () => void;
  choosePlaybackDolphin(): Promise<SetupView>;
  chooseGameImage(): Promise<SetupView>;
  openSlippiSetup(): Promise<void>;
}
