/** IDs exposed to the renderer must be generated opaque UUIDs, never source slugs. */
export type OpaqueId = string;

export type PracticeKind = "standalone" | "set";
export type Availability = "ready" | "downloadable" | "unavailable";
export type PracticeStatus = "unseen" | "incomplete" | "completed";
export type ScoreEffect = "none" | "entrantA" | "entrantB";

export interface SafeContext {
  event?: string;
  date?: string;
  round?: string;
  entrants: readonly [string, string];
  /** The selected game's characters, or the set's first game's characters. */
  openingCharacters: readonly [string | null, string | null];
}

export interface ReplaySegment {
  replayId: OpaqueId;
  /** Stable byte identity or reviewed alias group, shared between practice items. */
  exposureKey: string;
  officialGameNumber: number;
  stage?: string;
  characters: readonly [string | null, string | null];
  /** Backstage mapping from replay ports to the verified set entrants. */
  player1Entrant?: "A" | "B";
  player2Entrant?: "A" | "B";
  scoreEffect: ScoreEffect;
}

interface PracticeItemBase {
  itemId: OpaqueId;
  revision: string;
  context: SafeContext;
}

export interface StandaloneItem extends PracticeItemBase {
  kind: "standalone";
  segment: ReplaySegment;
}

export interface VerifiedSetItem extends PracticeItemBase {
  kind: "set";
  /** Admission is an audited step outside this domain module. */
  verification: "verified";
  format: "bo3" | "bo5" | "unknown";
  terminalRule:
    | { kind: "target-wins"; target: 2 | 3 }
    | { kind: "verified-source-terminal" };
  segments: readonly ReplaySegment[];
}

export type PracticeItem = StandaloneItem | VerifiedSetItem;

export interface AttemptRecord {
  attemptId: OpaqueId;
  itemId: OpaqueId;
  revision: string;
  status: "preparing" | "active" | "interrupted" | "failed" | "completed";
  requestedAt: string;
  startedAt?: string;
  endedAt?: string;
}

export interface ExposureRecord {
  exposureKey: string;
  /** Uncertain start observations also remove an item from blind selection. */
  certainty: "confirmed" | "uncertain";
}

export interface PracticeCard {
  itemId: OpaqueId;
  kind: PracticeKind;
  context: SafeContext;
  format?: "bo3" | "bo5" | "unknown";
  verification: "verified" | "standalone";
  availability: Availability;
  status: PracticeStatus;
}

const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function assertOpaqueId(value: string): void {
  if (!OPAQUE_ID.test(value)) throw new Error("Expected an opaque UUID");
}

function assertSafeText(value: string | undefined): void {
  if (value !== undefined && (value.length > 256 || CONTROL_CHARACTER.test(value))) {
    throw new Error("Unsafe display text");
  }
}

export function validatePracticeItem(item: PracticeItem): void {
  assertOpaqueId(item.itemId);
  assertSafeText(item.revision);
  if (!item.revision) throw new Error("Missing item revision");
  for (const value of [item.context.event, item.context.date, item.context.round,
    ...item.context.entrants, ...item.context.openingCharacters]) {
    if (value !== null) assertSafeText(value);
  }
  if (item.context.entrants.some((name) => !name)) throw new Error("Missing entrant");

  const segments = item.kind === "set" ? item.segments : [item.segment];
  if (segments.length === 0) throw new Error("Practice item has no replay");
  const ids = new Set<string>();
  let previousGameNumber = 0;
  for (const segment of segments) {
    assertOpaqueId(segment.replayId);
    if (ids.has(segment.replayId)) throw new Error("Duplicate replay in item");
    ids.add(segment.replayId);
    if (!segment.exposureKey || segment.exposureKey.length > 128 || CONTROL_CHARACTER.test(segment.exposureKey)) {
      throw new Error("Invalid exposure identity");
    }
    if (!Number.isSafeInteger(segment.officialGameNumber) || segment.officialGameNumber < 1) {
      throw new Error("Invalid game number");
    }
    if (segment.officialGameNumber < previousGameNumber ||
      segment.officialGameNumber > previousGameNumber + 1) {
      throw new Error("Invalid game order");
    }
    previousGameNumber = segment.officialGameNumber;
    if (!["none", "entrantA", "entrantB"].includes(segment.scoreEffect)) {
      throw new Error("Invalid score effect");
    }
    assertSafeText(segment.stage);
    for (const character of segment.characters) if (character !== null) assertSafeText(character);
  }

  if (item.kind === "standalone") return;
  if (item.verification !== "verified") throw new Error("Set is not verified");
  if (item.terminalRule.kind === "target-wins") {
    const expected = item.format === "bo3" ? 2 : item.format === "bo5" ? 3 : null;
    if (expected !== item.terminalRule.target) throw new Error("Target conflicts with format");
    let a = 0;
    let b = 0;
    item.segments.forEach((segment, index) => {
      if (segment.scoreEffect === "entrantA") a++;
      if (segment.scoreEffect === "entrantB") b++;
      if ((a >= expected || b >= expected) && index !== item.segments.length - 1) {
        throw new Error("Segments follow the terminal result");
      }
    });
    if (a < expected && b < expected) throw new Error("Verified set lacks terminal result");
  } else if (item.format !== "unknown") {
    throw new Error("Known format requires target-win rule");
  }
}
