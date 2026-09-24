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
}];

describe('reviewed standalone catalog data', () => {
  it('validates 60 standalone items against the compiled approval scope', () => {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    const catalog = validateCatalogManifest(raw, approved);
    expect(catalog.assets).toHaveLength(60);
    expect(catalog.replays).toHaveLength(60);
    expect(catalog.items).toHaveLength(60);
    expect(catalog.items.every((item) => item.kind === 'standalone')).toBe(true);
    expect(catalog.items.every((item) => item.kind === 'standalone' &&
      item.openingCharacters.length === 2 &&
      item.openingCharacters.every((character) => character.length > 0))).toBe(true);
    expect(catalog.replays.every((replay) =>
      replay.participants.player1 === 'Unknown Player 1' &&
      replay.participants.player2 === 'Unknown Player 2')).toBe(true);
  });
});
