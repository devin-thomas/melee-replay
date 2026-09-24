import type { PracticeItem } from './types';

/** A catalog card reveals only whether its opening replay is cached. */
export function catalogOpeningReady(item: PracticeItem, replayReady: (replayId: string) => boolean): boolean {
  const openingReplayId = item.kind === 'set' ? item.segments[0]?.replayId : item.replayId;
  if (!openingReplayId) throw new Error('Catalog item has no opening replay.');
  return replayReady(openingReplayId);
}
