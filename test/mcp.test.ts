import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { categoryFileName, layoutFor, resolveProjectPath } from "../src/paths.js";
import { NOT_RELEVANT_MESSAGE } from "../src/typesafe.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

const fakeTypeSafe = createHttpServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    questions: Record<string, unknown>;
    state: { contexts: string[] };
  };
  if (body.state.contexts.some((context) => context.includes("Trigger Jev failure fallback"))) {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "temporary" }));
    return;
  }
  const answers = Object.fromEntries(
    Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.9 }]),
  );
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ answers }));
});

const fakeTypeSafeUrl = new Promise<string>((resolve, reject) => {
  fakeTypeSafe.once("error", reject);
  fakeTypeSafe.listen(0, "127.0.0.1", () => {
    const address = fakeTypeSafe.address();
    if (address === null || typeof address === "string") {
      reject(new Error("fake TypeSafe server did not expose a TCP port"));
      return;
    }
    resolve(`http://127.0.0.1:${address.port}/v1/systemone`);
  });
});

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      fakeTypeSafe.close((error) => (error ? reject(error) : resolve()));
    }),
);

interface TextResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

function payload<T>(result: unknown): T {
  const text = (result as TextResult).content[0]?.text ?? "";
  return JSON.parse(text) as T;
}

function resultText(result: unknown): string {
  return (result as TextResult).content[0]?.text ?? "";
}

function expectMemoryResult(
  result: string,
  expected: { content: string; category: string; project: string },
): void {
  const [retrieval, firstMemory] = result.split("\n\n");
  expect(retrieval).toMatch(/^retrieval: (small|large) · /);
  const [metadata, content] = (firstMemory ?? "").split("\n");
  expect(metadata).toMatch(/^\[last updated: \d{4}-\d{2}-\d{2}T.*Z \| /);
  expect(metadata).toContain(`category: ${expected.category}`);
  expect(metadata).toContain(`project: ${expected.project}]`);
  expect(content).toBe(expected.content);
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

describe("MCP stdio server end to end", { timeout: 60_000 }, () => {
  let home: string;
  let project: string;
  let client: Client;

  beforeAll(async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "ce-mcp-home-"));
    project = mkdtempSync(path.join(os.tmpdir(), "ce-mcp-project-"));
    const env = processEnv();
    env.CONTEXT_ENG_HOME = home;
    env.TYPESAFE_API_KEY = "test-key";
    env.TYPESAFE_API_URL = await fakeTypeSafeUrl;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX, path.join(REPO, "src", "cli-entry.ts"), "mcp", "--project", project],
      env,
      stderr: "pipe",
    });
    client = new Client({ name: "context-eng-test", version: "0.0.0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("advertises the memory tools and accepts search without categories", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "memory_bind",
      "memory_create",
      "memory_delete",
      "memory_demote",
      "memory_edit",
      "memory_list_categories",
      "memory_map",
      "memory_promote",
      "memory_search",
    ]);
    const result = (await client.callTool({
      name: "memory_search",
      arguments: { query: "How does memory_search choose Jev versus FTS5?" },
    })) as TextResult;
    expect(result.isError).not.toBe(true);
    expect(resultText(result)).toBe(
      `retrieval: small · eligible 0\n\n${NOT_RELEVANT_MESSAGE}`,
    );
    const searchTool = tools.find((tool) => tool.name === "memory_search");
    expect(searchTool?.inputSchema).toMatchObject({
      properties: { categories: { maxItems: 4 } },
    });
  });

  it("lists categories in both scopes by default and accepts a scope", async () => {
    await client.callTool({
      name: "memory_create",
      arguments: {
        scope: "global",
        category: "instruction",
        content: "Keep global category discovery available.",
      },
    });
    await client.callTool({
      name: "memory_create",
      arguments: {
        scope: "project",
        category: "research",
        content: "Keep project category discovery available.",
      },
    });

    expect(
      payload<{
        global: string[];
        project: { projectPath: string; categories: string[] };
      }>(await client.callTool({ name: "memory_list_categories", arguments: {} })),
    ).toEqual({
      global: ["instruction"],
      project: {
        projectPath: resolveProjectPath(project),
        categories: ["research"],
      },
    });
    expect(
      payload<{ global: string[] }>(
        await client.callTool({
          name: "memory_list_categories",
          arguments: { scope: "global" },
        }),
      ),
    ).toEqual({ global: ["instruction"] });
  });

  it("asks for a second memory_create call before making a near-duplicate category", async () => {
    await client.callTool({
      name: "memory_create",
      arguments: { scope: "project", category: "architecture", content: "Keep architecture notes focused." },
    });

    const rejected = (await client.callTool({
      name: "memory_create",
      arguments: { scope: "project", category: "architectures", content: "Keep architectures separate." },
    })) as TextResult;
    expect(rejected.isError).toBe(true);
    expect(payload<{ error: string; message: string }>(rejected)).toEqual({
      error: "NEAR_CATEGORY",
      message:
        '"architectures" is too close to existing category "architecture". Use category "architecture", or retry memory_create with confirmNewCategory: true to create "architectures". No memory was written.',
    });
    expect(
      payload<{ project: { categories: string[] } }>(
        await client.callTool({ name: "memory_list_categories", arguments: { scope: "project" } }),
      ).project.categories,
    ).not.toContain("architectures");

    const confirmed = payload<{ memory: { category: string } }>(
      await client.callTool({
        name: "memory_create",
        arguments: {
          scope: "project",
          category: "architectures",
          confirmNewCategory: true,
          content: "Keep architectures separate.",
        },
      }),
    );
    expect(confirmed.memory.category).toBe("architectures");
  });

  it("asks for a second memory_edit call before making a separator-only category variant", async () => {
    const created = payload<{ memory: { id: string } }>(
      await client.callTool({
        name: "memory_create",
        arguments: { scope: "project", category: "batch-probe", content: "Keep batch probes isolated." },
      }),
    );

    const rejected = (await client.callTool({
      name: "memory_edit",
      arguments: {
        currentCategory: "batch-probe",
        id: created.memory.id,
        category: "batch_probe",
      },
    })) as TextResult;
    expect(rejected.isError).toBe(true);
    expect(payload<{ error: string; message: string }>(rejected)).toEqual({
      error: "NEAR_CATEGORY",
      message:
        '"batch_probe" is too close to existing category "batch-probe". Use category "batch-probe", or retry memory_edit with confirmNewCategory: true to create "batch_probe". No memory was written.',
    });

    const moved = payload<{ category: string }>(
      await client.callTool({
        name: "memory_edit",
        arguments: {
          currentCategory: "batch-probe",
          id: created.memory.id,
          category: "batch_probe",
          confirmNewCategory: true,
        },
      }),
    );
    expect(moved.category).toBe("batch_probe");
  });

  it("creates a category database and searches it through Jev", async () => {
    const created = payload<{ memory: { id: string; staging: boolean }; promoted: boolean }>(
      await client.callTool({
        name: "memory_create",
        arguments: {
          scope: "project",
          category: "mistake",
          content: "Revoke Blob URLs after use to stop the image memory leak.",
          subject: "canvas export",
          topics: ["browser memory"],
          tags: ["blob-url"],
          links: ["cli.ts"],
        },
      }),
    );
    expect(created.promoted).toBe(true);
    const layout = layoutFor(resolveProjectPath(project), home);
    const file = path.join(layout.projectCategoriesDir, categoryFileName("mistake"));
    const db = new Database(file, { readonly: true });
    const row = db.prepare(`SELECT content, subject FROM memories WHERE id = ?`).get(created.memory.id) as {
      content: string;
      subject: string;
    };
    db.close();
    expect(row.subject).toBe("canvas export");

    const found = resultText(
      await client.callTool({
        name: "memory_search",
        arguments: {
          query: "fix the image memory leak",
          categories: ["mistake"],
          filters: { subject: "canvas export", links: { values: ["cli.ts"] } },
        },
      }),
    );
    expectMemoryResult(found, { content: row.content, category: "mistake", project: resolveProjectPath(project) });
    const foundWithoutCategories = resultText(
      await client.callTool({
        name: "memory_search",
        arguments: { query: "fix the image memory leak" },
      }),
    );
    expectMemoryResult(foundWithoutCategories, {
      content: row.content,
      category: "mistake",
      project: resolveProjectPath(project),
    });
  });

  it("keeps custom categories staged and routes row mutations by category", async () => {
    const created = payload<{ memory: { id: string; staging: boolean } }>(
      await client.callTool({
        name: "memory_create",
        arguments: { scope: "project", category: "research", content: "Compare semantic routers.", subject: "semantic routers" },
      }),
    );
    expect(created.memory.staging).toBe(true);
    expect(
      resultText(
        await client.callTool({
          name: "memory_search",
          arguments: { query: "semantic routers", categories: ["research"] },
        }),
      ),
    ).toBe(`retrieval: small · eligible 0\n\n${NOT_RELEVANT_MESSAGE}`);
    expectMemoryResult(
      resultText(
        await client.callTool({
          name: "memory_search",
          arguments: {
            query: "semantic routers",
            categories: ["research"],
            filters: { includeStaging: true, subject: "semantic routers" },
          },
        }),
      ),
      { content: "Compare semantic routers.", category: "research", project: resolveProjectPath(project) },
    );

    await client.callTool({ name: "memory_promote", arguments: { category: "research", id: created.memory.id } });
    const refused = (await client.callTool({
      name: "memory_delete",
      arguments: { category: "research", id: created.memory.id },
    })) as TextResult;
    expect(payload<{ error: string }>(refused).error).toBe("NOT_STAGING");
    await client.callTool({ name: "memory_demote", arguments: { category: "research", id: created.memory.id } });
    expect(
      payload<{ deleted: boolean }>(
        await client.callTool({
          name: "memory_delete",
          arguments: { category: "research", id: created.memory.id },
        }),
      ).deleted,
    ).toBe(true);
  });

  it("aggregates category discovery in the project map", async () => {
    const promoted = payload<{ memory: { id: string } }>(
      await client.callTool({
        name: "memory_create",
        arguments: { scope: "project", category: "decision", content: "Keep map IDs available." },
      }),
    );
    const staged = payload<{ memory: { id: string } }>(
      await client.callTool({
        name: "memory_create",
        arguments: { scope: "project", category: "map-review", content: "Keep staged map IDs available." },
      }),
    );
    const map = payload<{
      global?: unknown;
      project: {
        collections: Array<{ category: string; lines: string[]; lines_ids: string[] }>;
        staging: { lines: string[]; lines_ids: string[]; lines_categories: string[] };
        counts: Record<string, number>;
      };
      maps: { global?: string; project: string };
    }>(
      await client.callTool({
        name: "memory_map",
        arguments: { scope: "project", projectPath: project },
      }),
    );
    expect(map.global).toBeUndefined();
    expect(map.maps.global).toBeUndefined();
    expect(map.project.collections.map((item) => item.category)).toEqual(expect.arrayContaining(["mistake", "research"]));
    const decisions = map.project.collections.find((item) => item.category === "decision");
    expect(decisions?.lines_ids).toContain(promoted.memory.id);
    expect(map.project.staging.lines_ids).toContain(staged.memory.id);
    const stagedIndex = map.project.staging.lines_ids.indexOf(staged.memory.id);
    expect(map.project.staging.lines[stagedIndex]).toBe("Keep staged map IDs available.");
    expect(map.project.staging.lines_categories[stagedIndex]).toBe("map-review");
    const layout = layoutFor(resolveProjectPath(project), home);
    expect(existsSync(layout.projectMapMd)).toBe(true);
    expect(readFileSync(layout.projectMapMd, "utf8")).toContain("- mistake (1)");

    const globalMap = payload<{ global: unknown; project?: unknown; maps: { global: string; project?: string } }>(
      await client.callTool({ name: "memory_map", arguments: { scope: "global" } }),
    );
    expect(globalMap.global).toBeDefined();
    expect(globalMap.project).toBeUndefined();
    expect(globalMap.maps.project).toBeUndefined();

    const bothMap = payload<{ global: unknown; project: unknown; maps: { global: string; project: string } }>(
      await client.callTool({ name: "memory_map", arguments: { scope: "both" } }),
    );
    expect(bothMap.global).toBeDefined();
    expect(bothMap.project).toBeDefined();
    expect(bothMap.maps.global).toBeDefined();
    expect(bothMap.maps.project).toBeDefined();
  });

  it("falls back to FTS5 when Jev returns an error", async () => {
    await client.callTool({
      name: "memory_create",
      arguments: {
        scope: "project",
        category: "decision",
        content: "Trigger Jev failure fallback for resilient search.",
      },
    });
    const found = resultText(
      await client.callTool({
        name: "memory_search",
        arguments: { query: "jev failure fallback", categories: ["decision"] },
      }),
    );
    expectMemoryResult(found, {
      content: "Trigger Jev failure fallback for resilient search.",
      category: "decision",
      project: resolveProjectPath(project),
    });
  });
});

describe("MCP FTS5 fallback", { timeout: 60_000 }, () => {
  it("returns local results when no TypeSafe key is configured", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ce-mcp-fallback-home-"));
    const project = mkdtempSync(path.join(os.tmpdir(), "ce-mcp-fallback-project-"));
    const env = processEnv();
    env.CONTEXT_ENG_HOME = home;
    // Empty value selects local search and does not fall through to the OS keychain.
    env.TYPESAFE_API_KEY = "";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX, path.join(REPO, "src", "cli-entry.ts"), "mcp", "--project", project],
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "context-eng-fallback-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      await client.callTool({
        name: "memory_create",
        arguments: { scope: "project", category: "decision", content: "Use SQLite fallback search." },
      });
      const found = resultText(
        await client.callTool({
          name: "memory_search",
          arguments: { query: "sqlite fallback", categories: ["decision"] },
        }),
      );
      expectMemoryResult(found, {
        content: "Use SQLite fallback search.",
        category: "decision",
        project: resolveProjectPath(project),
      });

      await client.callTool({
        name: "memory_create",
        arguments: {
          scope: "project",
          category: "decision",
          content: "Revoke object URLs after export.",
          topics: ["browser memory"],
        },
      });
      const hinted = resultText(
        await client.callTool({
          name: "memory_search",
          arguments: {
            query: "different lexical request",
            categories: ["decision"],
            hints: { topics: ["browser memory"] },
          },
        }),
      );
      expectMemoryResult(hinted, {
        content: "Revoke object URLs after export.",
        category: "decision",
        project: resolveProjectPath(project),
      });
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("MCP deferred project binding", { timeout: 60_000 }, () => {
  it("allows global search and requires projectPath or memory_bind for project search", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ce-mcp-unbound-home-"));
    const project = mkdtempSync(path.join(os.tmpdir(), "ce-mcp-bound-project-"));
    const env = processEnv();
    env.CONTEXT_ENG_HOME = home;
    delete env.CONTEXT_ENG_PROJECT;
    // Empty value selects local search and does not fall through to the OS keychain.
    env.TYPESAFE_API_KEY = "";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX, path.join(REPO, "src", "cli-entry.ts"), "mcp"],
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "context-eng-unbound-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const globalCreated = payload<{ memory: { id: string } }>(await client.callTool({
        name: "memory_create",
        arguments: { scope: "global", category: "instruction", content: "Keep unbound global search available." },
      }));
      expectMemoryResult(
        resultText(
          await client.callTool({
            name: "memory_search",
            arguments: { query: "unbound global", filters: { scope: "global" } },
          }),
        ),
        { content: "Keep unbound global search available.", category: "instruction", project: "global" },
      );
      expect(
        payload<{ global: string[] }>(
          await client.callTool({ name: "memory_list_categories", arguments: {} }),
        ),
      ).toEqual({ global: ["instruction"] });
      const unboundMap = payload<{ global: unknown; project?: unknown; maps: { global: string; project?: string } }>(
        await client.callTool({ name: "memory_map", arguments: {} }),
      );
      expect(unboundMap.global).toBeDefined();
      expect(unboundMap.project).toBeUndefined();
      expect(unboundMap.maps.project).toBeUndefined();
      for (const request of [
        { name: "memory_list_categories", arguments: { scope: "project" } },
        { name: "memory_map", arguments: { scope: "project" } },
      ]) {
        const projectRefused = payload<{ error: string; message: string }>(await client.callTool(request));
        expect(projectRefused.error).toBe("PROJECT_NOT_BOUND");
        expect(projectRefused.message).toContain("projectPath");
      }

      const refused = (await client.callTool({
        name: "memory_search",
        arguments: { query: "project memory", filters: { scope: "project" } },
      })) as TextResult;
      expect(refused.isError).toBe(true);
      expect(resultText(refused)).toBe(
        "PROJECT_NOT_BOUND: pass projectPath or call memory_bind before using project memory",
      );

      for (const request of [
        {
          name: "memory_edit",
          arguments: { currentCategory: "instruction", id: globalCreated.memory.id, importance: 0.8 },
        },
        { name: "memory_promote", arguments: { category: "instruction", id: globalCreated.memory.id } },
        { name: "memory_demote", arguments: { category: "instruction", id: globalCreated.memory.id } },
        { name: "memory_delete", arguments: { category: "instruction", id: globalCreated.memory.id } },
      ]) {
        const idRefused = payload<{ error: string; message: string }>(await client.callTool(request));
        expect(idRefused.error).toBe("PROJECT_NOT_BOUND");
        expect(idRefused.message).toContain("call memory_bind");
        expect(idRefused.message).not.toContain("projectPath");
      }

      const bound = resultText(
        await client.callTool({
          name: "memory_search",
          arguments: { query: "project memory", filters: { scope: "project" }, projectPath: project },
        }),
      );
      expect(bound).toBe(`retrieval: small · eligible 0\n\n${NOT_RELEVANT_MESSAGE}`);
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});
