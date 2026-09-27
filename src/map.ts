import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { STAGING, type Category, type Scope } from "./categories.js";
import type { Db } from "./db.js";
import { keywords, parseLabels } from "./text.js";

export interface CategoryDbSource {
  category: string;
  db: Db;
}

export interface MapCollection {
  name: string;
  category: Category;
  count: number;
  staging_count: number;
  keywords: string[];
  lines: string[];
  lines_ids: string[];
}

export interface MapStaging {
  count: number;
  keywords: string[];
  lines: string[];
  lines_ids: string[];
  lines_categories: string[];
  searched: false;
}

export interface MapIndex {
  scope: Scope;
  projectKey?: string;
  projectPath?: string;
  generatedAt: string;
  collections: MapCollection[];
  staging: MapStaging;
  counts: Record<string, number>;
  top_keywords: string[];
}

const KEYWORDS_PER_COLLECTION = 8;
const TOP_KEYWORDS = 12;
const LINES_PER_COLLECTION = 12;

interface KeywordRow {
  id: string;
  category: string;
  content: string;
  subject: string | null;
  topics: string | null;
  tags: string | null;
  links: string | null;
  staged: number;
  created_at: number;
}

function topKeywords(rows: readonly KeywordRow[], limit: number): string[] {
  const freq = new Map<string, number>();
  for (const row of rows) {
    for (const value of [row.subject, row.topics, row.tags, row.links]) {
      for (const label of parseLabels(value)) freq.set(label, (freq.get(label) ?? 0) + 3);
    }
    for (const word of keywords(row.content)) freq.set(word, (freq.get(word) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

export function buildIndex(
  sources: readonly CategoryDbSource[],
  scope: Scope,
  meta: { projectKey?: string; projectPath?: string } = {},
): MapIndex {
  const rowsByCategory = new Map<string, KeywordRow[]>();
  for (const source of sources) {
    const rows = source.db
      .prepare(
        `SELECT id, category, content, subject, topics, tags, links,
                CASE WHEN chat_id = ? THEN 1 ELSE 0 END AS staged, created_at
         FROM memories WHERE active = 1 ORDER BY created_at DESC`,
      )
      .all(STAGING) as KeywordRow[];
    rowsByCategory.set(source.category, rows);
  }

  const allRows = [...rowsByCategory.values()].flat();
  const promoted = allRows.filter((row) => row.staged === 0);
  const staged = allRows.filter((row) => row.staged === 1);
  const collections: MapCollection[] = [];
  const counts: Record<string, number> = {};

  for (const source of [...sources].sort((a, b) => a.category.localeCompare(b.category))) {
    const rows = rowsByCategory.get(source.category) ?? [];
    const visible = rows.filter((row) => row.staged === 0);
    const lineRows = visible.slice(0, LINES_PER_COLLECTION);
    const stagingCount = rows.length - visible.length;
    counts[source.category] = visible.length;
    collections.push({
      name: source.category,
      category: source.category,
      count: visible.length,
      staging_count: stagingCount,
      keywords: topKeywords(visible, KEYWORDS_PER_COLLECTION),
      lines: lineRows.map((row) => row.content),
      lines_ids: lineRows.map((row) => row.id),
    });
  }
  counts[STAGING] = staged.length;
  const stagingLineRows = [...staged]
    .sort((left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id))
    .slice(0, LINES_PER_COLLECTION);

  const index: MapIndex = {
    scope,
    generatedAt: new Date().toISOString(),
    collections,
    staging: {
      count: staged.length,
      keywords: topKeywords(staged, KEYWORDS_PER_COLLECTION),
      lines: stagingLineRows.map((row) => row.content),
      lines_ids: stagingLineRows.map((row) => row.id),
      lines_categories: stagingLineRows.map((row) => row.category),
      searched: false,
    },
    counts,
    top_keywords: topKeywords(promoted, TOP_KEYWORDS),
  };
  if (meta.projectKey) index.projectKey = meta.projectKey;
  if (meta.projectPath) index.projectPath = meta.projectPath;
  return index;
}

export function renderMarkdown(index: MapIndex): string {
  const lines: string[] = [`- ${index.scope}`];
  if (index.collections.length === 0) lines.push("  - (empty)");
  for (const collection of index.collections) {
    const staged = collection.staging_count > 0 ? `, ${collection.staging_count} staging` : "";
    lines.push(`  - ${collection.name} (${collection.count}${staged})`);
    for (const line of collection.lines) lines.push(`    - ${line}`);
  }
  if (index.staging.count > 0) {
    lines.push(`  - staging (${index.staging.count}) — not searched`);
    for (const line of index.staging.lines) lines.push(`    - ${line}`);
  }
  return lines.join("\n") + "\n";
}

function writeAtomic(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, file);
}

export function writeMapFiles(index: MapIndex, mdFile: string, jsonFile: string): void {
  writeAtomic(mdFile, renderMarkdown(index));
  writeAtomic(jsonFile, JSON.stringify(index, null, 2) + "\n");
}
