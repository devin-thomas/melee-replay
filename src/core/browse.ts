import {
  type AttemptRecord,
  type Availability,
  type ExposureRecord,
  type PracticeCard,
  type PracticeItem,
  type PracticeKind,
  type PracticeStatus,
  validatePracticeItem,
} from "./models";

export interface BrowseFilters {
  kind?: PracticeKind;
  /** null matches items whose event is unknown. */
  event?: string | null;
  player?: string;
  openingCharacter?: string;
  status?: PracticeStatus;
  availability?: Availability;
  search?: string;
}

export function derivePracticeStatus(
  item: PracticeItem,
  attempts: readonly AttemptRecord[],
  exposures: readonly ExposureRecord[],
): PracticeStatus {
  if (attempts.some((attempt) => attempt.itemId === item.itemId && attempt.status === "completed")) {
    return "completed";
  }
  const exposed = new Set(exposures.map((exposure) => exposure.exposureKey));
  const segments = item.kind === "set" ? item.segments : [item.segment];
  if (segments.some((segment) => exposed.has(segment.exposureKey))) return "incomplete";
  if (attempts.some((attempt) => attempt.itemId === item.itemId && attempt.startedAt !== undefined)) {
    return "incomplete";
  }
  return "unseen";
}

export function createPracticeCard(
  item: PracticeItem,
  attempts: readonly AttemptRecord[],
  exposures: readonly ExposureRecord[],
  availability: Availability,
): PracticeCard {
  validatePracticeItem(item);
  if (!["ready", "downloadable", "unavailable"].includes(availability)) {
    throw new Error("Invalid availability");
  }
  return {
    itemId: item.itemId,
    kind: item.kind,
    context: {
      event: item.context.event,
      date: item.context.date,
      round: item.context.round,
      entrants: [...item.context.entrants],
      openingCharacters: [...item.context.openingCharacters],
    },
    ...(item.kind === "set" ? { format: item.format } : {}),
    verification: item.kind === "set" ? "verified" : "standalone",
    availability,
    status: derivePracticeStatus(item, attempts, exposures),
  };
}

function includesCaseInsensitive(haystack: string | undefined, needle: string): boolean {
  return haystack?.toLocaleLowerCase().includes(needle.toLocaleLowerCase()) ?? false;
}

export function filterPracticeCards(
  cards: readonly PracticeCard[],
  filters: BrowseFilters = {},
): PracticeCard[] {
  const filtered = cards.filter((card) => {
    if (filters.kind && card.kind !== filters.kind) return false;
    if (filters.event !== undefined && (card.context.event ?? null) !== filters.event) return false;
    if (filters.player && !card.context.entrants.some((name) => includesCaseInsensitive(name, filters.player!))) return false;
    if (filters.openingCharacter && !card.context.openingCharacters.some(
      (character) => includesCaseInsensitive(character ?? undefined, filters.openingCharacter!),
    )) return false;
    if (filters.status && card.status !== filters.status) return false;
    if (filters.availability && card.availability !== filters.availability) return false;
    if (filters.search) {
      const safeSearchFields = [card.context.event, card.context.date, card.context.round,
        ...card.context.entrants, ...card.context.openingCharacters];
      if (!safeSearchFields.some((field) => includesCaseInsensitive(field ?? undefined, filters.search!))) return false;
    }
    return true;
  });
  return filtered.sort((a, b) =>
    (a.context.event ?? "").localeCompare(b.context.event ?? "") ||
    (a.context.date ?? "").localeCompare(b.context.date ?? "") ||
    a.context.entrants.join(" ").localeCompare(b.context.entrants.join(" ")) ||
    a.itemId.localeCompare(b.itemId));
}

export function chooseRandomUnseen(
  cards: readonly PracticeCard[],
  filters: BrowseFilters = {},
  random: () => number = Math.random,
): PracticeCard | null {
  const eligible = filterPracticeCards(cards, filters).filter((card) =>
    card.status === "unseen" && card.availability !== "unavailable");
  if (eligible.length === 0) return null;
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new Error("Invalid random sample");
  return eligible[Math.floor(sample * eligible.length)];
}
