import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateCatalogManifest } from '../src/main/catalog/manifest.js';
import type { ApprovedSourceScope } from '../src/main/catalog/types.js';

const manifestPath = fileURLToPath(new URL('./catalog-v1.json', import.meta.url));
const approved: ApprovedSourceScope[] = [{
  sourceId: 'huggingface-slippi-public-v3.7',
  downloadScopes: [{
    origin: 'https://huggingface.co',
    pathPrefix: '/datasets/erickfm/slippi-public-dataset-v3.7/resolve/c82be5f6e43f3388555cfe0cf8652580601f396d/',
  }],
  redirectScopes: [{ origin: 'https://us.aws.cdn.hf.co', pathPrefix: '/xet-bridge-us/' }],
}, {
  sourceId: 'slippi-official-summit-11',
  downloadScopes: [{
    origin: 'https://storage.googleapis.com',
    pathPrefix: '/slippi.appspot.com/replays/bundles/',
  }],
  redirectScopes: [],
}, {
  sourceId: 'ausmash-public-results',
  downloadScopes: [{
    origin: 'https://ausmashstorage.blob.core.windows.net',
    pathPrefix: '/ausmash-content/',
  }],
  redirectScopes: [],
}];

describe('reviewed catalog data', () => {
  it('validates standalone and complete-set items against compiled approval scopes', () => {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    const catalog = validateCatalogManifest(raw, approved);
    const standalone = catalog.items.filter((item) => item.kind === 'standalone');
    const sets = catalog.items.filter((item) => item.kind === 'set');
    expect(standalone).toHaveLength(60);
    expect(sets).toHaveLength(11);
    expect(sets.filter((item) => item.bestOf === 3)).toHaveLength(2);
    expect(sets.every((item) => item.segments.every((segment) =>
      segment.openingCharacters.length === 2 &&
      segment.openingCharacters.every((character) => character.length > 0)))).toBe(true);
    const setReplayIds = sets.flatMap((item) => item.segments.map((segment) => segment.replayId));
    expect(new Set(setReplayIds).size).toBe(setReplayIds.length);
    expect(standalone.every((item) =>
      item.openingCharacters.length === 2 &&
      item.openingCharacters.every((character) => character.length > 0))).toBe(true);
    const standaloneReplayIds = new Set(standalone.map((item) => item.replayId));
    expect(catalog.replays.filter((replay) => standaloneReplayIds.has(replay.replayId)).every((replay) =>
      replay.participants.player1 === 'Unknown Player 1' &&
      replay.participants.player2 === 'Unknown Player 2')).toBe(true);
  });

  it('rejects missing or unsafe verified-set opening characters', () => {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      items: Array<{ kind: string; segments?: Array<{ openingCharacters: string[] }> }>;
    };
    const segment = raw.items.find((item) => item.kind === 'set')?.segments?.[0];
    if (!segment) throw new Error('Reviewed set fixture is missing.');
    segment.openingCharacters = ['Fox'];
    expect(() => validateCatalogManifest(raw, approved)).toThrow();
    segment.openingCharacters = ['Fox', 'Falco\nunsafe'];
    expect(() => validateCatalogManifest(raw, approved)).toThrow();
  });
});
