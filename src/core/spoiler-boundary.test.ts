import { describe, expect, it } from 'vitest';
import {
  chooseRandomUnseen,
  createPracticeCard,
  filterPracticeCards,
  initialSession,
  projectSession,
  transitionSession,
  type PracticeItem,
  type ReplaySegment,
  type SessionEvent,
  type SessionState,
} from './index';

const id = (last: number): string => `00000000-0000-4000-8000-${last.toString(16).padStart(12, '0')}`;
const attemptId = id(90);
const sharedReplayIds = [id(1), id(2)] as const;

function segment(replayId: string, number: number, scoreEffect: ReplaySegment['scoreEffect'],
  stage: string, character: string): ReplaySegment {
  return {
    replayId,
    exposureKey: `sha256:${replayId}`,
    officialGameNumber: number,
    stage,
    characters: [character, 'Shared character'],
    scoreEffect,
  };
}

function setWithUnseenTail(tail: 'short' | 'long'): PracticeItem {
  const common = [
    segment(sharedReplayIds[0], 1, 'entrantA', 'Opening stage', 'Opening character'),
    segment(sharedReplayIds[1], 2, 'entrantB', 'Second stage', 'Second character'),
  ];
  return {
    itemId: id(80),
    revision: 'same-revision',
    kind: 'set',
    verification: 'verified',
    format: 'bo5',
    terminalRule: { kind: 'target-wins', target: 3 },
    context: {
      event: 'Synthetic event',
      entrants: ['Entrant A', 'Entrant B'],
      openingCharacters: ['Opening character', 'Shared character'],
    },
    segments: tail === 'short'
      ? [
        ...common,
        segment(id(3), 3, 'entrantA', 'UNSEEN_SHORT_STAGE', 'UNSEEN_SHORT_CHARACTER'),
        segment(id(4), 4, 'entrantA', 'UNSEEN_SHORT_FINAL', 'UNSEEN_SHORT_FINAL_CHARACTER'),
      ]
      : [
        ...common,
        segment(id(5), 3, 'entrantB', 'UNSEEN_LONG_STAGE', 'UNSEEN_LONG_CHARACTER'),
        segment(id(6), 4, 'entrantA', 'UNSEEN_LONG_FOURTH', 'UNSEEN_LONG_FOURTH_CHARACTER'),
        segment(id(7), 5, 'entrantB', 'UNSEEN_LONG_FINAL', 'UNSEEN_LONG_FINAL_CHARACTER'),
      ],
  };
}

function advance(state: SessionState, event: SessionEvent, at: number): SessionState {
  return transitionSession(state, event, at).state;
}

function compareVisibleBoundary(left: SessionState, right: SessionState, at: number): void {
  const first = projectSession(left, at);
  const second = projectSession(right, at);
  expect(first).toEqual(second);
  const serialized = JSON.stringify(first);
  expect(serialized).not.toContain('UNSEEN_');
  expect(serialized).not.toContain('segments');
  expect(serialized).not.toContain('terminalRule');
  expect(serialized).not.toContain('scoreEffect');
  expect(serialized).not.toContain('exposureKey');
  expect(serialized).not.toContain('replayId');
  expect(serialized).not.toContain('lastFrame');
}

describe('same-prefix spoiler boundary', () => {
  it('keeps browse cards, filters, search, and random selection independent of unseen members', () => {
    const short = createPracticeCard(setWithUnseenTail('short'), [], [], 'ready');
    const long = createPracticeCard(setWithUnseenTail('long'), [], [], 'ready');
    expect(short).toEqual(long);
    expect(JSON.stringify(short)).not.toContain('UNSEEN_');
    expect(filterPracticeCards([short], { search: 'UNSEEN_' })).toEqual([]);
    expect(filterPracticeCards([long], { openingCharacter: 'UNSEEN_LONG_CHARACTER' })).toEqual([]);
    expect(filterPracticeCards([short], { search: 'Synthetic event' })).toEqual([short]);
    expect(chooseRandomUnseen([short], {}, () => 0)).toEqual(
      chooseRandomUnseen([long], {}, () => 0));
  });

  it('keeps the complete session view and controls identical through the shared prefix', () => {
    let short = advance(initialSession(), { type: 'START', item: setWithUnseenTail('short'), attemptId }, 0);
    let long = advance(initialSession(), { type: 'START', item: setWithUnseenTail('long'), attemptId }, 0);
    compareVisibleBoundary(short, long, 0);

    short = advance(short, { type: 'PREFLIGHT_READY' }, 1);
    long = advance(long, { type: 'PREFLIGHT_READY' }, 1);
    compareVisibleBoundary(short, long, 1);

    short = advance(short, { type: 'PLAYBACK_STARTED', replayId: sharedReplayIds[0] }, 2);
    long = advance(long, { type: 'PLAYBACK_STARTED', replayId: sharedReplayIds[0] }, 2);
    compareVisibleBoundary(short, long, 2);

    short = advance(short, { type: 'NATURAL_COMPLETION', replayId: sharedReplayIds[0],
      callerVerifiedNaturalCompletion: true }, 3);
    long = advance(long, { type: 'NATURAL_COMPLETION', replayId: sharedReplayIds[0],
      callerVerifiedNaturalCompletion: true }, 3);
    compareVisibleBoundary(short, long, 3);
    compareVisibleBoundary(short, long, 14_999);

    short = advance(short, { type: 'HOLD' }, 15_000);
    long = advance(long, { type: 'HOLD' }, 15_000);
    compareVisibleBoundary(short, long, 1_000_000);

    short = advance(short, { type: 'NEXT' }, 1_000_001);
    long = advance(long, { type: 'NEXT' }, 1_000_001);
    compareVisibleBoundary(short, long, 1_000_001);

    short = advance(short, { type: 'PLAYBACK_STARTED', replayId: sharedReplayIds[1] }, 1_000_002);
    long = advance(long, { type: 'PLAYBACK_STARTED', replayId: sharedReplayIds[1] }, 1_000_002);
    compareVisibleBoundary(short, long, 1_000_002);

    short = advance(short, { type: 'NATURAL_COMPLETION', replayId: sharedReplayIds[1],
      callerVerifiedNaturalCompletion: true }, 1_000_003);
    long = advance(long, { type: 'NATURAL_COMPLETION', replayId: sharedReplayIds[1],
      callerVerifiedNaturalCompletion: true }, 1_000_003);
    compareVisibleBoundary(short, long, 1_000_003);

    short = advance(short, { type: 'NEXT' }, 1_000_004);
    long = advance(long, { type: 'NEXT' }, 1_000_004);
    compareVisibleBoundary(short, long, 1_000_004);
    expect(projectSession(short, 1_000_004).currentGame).toBeUndefined();
    expect(projectSession(long, 1_000_004).currentGame).toBeUndefined();

    short = advance(short, { type: 'PLAYBACK_STARTED', replayId: id(3) }, 1_000_005);
    long = advance(long, { type: 'PLAYBACK_STARTED', replayId: id(5) }, 1_000_005);
    expect(projectSession(short, 1_000_005).currentGame?.stage).toBe('UNSEEN_SHORT_STAGE');
    expect(projectSession(long, 1_000_005).currentGame?.stage).toBe('UNSEEN_LONG_STAGE');
  });
});
