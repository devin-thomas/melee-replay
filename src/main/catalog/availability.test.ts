import { expect, it } from 'vitest';
import { catalogOpeningReady } from './availability';
import type { SetItem } from './types';

function itemWithTail(replayIds: string[]): SetItem {
  return {
    itemId: 'synthetic-item', kind: 'set', sourceSetIdentity: 'synthetic-source',
    eventContext: 'Synthetic event', entrantA: 'A', entrantB: 'B', bestOf: 5,
    completionRule: 'target-wins',
    segments: replayIds.map((replayId, index) => ({
      replayId, order: index + 1, group: 'synthetic-group',
      player1Entrant: 'A', player2Entrant: 'B',
      openingCharacters: ['First character', 'Second character'], scoreEffect: 'none',
    })),
    verification: {
      method: 'reviewed-source-crosscheck', sourceReferences: [], reviewer: 'test',
      verifiedAt: '2026-01-01T00:00:00Z', manifestRevision: 'test',
      orderedAssetHashes: [], completenessEvidence: 'test', decisions: 'test',
    },
    sourceResult: { entrantA: 0, entrantB: 0 },
  };
}

it('does not expose cached unseen members through catalog card availability', () => {
  const ready = new Set(['opening', 'short-tail']);
  const short = itemWithTail(['opening', 'short-tail']);
  const long = itemWithTail(['opening', 'long-tail', 'later-tail']);
  const seen: string[] = [];
  const isReady = (replayId: string): boolean => { seen.push(replayId); return ready.has(replayId); };
  expect(catalogOpeningReady(short, isReady)).toBe(true);
  expect(catalogOpeningReady(long, isReady)).toBe(true);
  expect(seen).toEqual(['opening', 'opening']);
  ready.delete('opening');
  expect(catalogOpeningReady(short, isReady)).toBe(false);
  expect(catalogOpeningReady(long, isReady)).toBe(false);
});
