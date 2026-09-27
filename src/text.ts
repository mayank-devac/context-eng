const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when", "while",
  "of", "to", "in", "on", "at", "by", "for", "with", "from", "into", "about",
  "as", "is", "are", "was", "were", "be", "been", "being", "am",
  "it", "its", "this", "that", "these", "those", "there", "here",
  "i", "we", "you", "he", "she", "they", "me", "us", "them", "my", "our", "your",
  "do", "does", "did", "done", "doing", "have", "has", "had",
  "yes", "so", "too", "very", "just", "only", "also",
  "can", "could", "should", "would", "will", "may", "might",
  "use", "used", "using", "prefer", "please",
  "after", "before", "over", "under", "again", "all", "any", "each", "some",
  "how", "what", "which", "who", "why", "where",
]);

const NEGATIVE_TERMS = ["not", "no", "never"] as const;
const POSITIVE_TERMS = ["always", "must", "required"] as const;
const POLARITY_TERMS = new Set<string>([...NEGATIVE_TERMS, ...POSITIVE_TERMS]);

/** Unicode-aware, lowercased word tokens with English stopwords removed, deduplicated in order. */
export function keywords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const rawTokens = text.toLowerCase().match(/[\p{L}\p{M}\p{N}_-]+/gu) ?? [];
  for (const raw of rawTokens) {
    const tok = raw.replace(/^[-_]+|[-_]+$/g, "");
    const singleAsciiCharacter = tok.length === 1 && /^[a-z0-9]$/.test(tok);
    if (tok.length === 0 || singleAsciiCharacter || STOPWORDS.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/** True when a second sentence starts after `.` `!` or `?`. */
export function hasMultipleSentences(content: string): boolean {
  return /[.!?]["')\]]*\s+[A-Za-z]/.test(content.trim());
}

/** Structured labels are stored as normalized comma-separated values for FTS display. */
export function parseLabels(labels: string | null | undefined): string[] {
  if (!labels) return [];
  return labels
    .split(",")
    .map((t) => normalizeLabel(t))
    .filter((t) => t.length > 0);
}

export const parseTags = parseLabels;

export function normalizeLabel(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function normalizeLabels(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map(normalizeLabel).filter(Boolean))];
}

export function serializeLabels(values: readonly string[] | undefined): string | null {
  const clean = normalizeLabels(values);
  return clean.length ? clean.join(",") : null;
}

export const serializeTags = serializeLabels;

/**
 * Build an FTS5 MATCH expression from free text. Each token is quoted so
 * FTS5 syntax characters in the query cannot break the statement.
 * Returns null when nothing is searchable.
 */
export function buildFtsQuery(query: string): string | null {
  const toks = keywords(query);
  if (toks.length === 0) return null;

  const groups: string[] = [];
  if (toks.some((token) => (NEGATIVE_TERMS as readonly string[]).includes(token))) {
    groups.push(orGroup(NEGATIVE_TERMS, true));
  } else if (toks.some((token) => (POSITIVE_TERMS as readonly string[]).includes(token))) {
    groups.push(orGroup(POSITIVE_TERMS, true));
  }

  const subjectTerms = toks.filter((token) => !POLARITY_TERMS.has(token));
  if (subjectTerms.length > 0) groups.push(orGroup(subjectTerms, groups.length > 0));
  return groups.length > 0 ? groups.join(" AND ") : null;
}

export function lexicalQueryTerms(query: string): string[] {
  return keywords(query).filter((token) => !POLARITY_TERMS.has(token));
}

/** Return one conservatively corrected lexical query, or null when no unambiguous correction exists. */
export function correctTypoQuery(query: string, vocabularyText: readonly string[]): string | null {
  const queryTokens = keywords(query);
  const vocabulary = new Set(vocabularyText.flatMap((text) => keywords(text)));
  const replacements = new Map<string, string>();

  for (const token of queryTokens) {
    if (replacements.size >= 3 || vocabulary.has(token) || POLARITY_TERMS.has(token)) continue;
    const characters = [...token];
    if (characters.length < 4 || !/^\p{L}[\p{L}\p{M}]*$/u.test(token)) continue;
    const maxDistance = characters.length >= 8 ? 2 : 1;
    let bestDistance = maxDistance + 1;
    let best: string | undefined;
    let tied = false;

    for (const candidate of vocabulary) {
      if (!/^\p{L}[\p{L}\p{M}]*$/u.test(candidate)) continue;
      if (Math.abs([...candidate].length - characters.length) > maxDistance) continue;
      const distance = editDistance(token, candidate, maxDistance);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
        tied = false;
      } else if (distance === bestDistance) {
        tied = true;
      }
    }
    if (best !== undefined && bestDistance <= maxDistance && !tied) replacements.set(token, best);
  }

  if (replacements.size === 0) return null;
  return queryTokens.map((token) => replacements.get(token) ?? token).join(" ");
}

function orGroup(tokens: readonly string[], parenthesize: boolean): string {
  const quoted = tokens.map((token) => `"${token.replace(/"/g, "")}"`);
  const expression = quoted.join(" OR ");
  return parenthesize && quoted.length > 1 ? `(${expression})` : expression;
}

/** Unicode-aware Damerau-Levenshtein. Caps at maxDistance+1 when the bound is finite. */
export function editDistance(left: string, right: string, maxDistance = Number.POSITIVE_INFINITY): number {
  const a = [...left];
  const b = [...right];
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  const matrix = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let row = 0; row <= a.length; row += 1) matrix[row]![0] = row;
  for (let column = 0; column <= b.length; column += 1) matrix[0]![column] = column;

  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      const substitution = matrix[row - 1]![column - 1]! + (a[row - 1] === b[column - 1] ? 0 : 1);
      const deletion = matrix[row - 1]![column]! + 1;
      const insertion = matrix[row]![column - 1]! + 1;
      let distance = Math.min(substitution, deletion, insertion);
      if (
        row > 1 &&
        column > 1 &&
        a[row - 1] === b[column - 2] &&
        a[row - 2] === b[column - 1]
      ) {
        distance = Math.min(distance, matrix[row - 2]![column - 2]! + 1);
      }
      matrix[row]![column] = distance;
    }
  }
  return matrix[a.length]![b.length]!;
}
