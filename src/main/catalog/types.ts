export const MAX_REPLAY_BYTES = 256 * 1024 * 1024;
export const MAX_PACK_BYTES = 512 * 1024 * 1024;

export interface ApprovedSourceScope {
  sourceId: string;
  downloadScopes: readonly { origin: string; pathPrefix: string }[];
  redirectScopes: readonly { origin: string; pathPrefix: string }[];
}

export interface SourcePolicy {
  sourceId: string;
  publisher: string;
  evidenceUrls: string[];
  accessConditions: string;
  useConditions: string;
  reviewedAt: string;
  auditReference: string;
  downloadScopes: { origin: string; pathPrefix: string }[];
  redirectScopes: { origin: string; pathPrefix: string }[];
  eligibility: 'eligible' | 'withdrawn';
}

export interface AssetRecord {
  assetId: string;
  sourceId: string;
  format: 'slp' | 'zip';
  fetchUrl: string;
  sha256: string;
  byteSize: number;
  objectRevision?: string;
}

export interface ReplayRecord {
  replayId: string;
  assetId: string;
  zipEntryPath?: string;
  sha256: string;
  byteSize: number;
  formatEvidence: string;
  participants: { player1: string; player2: string };
  sourceIdentity: string;
  aliases: string[];
}

export interface StandaloneItem {
  itemId: string;
  kind: 'standalone';
  replayId: string;
  openingCharacters: [string, string];
  safeContext: string;
  provenance: string;
}

export interface SetSegment {
  replayId: string;
  order: number;
  group: string;
  player1Entrant: 'A' | 'B';
  player2Entrant: 'A' | 'B';
  scoreEffect: 'none' | 'entrantA' | 'entrantB';
}

export interface VerificationRecord {
  method: 'organizer-export' | 'reviewed-source-crosscheck';
  sourceReferences: string[];
  reviewer: string;
  verifiedAt: string;
  manifestRevision: string;
  orderedAssetHashes: string[];
  completenessEvidence: string;
  decisions: string;
}

export interface SetItem {
  itemId: string;
  kind: 'set';
  sourceSetIdentity: string;
  eventContext: string;
  entrantA: string;
  entrantB: string;
  bestOf: 3 | 5 | null;
  completionRule: 'target-wins' | 'verified-source-terminal';
  segments: SetSegment[];
  verification: VerificationRecord;
  sourceResult: { entrantA: number; entrantB: number };
}

export type PracticeItem = StandaloneItem | SetItem;

export interface CuratedCatalog {
  schemaVersion: 1;
  catalogRevision: string;
  generatedAt: string;
  sources: SourcePolicy[];
  assets: AssetRecord[];
  replays: ReplayRecord[];
  items: PracticeItem[];
}
