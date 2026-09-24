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
}];

describe('reviewed catalog data', () => {
  it('validates standalone and complete-set items against compiled approval scopes', () => {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    const catalog = validateCatalogManifest(raw, approved);
    const standalone = catalog.items.filter((item) => item.kind === 'standalone');
    const sets = catalog.items.filter((item) => item.kind === 'set');
    expect(standalone).toHaveLength(60);
    expect(sets).toHaveLength(1);
    expect(standalone.every((item) =>
      item.openingCharacters.length === 2 &&
      item.openingCharacters.every((character) => character.length > 0))).toBe(true);
    expect(catalog.replays.filter((replay) => !replay.zipEntryPath).every((replay) =>
      replay.participants.player1 === 'Unknown Player 1' &&
      replay.participants.player2 === 'Unknown Player 2')).toBe(true);
  });
});
