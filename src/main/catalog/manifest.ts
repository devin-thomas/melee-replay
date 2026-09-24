import { isIP } from 'node:net';
import {
  MAX_PACK_BYTES,
  MAX_REPLAY_BYTES,
  type ApprovedSourceScope,
  type AssetRecord,
  type CuratedCatalog,
  type PracticeItem,
  type ReplayRecord,
  type SetItem,
  type SetSegment,
  type SourcePolicy,
  type StandaloneItem,
  type VerificationRecord,
} from './types.js';

export class CatalogValidationError extends Error {
  constructor() {
    super('Catalog data is invalid or unavailable.');
    this.name = 'CatalogValidationError';
  }
}

const invalid = (): never => { throw new CatalogValidationError(); };
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : invalid();
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : invalid();
const text = (value: unknown, max = 2048): string =>
  typeof value === 'string' && value.length > 0 && value.length <= max &&
  !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
    ? value : invalid();
const id = (value: unknown): string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)
    ? value : invalid();
const hash = (value: unknown): string =>
  typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value) ? value.toLowerCase() : invalid();
const size = (value: unknown, max: number): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max
    ? value : invalid();
const timestamp = (value: unknown): string => {
  const result = text(value, 40);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(result) ||
      Number.isNaN(Date.parse(result))) invalid();
  return result;
};
const choice = <T extends string>(value: unknown, choices: readonly T[]): T =>
  typeof value === 'string' && choices.includes(value as T) ? value as T : invalid();
const list = <T>(value: unknown, parse: (v: unknown) => T, max = 10000): T[] => {
  const values = array(value);
  if (values.length > max) invalid();
  return values.map(parse);
};
const unique = (values: readonly string[]): void => {
  if (new Set(values).size !== values.length) invalid();
};

function safePath(raw: string): void {
  if (raw.includes('\\') || /%(?:2e|2f|5c|25|3a|3f|23)/i.test(raw) ||
      /%(?![a-fA-F0-9]{2})/.test(raw)) invalid();
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return invalid(); }
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\\%]/u.test(decoded) ||
      decoded.split('/').some((part) => part === '.' || part === '..')) invalid();
}

function safeHttpsUrl(value: unknown, allowQuery = false): URL {
  const raw = text(value, 8192);
  if (!raw.startsWith('https://') || raw !== raw.trim() || raw.includes('\\')) invalid();
  const path = /^https:\/\/[^/?#]+([^?#]*)/i.exec(raw)?.[1] ?? '';
  safePath(path);
  let url: URL;
  try { url = new URL(raw); } catch { return invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (!allowQuery && url.search) || !url.hostname.includes('.') || isIP(url.hostname) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/i.test(url.hostname) ||
      url.hostname.endsWith('.')) invalid();
  return url;
}

function scope(value: unknown): { origin: string; pathPrefix: string } {
  const entry = object(value);
  const originUrl = safeHttpsUrl(entry.origin);
  if (originUrl.pathname !== '/' || originUrl.search) invalid();
  const pathPrefix = text(entry.pathPrefix, 1024);
  if (!pathPrefix.startsWith('/') || pathPrefix.includes('\\') ||
      pathPrefix.includes('%') || pathPrefix.split('/').includes('..') ||
      pathPrefix.includes('?') || pathPrefix.includes('#')) invalid();
  return { origin: originUrl.origin, pathPrefix };
}

function within(url: URL, scopes: readonly { origin: string; pathPrefix: string }[]): boolean {
  return scopes.some(({ origin, pathPrefix }) => url.origin === origin &&
    (url.pathname === pathPrefix || url.pathname.startsWith(pathPrefix.endsWith('/')
      ? pathPrefix : `${pathPrefix}/`)));
}

export function assertApprovedUrl(
  value: string,
  source: SourcePolicy,
  approved: ApprovedSourceScope,
  redirect = false,
): URL {
  const url = safeHttpsUrl(value, redirect);
  const manifestScopes = redirect
    ? url.search ? source.redirectScopes : [...source.downloadScopes, ...source.redirectScopes]
    : source.downloadScopes;
  const trustedScopes = redirect
    ? url.search ? approved.redirectScopes : [...approved.downloadScopes, ...approved.redirectScopes]
    : approved.downloadScopes;
  if (source.sourceId !== approved.sourceId ||
      !within(url, manifestScopes) || !within(url, trustedScopes)) invalid();
  return url;
}

function parseSource(value: unknown, approvedSources: readonly ApprovedSourceScope[]): SourcePolicy {
  const data = object(value);
  const sourceId = id(data.sourceId);
  const approved = approvedSources.find((entry) => entry.sourceId === sourceId);
  if (!approved) return invalid();
  const downloadScopes = list(data.downloadScopes, scope, 20);
  const redirectScopes = list(data.redirectScopes, scope, 20);
  if (!downloadScopes.length || downloadScopes.some((entry) =>
    !approved.downloadScopes.some((scope) => scope.origin === entry.origin && scope.pathPrefix === entry.pathPrefix)) ||
    redirectScopes.some((entry) => !approved.redirectScopes.some((scope) =>
      scope.origin === entry.origin && scope.pathPrefix === entry.pathPrefix))) invalid();
  const evidenceUrls = list(data.evidenceUrls, (v) => safeHttpsUrl(v, true).toString(), 20);
  if (!evidenceUrls.length) invalid();
  return {
    sourceId,
    publisher: text(data.publisher, 200),
    evidenceUrls,
    accessConditions: text(data.accessConditions),
    useConditions: text(data.useConditions),
    reviewedAt: timestamp(data.reviewedAt),
    auditReference: text(data.auditReference, 500),
    downloadScopes,
    redirectScopes,
    eligibility: choice(data.eligibility, ['eligible', 'withdrawn']),
  };
}

function parseAsset(value: unknown, sources: Map<string, SourcePolicy>,
  approvals: Map<string, ApprovedSourceScope>): AssetRecord {
  const data = object(value);
  const sourceId = id(data.sourceId);
  const source = sources.get(sourceId);
  const approved = approvals.get(sourceId);
  if (!source || !approved) return invalid();
  const format = choice(data.format, ['slp', 'zip']);
  const fetchUrl = text(data.fetchUrl, 8192);
  assertApprovedUrl(fetchUrl, source, approved);
  return {
    assetId: id(data.assetId), sourceId, format, fetchUrl,
    sha256: hash(data.sha256),
    byteSize: size(data.byteSize, format === 'slp' ? MAX_REPLAY_BYTES : MAX_PACK_BYTES),
    ...(data.objectRevision === undefined ? {} : { objectRevision: text(data.objectRevision, 200) }),
  };
}

function zipPath(value: unknown): string {
  const path = text(value, 1024);
  if (path.startsWith('/') || path.startsWith('\\') || path.includes('\\') ||
      path.includes(':') || path.split('/').some((p) => p === '' || p === '.' || p === '..') ||
      !path.toLowerCase().endsWith('.slp')) invalid();
  return path;
}

function parseReplay(value: unknown, assets: Map<string, AssetRecord>): ReplayRecord {
  const data = object(value);
  const assetId = id(data.assetId);
  const asset = assets.get(assetId);
  if (!asset) return invalid();
  const sha256 = hash(data.sha256);
  const byteSize = size(data.byteSize, MAX_REPLAY_BYTES);
  if (asset.format === 'slp' && (data.zipEntryPath !== undefined ||
      asset.sha256 !== sha256 || asset.byteSize !== byteSize)) invalid();
  if (asset.format === 'zip' && data.zipEntryPath === undefined) invalid();
  const participants = object(data.participants);
  return {
    replayId: id(data.replayId), assetId,
    ...(asset.format === 'zip' ? { zipEntryPath: zipPath(data.zipEntryPath) } : {}),
    sha256, byteSize,
    formatEvidence: text(data.formatEvidence, 500),
    participants: { player1: text(participants.player1, 200), player2: text(participants.player2, 200) },
    sourceIdentity: text(data.sourceIdentity, 500),
    aliases: list(data.aliases, (v) => text(v, 500), 50),
  };
}

function parseVerification(value: unknown, revision: string, segments: SetSegment[],
  replays: Map<string, ReplayRecord>, assets: Map<string, AssetRecord>): VerificationRecord {
  const data = object(value);
  const orderedAssetHashes = list(data.orderedAssetHashes, hash, 256);
  const expected = segments.map((segment) => assets.get(replays.get(segment.replayId)!.assetId)!.sha256);
  if (data.manifestRevision !== revision || orderedAssetHashes.length !== expected.length ||
      orderedAssetHashes.some((value, index) => value !== expected[index])) invalid();
  const sourceReferences = list(data.sourceReferences, (v) => safeHttpsUrl(v, true).toString(), 20);
  if (!sourceReferences.length) invalid();
  return {
    method: choice(data.method, ['organizer-export', 'reviewed-source-crosscheck']),
    sourceReferences,
    reviewer: text(data.reviewer, 200),
    verifiedAt: timestamp(data.verifiedAt),
    manifestRevision: revision,
    orderedAssetHashes,
    completenessEvidence: text(data.completenessEvidence),
    decisions: text(data.decisions),
  };
}

function parseItem(value: unknown, revision: string, replays: Map<string, ReplayRecord>,
  assets: Map<string, AssetRecord>): PracticeItem {
  const data = object(value);
  const itemId = id(data.itemId);
  const kind = choice(data.kind, ['standalone', 'set']);
  if (kind === 'standalone') {
    const replayId = id(data.replayId);
    if (!replays.has(replayId)) invalid();
    const characters = array(data.openingCharacters);
    if (characters.length !== 2) invalid();
    return { itemId, kind, replayId,
      openingCharacters: [text(characters[0], 100), text(characters[1], 100)],
      safeContext: text(data.safeContext, 500),
      provenance: text(data.provenance, 500) } satisfies StandaloneItem;
  }
  const rawSegments = list(data.segments, object, 256);
  if (!rawSegments.length) invalid();
  const segments: SetSegment[] = rawSegments.map((raw) => {
    const replayId = id(raw.replayId);
    if (!replays.has(replayId)) invalid();
    const order = size(raw.order, 256);
    const player1Entrant = choice(raw.player1Entrant, ['A', 'B']);
    const player2Entrant = choice(raw.player2Entrant, ['A', 'B']);
    if (player1Entrant === player2Entrant) invalid();
    return { replayId, order, group: id(raw.group), player1Entrant, player2Entrant,
      scoreEffect: choice(raw.scoreEffect, ['none', 'entrantA', 'entrantB']) };
  });
  unique(segments.map((s) => s.replayId));
  if (segments.some((s, index) => s.order !== index + 1)) invalid();
  const result = object(data.sourceResult);
  const entrantA = result.entrantA;
  const entrantB = result.entrantB;
  if (!Number.isSafeInteger(entrantA) || !Number.isSafeInteger(entrantB) ||
      (entrantA as number) < 0 || (entrantB as number) < 0) invalid();
  const scoreA = segments.filter((s) => s.scoreEffect === 'entrantA').length;
  const scoreB = segments.filter((s) => s.scoreEffect === 'entrantB').length;
  if (scoreA !== entrantA || scoreB !== entrantB || scoreA === scoreB) invalid();
  const bestOf = data.bestOf === null ? null : data.bestOf === 3 || data.bestOf === 5 ? data.bestOf : invalid();
  const completionRule = choice(data.completionRule, ['target-wins', 'verified-source-terminal']);
  if ((bestOf === null) !== (completionRule === 'verified-source-terminal')) invalid();
  if (bestOf !== null && Math.max(scoreA, scoreB) !== Math.floor(bestOf / 2) + 1) invalid();
  if (bestOf !== null) {
    const target = Math.floor(bestOf / 2) + 1;
    let a = 0;
    let b = 0;
    for (const [index, segment] of segments.entries()) {
      if (segment.scoreEffect === 'entrantA') a++;
      if (segment.scoreEffect === 'entrantB') b++;
      if (index < segments.length - 1 && (a >= target || b >= target)) invalid();
    }
  }
  if (new Set(segments.map((s) => assets.get(replays.get(s.replayId)!.assetId)!.sourceId)).size !== 1) invalid();
  const verification = parseVerification(data.verification, revision, segments, replays, assets);
  return {
    itemId, kind,
    sourceSetIdentity: text(data.sourceSetIdentity, 500),
    eventContext: text(data.eventContext, 500),
    entrantA: text(data.entrantA, 200), entrantB: text(data.entrantB, 200),
    bestOf, completionRule, segments, verification,
    sourceResult: { entrantA: scoreA, entrantB: scoreB },
  } satisfies SetItem;
}

export function validateCatalogManifest(input: unknown,
  approvedSources: readonly ApprovedSourceScope[]): CuratedCatalog {
  const data = object(input);
  if (data.schemaVersion !== 1) invalid();
  const catalogRevision = id(data.catalogRevision);
  const generatedAt = timestamp(data.generatedAt);
  unique(approvedSources.map((source) => source.sourceId));
  const sources = list(data.sources, (v) => parseSource(v, approvedSources), 100);
  unique(sources.map((source) => source.sourceId));
  const sourceMap = new Map(sources.map((source) => [source.sourceId, source]));
  const approvals = new Map(approvedSources.map((source) => [source.sourceId, source]));
  const assets = list(data.assets, (v) => parseAsset(v, sourceMap, approvals), 10000);
  unique(assets.map((asset) => asset.assetId));
  const assetMap = new Map(assets.map((asset) => [asset.assetId, asset]));
  const replays = list(data.replays, (v) => parseReplay(v, assetMap), 10000);
  unique(replays.map((replay) => replay.replayId));
  const entryKeys = replays.filter((replay) => replay.zipEntryPath).map((replay) =>
    `${replay.assetId}\0${replay.zipEntryPath!.toLowerCase()}`);
  unique(entryKeys);
  const replayMap = new Map(replays.map((replay) => [replay.replayId, replay]));
  const items = list(data.items, (v) => parseItem(v, catalogRevision, replayMap, assetMap), 10000);
  unique(items.map((item) => item.itemId));
  if (items.some((item) => {
    const ids = item.kind === 'standalone' ? [item.replayId] : item.segments.map((s) => s.replayId);
    return ids.some((replayId) => sourceMap.get(assetMap.get(replayMap.get(replayId)!.assetId)!.sourceId)?.eligibility !== 'eligible');
  })) invalid();
  return { schemaVersion: 1, catalogRevision, generatedAt, sources, assets, replays, items };
}
