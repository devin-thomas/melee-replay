import {
  assertOpaqueId,
  type PracticeItem,
  type SafeContext,
  type ScoreEffect,
  validatePracticeItem,
} from "./models";

export type SessionPhase =
  | "idle" | "preparing" | "starting" | "playing"
  | "intermission-countdown" | "intermission-held"
  | "completed" | "interrupted" | "failed";

export type SafeFailureReason =
  | "preparation-failed" | "playback-unavailable" | "connection-lost"
  | "asset-unavailable" | "unsupported-playback";

/** Backstage state stays in the main process. Never send it through the renderer bridge. */
export interface SessionState {
  phase: SessionPhase;
  item?: PracticeItem;
  attemptId?: string;
  segmentIndex: number;
  completedReplayIds: readonly string[];
  observedScore: readonly [number, number];
  deadlineMs?: number;
  failureReason?: SafeFailureReason;
}

export type SessionEvent =
  | { type: "START"; item: PracticeItem; attemptId: string }
  | { type: "PRACTICE_AGAIN"; attemptId: string }
  | { type: "PREFLIGHT_READY" }
  | { type: "PLAYBACK_STARTED"; replayId: string }
  /** Only the runtime adapter may issue this after proving natural completion. */
  | { type: "NATURAL_COMPLETION"; replayId: string; callerVerifiedNaturalCompletion: true }
  | { type: "NEXT" } | { type: "HOLD" } | { type: "TICK" }
  | { type: "SUSPEND" } | { type: "STOP" } | { type: "LEAVE" }
  | { type: "PREPARATION_FAILED"; reason: SafeFailureReason }
  | { type: "PLAYBACK_FAILED"; reason: SafeFailureReason };

export type SessionEffect =
  | { type: "create-attempt"; attemptId: string; itemId: string; revision: string }
  | { type: "request-preflight"; itemId: string }
  | { type: "launch-replay"; replayId: string; attemptId: string }
  | { type: "record-exposure"; attemptId: string; exposureKey: string }
  | { type: "record-uncertain-exposure"; attemptId: string; exposureKey: string }
  | { type: "record-attempt-start"; attemptId: string }
  | { type: "record-natural-completion"; attemptId: string; replayId: string; scoreEffect: ScoreEffect }
  | { type: "finish-attempt"; attemptId: string; outcome: "completed" | "interrupted" | "failed" }
  | { type: "stop-owned-playback" };

export interface SessionTransition {
  state: SessionState;
  effects: readonly SessionEffect[];
}

export interface SessionView {
  phase: SessionPhase;
  context?: SafeContext;
  observedScore?: readonly [number, number];
  currentGame?: {
    number: number;
    stage?: string;
    characters: readonly [string | null, string | null];
  };
  remainingSeconds?: number;
  failureReason?: SafeFailureReason;
  controls: readonly ("stop" | "hold" | "next" | "leave" | "practice-again")[];
}

export const INTERMISSION_MS = 30_000;
const FAILURE_REASONS: readonly SafeFailureReason[] = [
  "preparation-failed", "playback-unavailable", "connection-lost",
  "asset-unavailable", "unsupported-playback",
];

export function initialSession(): SessionState {
  return { phase: "idle", segmentIndex: 0, completedReplayIds: [], observedScore: [0, 0] };
}

function assertMonotonicTime(nowMs: number): void {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error("Invalid monotonic time");
}

function segments(item: PracticeItem) {
  return item.kind === "set" ? item.segments : [item.segment];
}

function unchanged(state: SessionState): SessionTransition {
  return { state, effects: [] };
}

function start(item: PracticeItem, attemptId: string): SessionTransition {
  validatePracticeItem(item);
  assertOpaqueId(attemptId);
  return {
    state: {
      phase: "preparing", item, attemptId, segmentIndex: 0,
      completedReplayIds: [], observedScore: [0, 0],
    },
    effects: [
      { type: "create-attempt", attemptId, itemId: item.itemId, revision: item.revision },
      { type: "request-preflight", itemId: item.itemId },
    ],
  };
}

function next(state: SessionState): SessionTransition {
  const item = state.item!;
  const replay = segments(item)[state.segmentIndex];
  if (!replay) return unchanged(state);
  return {
    state: { ...state, phase: "starting", deadlineMs: undefined },
    effects: [{ type: "launch-replay", replayId: replay.replayId, attemptId: state.attemptId! }],
  };
}

function terminal(item: PracticeItem, score: readonly [number, number], nextIndex: number): boolean {
  if (item.kind === "standalone") return true;
  if (item.terminalRule.kind === "target-wins") {
    return score[0] >= item.terminalRule.target || score[1] >= item.terminalRule.target;
  }
  return nextIndex === item.segments.length;
}

export function transitionSession(
  state: SessionState,
  event: SessionEvent,
  nowMs: number,
): SessionTransition {
  assertMonotonicTime(nowMs);
  if (event.type === "START") {
    return state.phase === "idle" ? start(event.item, event.attemptId) : unchanged(state);
  }
  if (event.type === "PRACTICE_AGAIN") {
    return state.phase === "completed" ? start(state.item!, event.attemptId) : unchanged(state);
  }
  if (event.type === "LEAVE") {
    return ["completed", "interrupted", "failed"].includes(state.phase)
      ? { state: initialSession(), effects: [] } : unchanged(state);
  }
  if (event.type === "STOP") {
    if (["idle", "completed", "interrupted", "failed"].includes(state.phase)) return unchanged(state);
    return {
      state: { ...state, phase: "interrupted", deadlineMs: undefined },
      effects: [
        { type: "finish-attempt", attemptId: state.attemptId!, outcome: "interrupted" },
        { type: "stop-owned-playback" },
      ],
    };
  }
  if (event.type === "SUSPEND") {
    if (state.phase === "intermission-countdown") {
      return { state: { ...state, phase: "intermission-held", deadlineMs: undefined }, effects: [] };
    }
    if (state.phase === "playing" || state.phase === "starting") {
      return transitionSession(state, { type: "STOP" }, nowMs);
    }
    return unchanged(state);
  }
  if (event.type === "PREPARATION_FAILED" && state.phase === "preparing") {
    if (!FAILURE_REASONS.includes(event.reason)) throw new Error("Invalid failure reason");
    return {
      state: { ...state, phase: "failed", failureReason: event.reason },
      effects: [{ type: "finish-attempt", attemptId: state.attemptId!, outcome: "failed" }],
    };
  }
  if (event.type === "PLAYBACK_FAILED" && ["starting", "playing", "intermission-countdown", "intermission-held"].includes(state.phase)) {
    if (!FAILURE_REASONS.includes(event.reason)) throw new Error("Invalid failure reason");
    const uncertainStart = state.phase === "starting" && event.reason !== "asset-unavailable";
    return {
      state: { ...state, phase: "failed", deadlineMs: undefined, failureReason: event.reason },
      effects: [
        ...(uncertainStart ? [{ type: "record-uncertain-exposure" as const,
          attemptId: state.attemptId!, exposureKey: segments(state.item!)[state.segmentIndex].exposureKey }] : []),
        { type: "finish-attempt", attemptId: state.attemptId!, outcome: "failed" },
        { type: "stop-owned-playback" },
      ],
    };
  }
  if (event.type === "PREFLIGHT_READY" && state.phase === "preparing") return next(state);
  if (event.type === "PLAYBACK_STARTED" && state.phase === "starting") {
    const replay = segments(state.item!)[state.segmentIndex];
    if (event.replayId !== replay.replayId) return unchanged(state);
    return {
      state: { ...state, phase: "playing" },
      effects: [
        ...(state.segmentIndex === 0 ? [{ type: "record-attempt-start" as const,
          attemptId: state.attemptId! }] : []),
        { type: "record-exposure", attemptId: state.attemptId!, exposureKey: replay.exposureKey },
      ],
    };
  }
  if (event.type === "NATURAL_COMPLETION" && state.phase === "playing") {
    const replay = segments(state.item!)[state.segmentIndex];
    if (event.callerVerifiedNaturalCompletion !== true || event.replayId !== replay.replayId ||
      state.completedReplayIds.includes(replay.replayId)) return unchanged(state);
    const score: [number, number] = [...state.observedScore];
    if (replay.scoreEffect === "entrantA") score[0]++;
    if (replay.scoreEffect === "entrantB") score[1]++;
    const nextIndex = state.segmentIndex + 1;
    const done = terminal(state.item!, score, nextIndex);
    const effects: SessionEffect[] = [{ type: "record-natural-completion", attemptId: state.attemptId!,
      replayId: replay.replayId, scoreEffect: replay.scoreEffect }];
    if (done) effects.push({ type: "finish-attempt", attemptId: state.attemptId!, outcome: "completed" });
    return {
      state: {
        ...state, phase: done ? "completed" : "intermission-countdown",
        segmentIndex: nextIndex,
        completedReplayIds: [...state.completedReplayIds, replay.replayId],
        observedScore: score,
        deadlineMs: done ? undefined : nowMs + INTERMISSION_MS,
      },
      effects,
    };
  }
  if (event.type === "HOLD" && state.phase === "intermission-countdown") {
    return { state: { ...state, phase: "intermission-held", deadlineMs: undefined }, effects: [] };
  }
  if (event.type === "NEXT" && ["intermission-countdown", "intermission-held"].includes(state.phase)) {
    return next(state);
  }
  if (event.type === "TICK" && state.phase === "intermission-countdown" &&
    state.deadlineMs !== undefined && nowMs >= state.deadlineMs) return next(state);
  return unchanged(state);
}

export function projectSession(state: SessionState, nowMs: number): SessionView {
  assertMonotonicTime(nowMs);
  if (state.phase === "idle") return { phase: "idle", controls: [] };
  const item = state.item!;
  const view: SessionView = {
    phase: state.phase,
    context: {
      event: item.context.event,
      date: item.context.date,
      round: item.context.round,
      entrants: [...item.context.entrants],
      openingCharacters: [...item.context.openingCharacters],
    },
    ...(state.phase === "preparing" || state.phase === "starting" ? {} : { observedScore: [...state.observedScore] }),
    controls: state.phase === "intermission-countdown" ? ["stop", "hold", "next"]
      : state.phase === "intermission-held" ? ["stop", "next"]
      : state.phase === "completed" ? ["leave", "practice-again"]
      : state.phase === "failed" || state.phase === "interrupted" ? ["leave"] : ["stop"],
  };
  if (state.phase === "playing") {
    const segment = segments(item)[state.segmentIndex];
    view.currentGame = {
      number: segment.officialGameNumber,
      stage: segment.stage,
      characters: [...segment.characters],
    };
  }
  if (state.phase === "intermission-countdown") {
    view.remainingSeconds = Math.max(0, Math.ceil((state.deadlineMs! - nowMs) / 1000));
  }
  if (state.phase === "failed") view.failureReason = state.failureReason;
  return view;
}
