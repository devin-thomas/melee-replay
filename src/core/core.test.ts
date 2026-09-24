import { describe, expect, it } from "vitest";
import {
  chooseRandomUnseen,
  createPracticeCard,
  derivePracticeStatus,
  filterPracticeCards,
  initialSession,
  projectSession,
  transitionSession,
  validatePracticeItem,
  type PracticeItem,
  type ReplaySegment,
  type SessionState,
} from "./index";

const IDS = {
  item: "00000000-0000-4000-8000-000000000001",
  standalone: "00000000-0000-4000-8000-000000000002",
  attempt: "00000000-0000-4000-8000-000000000003",
  secondAttempt: "00000000-0000-4000-8000-000000000004",
  game1: "00000000-0000-4000-8000-000000000011",
  game2: "00000000-0000-4000-8000-000000000012",
  game3: "00000000-0000-4000-8000-000000000013",
};

function segment(replayId: string, number: number, scoreEffect: ReplaySegment["scoreEffect"],
  stage = `Hidden future stage ${number}`): ReplaySegment {
  return {
    replayId, exposureKey: `sha256:${replayId}`, officialGameNumber: number,
    stage, characters: [number === 1 ? "Fox" : "Future A", "Marth"], scoreEffect,
  };
}

function set(suffix: "a" | "b" = "a"): PracticeItem {
  return {
    itemId: IDS.item, revision: "rev-1", kind: "set", verification: "verified",
    format: "bo3", terminalRule: { kind: "target-wins", target: 2 },
    context: { event: "Synthetic Cup", date: "2026-09", round: "Final",
      entrants: ["Player A", "Player B"], openingCharacters: ["Fox", "Marth"] },
    segments: [
      segment(IDS.game1, 1, "entrantA", "Battlefield"),
      segment(IDS.game2, 2, suffix === "a" ? "entrantA" : "entrantB"),
      ...(suffix === "b" ? [segment(IDS.game3, 3, "entrantB")] : []),
    ],
  };
}

function standalone(): PracticeItem {
  return {
    itemId: IDS.standalone, revision: "rev-1", kind: "standalone",
    context: { entrants: ["Player A", "Player B"], openingCharacters: ["Fox", "Marth"] },
    segment: segment(IDS.game1, 1, "entrantA", "Battlefield"),
  };
}

function apply(state: SessionState, event: Parameters<typeof transitionSession>[1], now = 0) {
  return transitionSession(state, event, now);
}

function toPlaying(item: PracticeItem) {
  let result = apply(initialSession(), { type: "START", item, attemptId: IDS.attempt });
  expect(result.effects.map((effect) => effect.type)).toEqual(["create-attempt", "request-preflight"]);
  result = apply(result.state, { type: "PREFLIGHT_READY" });
  expect(result.effects).toEqual([{ type: "launch-replay", replayId: IDS.game1, attemptId: IDS.attempt }]);
  result = apply(result.state, { type: "PLAYBACK_STARTED", replayId: IDS.game1 });
  expect(result.effects.map((effect) => effect.type)).toEqual(["record-attempt-start", "record-exposure"]);
  return result.state;
}

describe("browse and history", () => {
  it("shares exposure across set and standalone, without fabricating set completion", () => {
    const exposure = [{ exposureKey: `sha256:${IDS.game1}`, certainty: "confirmed" as const }];
    expect(derivePracticeStatus(set(), [], exposure)).toBe("incomplete");
    expect(derivePracticeStatus(standalone(), [], exposure)).toBe("incomplete");
    const completed = [{ attemptId: IDS.attempt, itemId: IDS.item, revision: "rev-1",
      status: "completed" as const, requestedAt: "2026-09-23T00:00:00Z" }];
    expect(derivePracticeStatus(set(), completed, exposure)).toBe("completed");
    expect(derivePracticeStatus(standalone(), completed, exposure)).toBe("incomplete");
    const abortedRepeat = { ...completed[0], attemptId: IDS.secondAttempt, status: "interrupted" as const };
    expect(derivePracticeStatus(set(), [...completed, abortedRepeat], exposure)).toBe("completed");
    expect(derivePracticeStatus(set(), [], [{ ...exposure[0], certainty: "uncertain" }])).toBe("incomplete");
  });

  it("filters safe opening context and uses the same unseen pool for random", () => {
    const first = createPracticeCard(set(), [], [], "downloadable");
    const second = createPracticeCard(standalone(), [], [], "ready");
    expect(filterPracticeCards([first, second], { kind: "set", event: "Synthetic Cup",
      player: "player a", openingCharacter: "fox", status: "unseen" })).toEqual([first]);
    expect(filterPracticeCards([first, second], { event: null })).toEqual([second]);
    expect(filterPracticeCards([first, second], { openingCharacter: "Future A" })).toEqual([]);
    expect(chooseRandomUnseen([first, second], { kind: "set" }, () => 0.9)).toEqual(first);
    expect(chooseRandomUnseen([{ ...first, status: "incomplete" },
      { ...second, availability: "unavailable" }])).toBeNull();
  });

  it("allowlists cards and rejects result-bearing IDs", () => {
    const item = set() as Extract<PracticeItem, { kind: "set" }>;
    const card = createPracticeCard(item, [], [], "ready");
    expect(JSON.stringify(card)).not.toContain("scoreEffect");
    expect(JSON.stringify(card)).not.toContain("Hidden future stage");
    expect(JSON.stringify(card)).not.toContain("segments");
    expect(() => validatePracticeItem({ ...item, itemId: "player-a-wins-2-0" })).toThrow("opaque UUID");
    expect(() => validatePracticeItem({ ...item, context: { ...item.context,
      event: "Event\nFinal score: 2-0" } })).toThrow("Unsafe display text");
  });
});

describe("session boundary", () => {
  it("hides distinct unseen suffixes until reveal, including controls", () => {
    const a = set("a");
    const b = set("b");
    const aStart = apply(initialSession(), { type: "START", item: a, attemptId: IDS.attempt }).state;
    const bStart = apply(initialSession(), { type: "START", item: b, attemptId: IDS.attempt }).state;
    expect(projectSession(aStart, 0)).toEqual(projectSession(bStart, 0));
    const aPlaying = toPlaying(a);
    const bPlaying = toPlaying(b);
    expect(projectSession(aPlaying, 0)).toEqual(projectSession(bPlaying, 0));
    const aBetween = apply(aPlaying, { type: "NATURAL_COMPLETION", replayId: IDS.game1,
      callerVerifiedNaturalCompletion: true }, 100).state;
    const bBetween = apply(bPlaying, { type: "NATURAL_COMPLETION", replayId: IDS.game1,
      callerVerifiedNaturalCompletion: true }, 100).state;
    expect(projectSession(aBetween, 1_000)).toEqual(projectSession(bBetween, 1_000));
    expect(JSON.stringify(projectSession(aBetween, 1_000))).not.toMatch(/Hidden future|game2|of 3|of 2/);
  });

  it("requires verified natural completion; duplicates and stale events cannot score", () => {
    let state = toPlaying(set());
    expect(apply(state, { type: "NATURAL_COMPLETION", replayId: IDS.game2,
      callerVerifiedNaturalCompletion: true }).effects).toEqual([]);
    expect(apply(state, { type: "NATURAL_COMPLETION", replayId: IDS.game1,
      callerVerifiedNaturalCompletion: false as true }).effects).toEqual([]);
    const completed = apply(state, { type: "NATURAL_COMPLETION", replayId: IDS.game1,
      callerVerifiedNaturalCompletion: true }, 1_000);
    state = completed.state;
    expect(state.phase).toBe("intermission-countdown");
    expect(state.observedScore).toEqual([1, 0]);
    expect(apply(state, { type: "NATURAL_COMPLETION", replayId: IDS.game1,
      callerVerifiedNaturalCompletion: true }, 1_001).effects).toEqual([]);
  });

  it("runs a monotonic 30-second intermission and launches next only once", () => {
    const playing = toPlaying(set());
    const between = apply(playing, { type: "NATURAL_COMPLETION", replayId: IDS.game1,
      callerVerifiedNaturalCompletion: true }, 1_000).state;
    expect(projectSession(between, 1_000).remainingSeconds).toBe(30);
    expect(apply(between, { type: "TICK" }, 30_999).effects).toEqual([]);
    const expired = apply(between, { type: "TICK" }, 31_000);
    expect(expired.effects).toEqual([{ type: "launch-replay", replayId: IDS.game2, attemptId: IDS.attempt }]);
    expect(apply(expired.state, { type: "NEXT" }, 31_000).effects).toEqual([]);
    expect(apply(expired.state, { type: "TICK" }, 61_000).effects).toEqual([]);
    const held = apply(between, { type: "HOLD" }, 30_999).state;
    expect(held.phase).toBe("intermission-held");
    expect(apply(held, { type: "TICK" }, 1_000_000).effects).toEqual([]);
    expect(apply(held, { type: "NEXT" }, 1_000_000).effects).toEqual(expired.effects);
  });

  it("completes only after the final naturally completed game and resets reveal on repeat", () => {
    let state = toPlaying(set("a"));
    state = apply(state, { type: "NATURAL_COMPLETION", replayId: IDS.game1,
      callerVerifiedNaturalCompletion: true }, 100).state;
    state = apply(state, { type: "NEXT" }, 101).state;
    state = apply(state, { type: "PLAYBACK_STARTED", replayId: IDS.game2 }, 102).state;
    const result = apply(state, { type: "NATURAL_COMPLETION", replayId: IDS.game2,
      callerVerifiedNaturalCompletion: true }, 103);
    expect(result.state.phase).toBe("completed");
    expect(result.effects.at(-1)).toEqual({ type: "finish-attempt", attemptId: IDS.attempt, outcome: "completed" });
    expect(projectSession(result.state, 104).controls).toEqual(["leave", "practice-again"]);
    const repeat = apply(result.state, { type: "PRACTICE_AGAIN", attemptId: IDS.secondAttempt }, 106).state;
    expect(projectSession(repeat, 106).observedScore).toBeUndefined();
  });

  it("keeps non-scoring segments at the same observed score and stops on suspend/failure", () => {
    const original = set("a") as Extract<PracticeItem, { kind: "set" }>;
    const withRestart: PracticeItem = { ...original, segments: [
      { ...original.segments[0], scoreEffect: "none" },
      { ...original.segments[1], officialGameNumber: 1, scoreEffect: "entrantA" },
      segment(IDS.game3, 2, "entrantA"),
    ] };
    const playing = toPlaying(withRestart);
    const between = apply(playing, { type: "NATURAL_COMPLETION", replayId: IDS.game1,
      callerVerifiedNaturalCompletion: true }, 100).state;
    expect(between.observedScore).toEqual([0, 0]);
    expect(apply(between, { type: "SUSPEND" }, 101).state.phase).toBe("intermission-held");
    const failed = apply(between, { type: "PLAYBACK_FAILED", reason: "asset-unavailable" }, 101);
    expect(failed.state.phase).toBe("failed");
    expect(JSON.stringify(projectSession(failed.state, 101))).not.toContain(IDS.game2);
  });

  it("records uncertain exposure when startup fails ambiguously", () => {
    const preparing = apply(initialSession(), { type: "START", item: set(), attemptId: IDS.attempt }).state;
    const starting = apply(preparing, { type: "PREFLIGHT_READY" }).state;
    const failed = apply(starting, { type: "PLAYBACK_FAILED", reason: "connection-lost" });
    expect(failed.effects[0]).toEqual({ type: "record-uncertain-exposure",
      attemptId: IDS.attempt, exposureKey: `sha256:${IDS.game1}` });
    expect(apply(starting, { type: "PLAYBACK_FAILED", reason: "asset-unavailable" }).effects
      .some((effect) => effect.type === "record-uncertain-exposure")).toBe(false);
  });
});
