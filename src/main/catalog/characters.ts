import type { SetSegment } from './types.js';

/** Replay parsers enumerate players by port; session copy uses entrant A/B order. */
export function entrantOrderedCharacters(
  segment: Pick<SetSegment, 'player1Entrant' | 'player2Entrant'>,
  portOrdered: readonly [string, string],
): [string, string] {
  if (segment.player1Entrant === segment.player2Entrant) {
    throw new Error('Invalid entrant mapping for set segment.');
  }
  return segment.player1Entrant === 'A'
    ? [portOrdered[0], portOrdered[1]]
    : [portOrdered[1], portOrdered[0]];
}
