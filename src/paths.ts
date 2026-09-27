import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME_ENV = "CONTEXT_ENG_HOME";
export const PROJECT_ENV = "CONTEXT_ENG_PROJECT";

export function contextHome(): string {
  const override = process.env[HOME_ENV];
  if (override && override.trim().length > 0) return path.resolve(override);
  return path.join(os.homedir(), ".context");
}

export function resolveProjectPath(explicit?: string): string {
  const candidate = explicit ?? process.env[PROJECT_ENV] ?? process.cwd();
  const abs = path.resolve(candidate);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

export function projectKey(resolvedPath: string): string {
  const base = path.basename(resolvedPath) || "root";
  const slug = safeSlug(base);
  const hash = createHash("sha1").update(resolvedPath).digest("hex").slice(0, 10);
  return `${slug}-${hash}`;
}

export function categoryFileName(canonical: string): string {
  const slug = safeSlug(canonical);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return `${slug}-${hash}.db`;
}

function safeSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "category"
  );
}

export interface GlobalLayout {
  home: string;
  /** Legacy v1 files retained as migration sources and recovery copies. */
  globalDb: string;
  globalDir: string;
  globalCatalogDb: string;
  globalCategoriesDir: string;
  globalMapMd: string;
  globalMapJson: string;
}

export interface Layout extends GlobalLayout {
  projectPath: string;
  projectKey: string;
  /** Legacy v1 project file retained as a migration source and recovery copy. */
  projectDb: string;
  projectDir: string;
  projectCatalogDb: string;
  projectCategoriesDir: string;
  projectMapMd: string;
  projectMapJson: string;
}

export function globalLayoutFor(home = contextHome()): GlobalLayout {
  const globalDir = path.join(home, "global");
  return {
    home,
    globalDb: path.join(home, "global.db"),
    globalDir,
    globalCatalogDb: path.join(globalDir, "catalog.db"),
    globalCategoriesDir: path.join(globalDir, "categories"),
    globalMapMd: path.join(home, "map.md"),
    globalMapJson: path.join(home, "map.json"),
  };
}

export function layoutFor(projectPath: string, home = contextHome()): Layout {
  const key = projectKey(projectPath);
  const projectDir = path.join(home, "projects", key);
  const global = globalLayoutFor(home);
  return {
    ...global,
    projectPath,
    projectKey: key,
    projectDb: path.join(projectDir, "memory.db"),
    projectDir,
    projectCatalogDb: path.join(projectDir, "catalog.db"),
    projectCategoriesDir: path.join(projectDir, "categories"),
    projectMapMd: path.join(projectDir, "map.md"),
    projectMapJson: path.join(projectDir, "map.json"),
  };
}
