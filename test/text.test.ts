import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectKey } from "../src/paths.js";
import { buildFtsQuery, correctTypoQuery, editDistance, hasMultipleSentences, keywords } from "../src/text.js";
import { approxTokens } from "../src/tokens.js";

describe("keywords and FTS query", () => {
  it("drops stopwords and punctuation from a one-sentence memory", () => {
    expect(keywords("Revoke Blob URLs after use!")).toEqual(["revoke", "blob", "urls"]);
  });

  it("preserves words from non-Latin scripts and accented languages", () => {
    expect(keywords("हिंदी खोज 中文 搜索 café")).toEqual(["हिंदी", "खोज", "中文", "搜索", "café"]);
  });

  it("quotes each search token so FTS5 operators cannot leak", () => {
    expect(buildFtsQuery("fix the memory leak")).toBe('"fix" OR "memory" OR "leak"');
    expect(buildFtsQuery("the and")).toBeNull();
    const injected = buildFtsQuery('a"b OR NEAR(x)');
    expect(injected).toBe('"near"');
    expect(injected).not.toMatch(/(^|[^"])NEAR/);
  });

  it("keeps polarity words and requires matching polarity in FTS", () => {
    expect(buildFtsQuery("never commit secrets")).toBe(
      '("not" OR "no" OR "never") AND ("commit" OR "secrets")',
    );
    expect(buildFtsQuery("always commit changes")).toBe(
      '("always" OR "must" OR "required") AND ("commit" OR "changes")',
    );
  });

  it("corrects one unambiguous typo without changing code-like tokens", () => {
    const vocabulary = ["Keep memory retrieval reliable.", "Index project decisions."];
    expect(correctTypoQuery("find memroy decisions", vocabulary)).toBe("find memory decisions");
    expect(correctTypoQuery("find api_v2", vocabulary)).toBeNull();
    expect(correctTypoQuery("find cot", ["cat", "cut"])).toBeNull();
  });

  it("counts transpositions as one edit", () => {
    expect(editDistance("ab", "ba")).toBe(1);
    expect(editDistance("decision", "decisions")).toBe(1);
  });
});

describe("hasMultipleSentences", () => {
  it("allows one sentence and rejects a second", () => {
    expect(hasMultipleSentences("Revoke Blob URLs after use.")).toBe(false);
    expect(hasMultipleSentences("Use TypeScript for new files. Prefer interfaces.")).toBe(true);
  });
});

describe("approxTokens", () => {
  it("returns 0 for empty text and 130 for one hundred words", () => {
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("word ".repeat(100))).toBe(130);
  });
});

describe("projectKey", () => {
  it("slugs the basename and suffixes a 10-char sha1 of the full path", () => {
    const input = "/Users/x/My Repo";
    const hash = createHash("sha1").update(input).digest("hex").slice(0, 10);
    expect(projectKey(input)).toBe(`my-repo-${hash}`);
    expect(projectKey(input)).toBe(projectKey(input));
    expect(projectKey("/Users/x/other")).not.toBe(projectKey(input));
  });
});
