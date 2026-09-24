import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import packagedCatalog from '../../../data/catalog-v1.json';
import { acquireSelectedItem } from './acquire.js';
import { assertApprovedUrl, CatalogValidationError, validateCatalogManifest } from './manifest.js';
import type { ApprovedSourceScope, SourcePolicy } from './types.js';

const bytes = Buffer.from('replay test bytes');
const digest = createHash('sha256').update(bytes).digest('hex');
const approved: ApprovedSourceScope[] = [{
  sourceId: 'publisher-1',
  downloadScopes: [{ origin: 'https://replays.example.com', pathPrefix: '/files/' }],
  redirectScopes: [],
}];
const packagedApproval: ApprovedSourceScope = {
  sourceId: 'huggingface-slippi-public-v3.7',
  downloadScopes: [{ origin: 'https://huggingface.co',
    pathPrefix: '/datasets/erickfm/slippi-public-dataset-v3.7/resolve/c82be5f6e43f3388555cfe0cf8652580601f396d/' }],
  redirectScopes: [{ origin: 'https://us.aws.cdn.hf.co', pathPrefix: '/xet-bridge-us/' }],
};

function fixture() {
  return {
    schemaVersion: 1,
    catalogRevision: 'revision-1',
    generatedAt: '2026-09-23T20:00:00Z',
    sources: [{
      sourceId: 'publisher-1', publisher: 'Example Publisher',
      evidenceUrls: ['https://publisher.example.com/catalog'],
      accessConditions: 'Public direct download', useConditions: 'Approved for this application',
      reviewedAt: '2026-09-23T19:00:00Z', auditReference: 'review-1',
      downloadScopes: [{ origin: 'https://replays.example.com', pathPrefix: '/files/' }],
      redirectScopes: [], eligibility: 'eligible',
    }],
    assets: [{ assetId: 'asset-1', sourceId: 'publisher-1', format: 'slp',
      fetchUrl: 'https://replays.example.com/files/replay.slp',
      sha256: digest, byteSize: bytes.length }],
    replays: [{ replayId: 'replay-1', assetId: 'asset-1', sha256: digest,
      byteSize: bytes.length, formatEvidence: 'Slippi replay',
      participants: { player1: 'A', player2: 'B' }, sourceIdentity: 'match-1', aliases: [] }],
    items: [{ itemId: 'item-1', kind: 'standalone', replayId: 'replay-1',
      openingCharacters: ['Fox', 'Falco'],
      safeContext: 'Friendly match', provenance: 'Publisher export' }],
  };
}

describe('curated catalog boundary', () => {
  it('admits the packaged standalone replay batch', () => {
    const catalog = validateCatalogManifest(packagedCatalog, [packagedApproval]);
    expect(catalog.items.length).toBeGreaterThanOrEqual(60);
    expect(catalog.items.every((item) => item.kind === 'standalone')).toBe(true);
  });
  it('accepts a reviewed, internally consistent manifest', () => {
    const catalog = validateCatalogManifest(fixture(), approved);
    expect(catalog.items[0].itemId).toBe('item-1');
    expect(catalog.items[0].kind === 'standalone' && catalog.items[0].openingCharacters)
      .toEqual(['Fox', 'Falco']);
  });

  it('requires exactly two safe opening character names', () => {
    const input = fixture();
    input.items[0].openingCharacters = ['Fox'];
    expect(() => validateCatalogManifest(input, approved)).toThrow(CatalogValidationError);
    input.items[0].openingCharacters = ['Fox', 'Falco\nspoiler'];
    expect(() => validateCatalogManifest(input, approved)).toThrow(CatalogValidationError);
  });

  it('rejects a manifest that tries to grant itself another host', () => {
    const input = fixture();
    input.sources[0].downloadScopes[0].origin = 'https://other.example.com';
    input.assets[0].fetchUrl = 'https://other.example.com/files/replay.slp';
    expect(() => validateCatalogManifest(input, approved)).toThrow(CatalogValidationError);
  });

  it('rejects broken references, credentials, query tokens and size mismatch', () => {
    const missing = fixture();
    missing.items[0].replayId = 'absent';
    expect(() => validateCatalogManifest(missing, approved)).toThrow(CatalogValidationError);
    const credential = fixture();
    credential.assets[0].fetchUrl = 'https://user:pass@replays.example.com/files/replay.slp';
    expect(() => validateCatalogManifest(credential, approved)).toThrow(CatalogValidationError);
    const query = fixture();
    query.assets[0].fetchUrl = 'https://replays.example.com/files/replay.slp?token=secret';
    expect(() => validateCatalogManifest(query, approved)).toThrow(CatalogValidationError);
    const mismatch = fixture();
    mismatch.replays[0].byteSize++;
    expect(() => validateCatalogManifest(mismatch, approved)).toThrow(CatalogValidationError);
  });

  it('permits reviewed encoded filenames and signed redirects only in redirect scope', () => {
    const canonical = 'https://huggingface.co/datasets/erickfm/slippi-public-dataset-v3.7/resolve/c82be5f6e43f3388555cfe0cf8652580601f396d/BOWSER/16_56_35%20%5B314%5D%20Kirby%20%2B%20Bowser%20%28YS%29.slp';
    const hfApproved: ApprovedSourceScope = {
      sourceId: 'hf',
      downloadScopes: [{ origin: 'https://huggingface.co',
        pathPrefix: '/datasets/erickfm/slippi-public-dataset-v3.7/resolve/c82be5f6e43f3388555cfe0cf8652580601f396d/' }],
      redirectScopes: [{ origin: 'https://us.aws.cdn.hf.co', pathPrefix: '/xet-bridge-us/' }],
    };
    const source: SourcePolicy = { ...fixture().sources[0], sourceId: 'hf', eligibility: 'eligible',
      downloadScopes: [...hfApproved.downloadScopes], redirectScopes: [...hfApproved.redirectScopes] };
    expect(assertApprovedUrl(canonical, source, hfApproved).pathname).toContain('%20%5B314%5D');
    expect(assertApprovedUrl('https://us.aws.cdn.hf.co/xet-bridge-us/object?X-Amz-Signature=opaque',
      source, hfApproved, true).hostname).toBe('us.aws.cdn.hf.co');
    expect(() => assertApprovedUrl(`${canonical}?token=private`, source, hfApproved)).toThrow(CatalogValidationError);
    expect(() => assertApprovedUrl(`${canonical}?token=private`, source, hfApproved, true)).toThrow(CatalogValidationError);
    expect(() => assertApprovedUrl('https://other.aws.cdn.hf.co/xet-bridge-us/object?signature=opaque',
      source, hfApproved, true)).toThrow(CatalogValidationError);
    for (const escaped of ['%2e%2e', '%2f', '%5c', '%00', '%252e']) {
      expect(() => assertApprovedUrl(`${canonical}/${escaped}/x`, source, hfApproved)).toThrow(CatalogValidationError);
    }
  });
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('acquires only the selected cached asset and verifies its bytes', async () => {
  const input = fixture();
  input.assets.push({ ...input.assets[0], assetId: 'asset-2',
    fetchUrl: 'https://replays.example.com/files/unrelated.slp' });
  input.replays.push({ ...input.replays[0], replayId: 'replay-2', assetId: 'asset-2' });
  input.items.push({ ...input.items[0], itemId: 'item-2', replayId: 'replay-2' });
  const catalog = validateCatalogManifest(input, approved);
  const dir = await mkdtemp(join(tmpdir(), 'melee-catalog-test-'));
  directories.push(dir);
  const assetDir = join(dir, 'catalog-assets');
  await mkdir(assetDir);
  await writeFile(join(assetDir, `${digest}.slp`), bytes);
  const result = await acquireSelectedItem(catalog, 'item-1', dir, approved);
  expect(result).toEqual([{ assetId: 'asset-1', path: join(assetDir, `${digest}.slp`) }]);
});

it.skipIf(process.env.MELEE_LIVE_CATALOG_TEST !== '1')(
  'downloads one selected replay through the approved signed redirect', async () => {
    const catalog = validateCatalogManifest(packagedCatalog, [packagedApproval]);
    const dir = await mkdtemp(join(tmpdir(), 'melee-catalog-live-'));
    directories.push(dir);
    const result = await acquireSelectedItem(catalog, catalog.items[0].itemId, dir, [packagedApproval]);
    expect(result).toHaveLength(1);
  }, 120_000,
);
