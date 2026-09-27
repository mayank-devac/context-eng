import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { canonicalCategory, displayCategory, isCategory } from "./categories.js";
import {
  categoryRecord,
  insertRow,
  metadataValue,
  nowSeconds,
  openCategoryDb,
  registerCategory,
  replaceLabels,
  setMetadata,
  type CategoryRecord,
  type Db,
  type MemoryRow,
} from "./db.js";
import { categoryFileName } from "./paths.js";
import { parseLabels } from "./text.js";

export const MIGRATION_KEY = "legacy_v1_migrated";

export function migrateLegacy(args: {
  catalog: Db;
  categoriesDir: string;
  legacyFile: string;
}): void {
  const { catalog, categoriesDir, legacyFile } = args;
  if (metadataValue(catalog, MIGRATION_KEY) === "2") return;
  if (!existsSync(legacyFile)) {
    setMetadata(catalog, MIGRATION_KEY, "2");
    return;
  }
  const legacy = new Database(legacyFile, { readonly: true, fileMustExist: true });
  let stagingDir: string | undefined;
  try {
    const table = legacy
      .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'memories'`)
      .get() as { present: number } | undefined;
    if (!table) {
      setMetadata(catalog, MIGRATION_KEY, "2");
      return;
    }
    const rawRows = legacy.prepare(`SELECT * FROM memories`).all() as Array<Record<string, unknown>>;
    const validRows = rawRows.filter((raw) => isCategory(String(raw.category ?? "")));
    if (validRows.length === 0) {
      setMetadata(catalog, MIGRATION_KEY, "2");
      return;
    }
    const migrationParent = path.dirname(categoriesDir);
    mkdirSync(migrationParent, { recursive: true });
    stagingDir = mkdtempSync(path.join(migrationParent, ".category-migration-"));
    const staged = new Map<string, { record: CategoryRecord; db: Db; ids: string[] }>();

    for (const raw of validRows) {
      const category = String(raw.category);
      const canonical = canonicalCategory(category);
      let target = staged.get(canonical);
      if (!target) {
        const existing = categoryRecord(catalog, canonical);
        const record: CategoryRecord = existing ?? {
          canonical,
          display_name: displayCategory(category),
          db_file: categoryFileName(canonical),
          created_at: nowSeconds(),
        };
        target = {
          record,
          db: openCategoryDb(path.join(stagingDir, record.db_file)),
          ids: [],
        };
        staged.set(canonical, target);
      }
      const row: MemoryRow = {
        id: String(raw.id),
        project_id: String(raw.project_id),
        chat_id: raw.chat_id === null || raw.chat_id === undefined ? null : String(raw.chat_id),
        category: target.record.display_name,
        content: String(raw.content),
        subject: null,
        topics: null,
        tags: raw.tags === null || raw.tags === undefined ? null : String(raw.tags),
        links: null,
        importance: Number(raw.importance ?? 0.5),
        active: Number(raw.active ?? 1),
        created_at: normalizeLegacyTimestamp(Number(raw.created_at)),
        updated_at: normalizeLegacyTimestamp(Number(raw.updated_at)),
      };
      target.db.transaction(() => {
        insertRow(target.db, row, true);
        replaceLabels(target.db, row.id, labelsFromRow(row));
      })();
      target.ids.push(row.id);
    }

    for (const target of staged.values()) {
      for (const id of target.ids) {
        const found = target.db.prepare(`SELECT 1 AS present FROM memories WHERE id = ?`).get(id);
        if (!found) throw new Error(`legacy migration failed to copy memory ${id}`);
      }
      target.db.close();
    }

    mkdirSync(categoriesDir, { recursive: true });
    for (const target of staged.values()) {
      renameSync(path.join(stagingDir, target.record.db_file), path.join(categoriesDir, target.record.db_file));
    }
    catalog.transaction(() => {
      for (const target of staged.values()) registerCategory(catalog, target.record);
      setMetadata(catalog, MIGRATION_KEY, "2");
    })();
  } finally {
    legacy.close();
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
  }
}

function labelsFromRow(row: MemoryRow): { topics: string[]; tags: string[]; links: string[] } {
  return { topics: parseLabels(row.topics), tags: parseLabels(row.tags), links: parseLabels(row.links) };
}

function normalizeLegacyTimestamp(value: number): number {
  return value >= 1_000_000_000_000 ? Math.floor(value / 1000) : value;
}
