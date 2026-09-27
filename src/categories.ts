import { editDistance } from "./text.js";

export const CATEGORIES = [
  "instruction",
  "mistake",
  "preference",
  "decision",
  "constraint",
  "workflow",
] as const;

/** Categories are extensible; these six names retain their built-in behavior. */
export type Category = string;

/** Built-in categories that leave staging immediately on create. */
export const AUTO_PROMOTE: ReadonlySet<string> = new Set([
  "instruction",
  "decision",
  "constraint",
  "mistake",
]);

export const SCOPES = ["global", "project"] as const;
export type Scope = (typeof SCOPES)[number];

export const STAGING = "staging";
export const MAX_TOKENS = 800;
export const MAX_HITS = 50;
export const MAX_READ_TOKENS = 4000;
export const MAX_SEARCH_CATEGORIES = 4;
export const MAX_JEV_CANDIDATES = 30;
/** Max parallel Jev requests. Candidates after 90 are skipped. */
export const MAX_JEV_BATCHES = 3;
export const MAX_EXHAUSTIVE_SEARCH_ROWS = 60;
export const MAX_EXHAUSTIVE_SEARCH_TOKENS = 12_000;
export const MAX_CATEGORY_LENGTH = 64;
export const MAX_FILTER_VALUES = 10;
export const MAX_FILTER_VALUE_LENGTH = 64;
export const NEAR_CATEGORY_SIMILARITY = 0.8;

export function isCategory(value: unknown): value is Category {
  if (typeof value !== "string") return false;
  const normalized = value.normalize("NFKC").trim();
  return (
    normalized.length > 0 &&
    normalized.length <= MAX_CATEGORY_LENGTH &&
    !hasControlCharacters(normalized)
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function canonicalCategory(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function displayCategory(value: string): string {
  return value.normalize("NFKC").trim();
}

/** Returns how much of two category names matches, from 0 to 1. */
export function categoryNameSimilarity(left: string, right: string): number {
  const a = comparableCategory(left);
  const b = comparableCategory(right);
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const longest = Math.max(a.length, b.length);
  return 1 - editDistance(a, b, longest) / longest;
}

function comparableCategory(value: string): string {
  return canonicalCategory(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}
