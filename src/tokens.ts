/**
 * Cheap token estimate. No tokenizer dependency in stage one.
 * Uses the larger of a character-based and a word-based estimate so both
 * dense code and prose land close to what a BPE tokenizer would report.
 */
export function approxTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  const byChars = Math.ceil(trimmed.length / 4);
  const words = trimmed.split(/\s+/).length;
  const byWords = Math.ceil(words * 1.3);
  return Math.max(byChars, byWords);
}
