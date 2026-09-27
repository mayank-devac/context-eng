import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Db = Database.Database;

const MS_FLOOR = 1_000_000_000_000;

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export interface MemoryRow {
  id: string;
  project_id: string;
  chat_id: string | null;
  category: string;
  content: string;
  subject: string | null;
  topics: string | null;
  tags: string | null;
  links: string | null;
  importance: number;
  active: number;
  created_at: number;
  updated_at: number;
}

export interface CategoryRecord {
  canonical: string;
  display_name: string;
  db_file: string;
  created_at: number;
}

const CATEGORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    chat_id TEXT,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    subject TEXT,
    topics TEXT,
    tags TEXT,
    links TEXT,
    importance REAL DEFAULT 0.5,
    active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS memories_chat_idx ON memories(chat_id, active);
CREATE INDEX IF NOT EXISTS memories_subject_idx ON memories(subject);
CREATE INDEX IF NOT EXISTS memories_importance_idx ON memories(importance);
CREATE INDEX IF NOT EXISTS memories_created_idx ON memories(created_at);
CREATE INDEX IF NOT EXISTS memories_updated_idx ON memories(updated_at);

CREATE TABLE IF NOT EXISTS memory_labels (
    memory_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('topic', 'tag', 'link')),
    value TEXT NOT NULL,
    PRIMARY KEY(memory_id, kind, value),
    FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS memory_labels_lookup_idx ON memory_labels(kind, value, memory_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    subject,
    topics,
    tags,
    links,
    content='memories',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, subject, topics, tags, links)
  VALUES (new.rowid, new.content, new.subject, new.topics, new.tags, new.links);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, subject, topics, tags, links)
  VALUES ('delete', old.rowid, old.content, old.subject, old.topics, old.tags, old.links);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, subject, topics, tags, links)
  VALUES ('delete', old.rowid, old.content, old.subject, old.topics, old.tags, old.links);
  INSERT INTO memories_fts(rowid, content, subject, topics, tags, links)
  VALUES (new.rowid, new.content, new.subject, new.topics, new.tags, new.links);
END;
`;

const CATALOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
    canonical TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    db_file TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

function configure(db: Db): void {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
}

export function openCategoryDb(file: string): Db {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  configure(db);
  db.exec(CATEGORY_SCHEMA);
  db.exec(`
    UPDATE memories SET created_at = created_at / 1000 WHERE created_at >= ${MS_FLOOR};
    UPDATE memories SET updated_at = updated_at / 1000 WHERE updated_at >= ${MS_FLOOR};
  `);
  return db;
}

/** Compatibility alias for callers that open a single category database. */
export const openDb = openCategoryDb;

export function openCatalog(file: string): Db {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  configure(db);
  db.exec(CATALOG_SCHEMA);
  return db;
}

export function listCategories(catalog: Db): CategoryRecord[] {
  return catalog
    .prepare(`SELECT canonical, display_name, db_file, created_at FROM categories ORDER BY display_name`)
    .all() as CategoryRecord[];
}

export function categoryRecord(catalog: Db, canonical: string): CategoryRecord | undefined {
  return catalog
    .prepare(`SELECT canonical, display_name, db_file, created_at FROM categories WHERE canonical = ?`)
    .get(canonical) as CategoryRecord | undefined;
}

export function registerCategory(catalog: Db, record: CategoryRecord): CategoryRecord {
  catalog
    .prepare(
      `INSERT OR IGNORE INTO categories (canonical, display_name, db_file, created_at)
       VALUES (@canonical, @display_name, @db_file, @created_at)`,
    )
    .run(record);
  return categoryRecord(catalog, record.canonical) ?? record;
}

export function metadataValue(catalog: Db, key: string): string | undefined {
  const row = catalog.prepare(`SELECT value FROM metadata WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMetadata(catalog: Db, key: string, value: string): void {
  catalog
    .prepare(
      `INSERT INTO metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

export function insertRow(db: Db, row: MemoryRow, ignore = false): void {
  db.prepare(
    `INSERT ${ignore ? "OR IGNORE " : ""}INTO memories
     (id, project_id, chat_id, category, content, subject, topics, tags, links,
      importance, active, created_at, updated_at)
     VALUES (@id, @project_id, @chat_id, @category, @content, @subject, @topics, @tags, @links,
             @importance, @active, @created_at, @updated_at)`,
  ).run(row);
}

export function updateRow(db: Db, row: MemoryRow): void {
  db.prepare(
    `UPDATE memories SET content = @content, category = @category, subject = @subject,
      topics = @topics, tags = @tags, links = @links, importance = @importance,
      chat_id = @chat_id, updated_at = @updated_at WHERE id = @id`,
  ).run(row);
}

export function replaceLabels(
  db: Db,
  memoryId: string,
  labels: { topics: readonly string[]; tags: readonly string[]; links: readonly string[] },
): void {
  const remove = db.prepare(`DELETE FROM memory_labels WHERE memory_id = ?`);
  const insert = db.prepare(`INSERT INTO memory_labels (memory_id, kind, value) VALUES (?, ?, ?)`);
  db.transaction(() => {
    remove.run(memoryId);
    for (const value of labels.topics) insert.run(memoryId, "topic", value);
    for (const value of labels.tags) insert.run(memoryId, "tag", value);
    for (const value of labels.links) insert.run(memoryId, "link", value);
  })();
}
