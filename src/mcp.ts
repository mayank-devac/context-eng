import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  MAX_CATEGORY_LENGTH,
  MAX_FILTER_VALUE_LENGTH,
  MAX_FILTER_VALUES,
  MAX_HITS,
  MAX_JEV_BATCHES,
  MAX_JEV_CANDIDATES,
  MAX_SEARCH_CATEGORIES,
} from "./categories.js";
import { EngineError, type Engine } from "./engine.js";
import {
  NOT_RELEVANT_MESSAGE,
  TypeSafeError,
  TypeSafeRelevanceEvaluator,
  applyRelevanceGate,
  type RelevanceEvaluator,
} from "./typesafe.js";

const CategorySchema = z.string().min(1).max(MAX_CATEGORY_LENGTH);
const LabelArraySchema = z.array(z.string().min(1).max(MAX_FILTER_VALUE_LENGTH)).max(MAX_FILTER_VALUES);
const ListFilterSchema = z.object({
  values: LabelArraySchema,
  match: z.enum(["any", "all"]).optional(),
});
const HintArraySchema = LabelArraySchema.min(1);
const SearchHintsSchema = z.object({
  topics: HintArraySchema.optional(),
  tags: HintArraySchema.optional(),
  links: HintArraySchema.optional(),
  categories: z.array(CategorySchema).min(1).max(MAX_SEARCH_CATEGORIES).optional(),
}).strict();

const ProjectPathSchema = z
  .string()
  .optional()
  .describe(
    "Workspace path. On PROJECT_NOT_BOUND, retry this call with this set. Absolute or `.`. Creates that project's DB if missing.",
  );

function memorySelector(id: string | undefined, line: string | undefined): { id?: string; line?: string } {
  return {
    ...(id !== undefined ? { id } : {}),
    ...(line !== undefined ? { line } : {}),
  };
}

function maybeBind(engine: Engine, projectPath: string | undefined): void {
  if (projectPath !== undefined && projectPath.trim().length > 0) {
    engine.bind(projectPath);
  }
}

function ok(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

function engineFail(err: EngineError, retryTool?: "memory_create" | "memory_edit") {
  const message = err.code === "NEAR_CATEGORY" && retryTool && err.near
    ? `"${err.near.requested}" is too close to existing category "${err.near.existing}". Use category "${err.near.existing}", or retry ${retryTool} with confirmNewCategory: true to create "${err.near.requested}". No memory was written.`
    : err.message;
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: err.code, message }),
      },
    ],
  };
}

interface ContextResult {
  hits: Array<{
    scope: "global" | "project";
    category: string;
    content: string;
    updated_at: number;
  }>;
  eligible_count: number;
  retrieval: {
    mode: "small" | "large";
    candidate_count: number;
    channels: string[];
  };
  message?: string;
}

function contextOnly(result: ContextResult, projectPath: string | undefined) {
  const evaluatedCandidates = Math.min(
    result.retrieval.candidate_count,
    MAX_JEV_CANDIDATES * MAX_JEV_BATCHES,
  );
  const channels = result.retrieval.channels.join("+") || "none";
  const retrieval = result.retrieval.mode === "small"
    ? `retrieval: small · eligible ${result.eligible_count}`
    : `retrieval: large · ${evaluatedCandidates} candidates · ${channels}`;
  const context = result.hits
    .map((hit) => {
      const project = hit.scope === "global" ? "global" : projectPath ?? "unbound";
      const updated = new Date(hit.updated_at * 1000).toISOString();
      return `[last updated: ${updated} | category: ${hit.category} | project: ${project}]\n${hit.content}`;
    })
    .join("\n\n");
  const text = [retrieval, context, result.message || (context ? undefined : NOT_RELEVANT_MESSAGE)]
    .filter(Boolean)
    .join("\n\n");
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
  };
}

function handle(fn: () => unknown, retryTool?: "memory_create" | "memory_edit") {
  try {
    return ok(fn());
  } catch (err) {
    if (err instanceof EngineError) return engineFail(err, retryTool);
    throw err;
  }
}

async function handleSearch(engine: Engine, fn: () => Promise<ContextResult>) {
  try {
    return contextOnly(await fn(), engine.projectPath);
  } catch (err) {
    if (err instanceof EngineError) {
      const message = err.code === "PROJECT_NOT_BOUND" ? `${err.code}: ${err.message}` : err.message;
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: message }],
      };
    }
    throw err;
  }
}

export function createServer(
  engine: Engine,
  relevanceEvaluator: RelevanceEvaluator = new TypeSafeRelevanceEvaluator(),
): McpServer {
  const server = new McpServer({
    name: "context-eng",
    version: "0.1.0",
  });

  server.registerTool(
    "memory_search",
    {
      title: "Search memories",
      description:
        "Search memories before work. query is required. Pass projectPath when no project is bound and scope is project or both; if this returns PROJECT_NOT_BOUND, retry the same call with projectPath. Categories, filters, hints, sort, and limit are optional. Global-only search needs no project. Small filtered sets go entirely to Jev; large sets merge FTS, exact hint-label, typo-retry, and fill candidates before Jev evaluates the first 90 in batches of 30. Hints boost retrieval but never act as hard filters. Up to 50 gated notes are returned. Missing, timed-out, or failed Jev falls back to local lexical and exact-label retrieval.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().describe("The full agent request used for semantic or FTS5 relevance."),
        categories: z
          .array(CategorySchema)
          .min(1)
          .max(MAX_SEARCH_CATEGORIES)
          .optional()
          .describe("Optional unique categories to search; omit to search all available categories."),
        filters: z
          .object({
            scope: z.enum(["both", "global", "project"]).optional(),
            includeStaging: z.boolean().optional(),
            minImportance: z.number().min(0).max(1).optional(),
            subject: z.string().max(MAX_FILTER_VALUE_LENGTH).optional(),
            topics: ListFilterSchema.optional(),
            tags: ListFilterSchema.optional(),
            links: ListFilterSchema.optional(),
            time: z
              .object({
                field: z.enum(["created", "updated"]).optional(),
                preset: z.enum(["this_week", "this_month"]).optional(),
                from: z.string().optional(),
                to: z.string().optional(),
              })
              .optional(),
          })
          .optional(),
        hints: SearchHintsSchema.optional().describe(
          "Optional topic, tag, link, and category boosts. These never replace the raw query or hard-filter results.",
        ),
        sort: z
          .object({
            by: z.enum(["relevance", "updated", "created", "importance"]),
            order: z.enum(["asc", "desc"]).optional(),
          })
          .optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_HITS)
          .optional()
          .describe(`Max hits, 1 to ${MAX_HITS}. Default ${MAX_HITS}.`),
        projectPath: ProjectPathSchema,
      },
    },
    (args) =>
      handleSearch(engine, async () => {
        maybeBind(engine, args.projectPath);
        const input = {
          query: args.query,
          ...(args.categories !== undefined ? { categories: args.categories } : {}),
          ...(args.filters !== undefined ? { filters: args.filters } : {}),
          ...(args.hints !== undefined ? { hints: args.hints } : {}),
          ...(args.sort !== undefined ? { sort: args.sort } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        };
        if (relevanceEvaluator.available?.() === false) return engine.search(input);
        try {
          return await applyRelevanceGate(engine.prepareSearch(input), relevanceEvaluator);
        } catch (error) {
          if (!(error instanceof TypeSafeError)) throw error;
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[context-eng] Jev unavailable; using FTS5 fallback: ${message}\n`);
          return engine.search(input);
        }
      }),
  );

  server.registerTool(
    "memory_create",
    {
      title: "Create a memory",
      description:
        "Write one claim into a built-in or custom category database. A new name that is too similar to an existing category is rejected until the agent uses the existing category or retries with confirmNewCategory: true. Built-in durable categories auto-promote; custom categories start in staging.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        scope: z
          .enum(["global", "project"])
          .describe("Which database to write. global or project."),
        category: CategorySchema.describe("Built-in or custom category; missing custom categories are created unless the name is too similar to an existing category."),
        confirmNewCategory: z
          .boolean()
          .optional()
          .describe("Retry-only override. Set true after NEAR_CATEGORY to explicitly create the requested new category."),
        content: z.string().describe("One sentence. One claim. Hard cap 800 tokens."),
        subject: z.string().max(MAX_FILTER_VALUE_LENGTH).optional(),
        topics: LabelArraySchema.optional(),
        tags: LabelArraySchema.optional(),
        links: LabelArraySchema.optional(),
        importance: z.number().min(0).max(1).optional().describe("0 to 1. Default 0.5."),
        projectPath: ProjectPathSchema,
      },
    },
    (args) =>
      handle(() => {
        maybeBind(engine, args.projectPath);
        return engine.create({
          scope: args.scope,
          category: args.category,
          ...(args.confirmNewCategory !== undefined ? { confirmNewCategory: args.confirmNewCategory } : {}),
          content: args.content,
          ...(args.subject !== undefined ? { subject: args.subject } : {}),
          ...(args.topics !== undefined ? { topics: args.topics } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.links !== undefined ? { links: args.links } : {}),
          ...(args.importance !== undefined ? { importance: args.importance } : {}),
        });
      }, "memory_create"),
  );

  server.registerTool(
    "memory_edit",
    {
      title: "Edit a memory",
      description: "Patch fields on an existing memory by id. Content still has the 800-token one-sentence cap. Changing category auto-promotes or demotes, and a near-duplicate new category requires a second call with confirmNewCategory: true.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        currentCategory: CategorySchema.describe("Category database that currently contains the memory."),
        id: z.string().describe("Memory id."),
        content: z.string().optional().describe("Replacement text. One claim, hard cap 800 tokens."),
        category: CategorySchema.optional().describe("Destination category; moves the memory when changed."),
        confirmNewCategory: z
          .boolean()
          .optional()
          .describe("Retry-only override. Set true after NEAR_CATEGORY to explicitly create the requested destination category."),
        subject: z.string().max(MAX_FILTER_VALUE_LENGTH).nullable().optional(),
        topics: LabelArraySchema.optional(),
        tags: LabelArraySchema.optional(),
        links: LabelArraySchema.optional(),
        importance: z.number().min(0).max(1).optional().describe("Replacement importance, 0 to 1."),
      },
    },
    (args) =>
      handle(() =>
        engine.edit(args.currentCategory, args.id, {
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(args.category !== undefined ? { category: args.category } : {}),
          ...(args.confirmNewCategory !== undefined ? { confirmNewCategory: args.confirmNewCategory } : {}),
          ...(args.subject !== undefined ? { subject: args.subject } : {}),
          ...(args.topics !== undefined ? { topics: args.topics } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.links !== undefined ? { links: args.links } : {}),
          ...(args.importance !== undefined ? { importance: args.importance } : {}),
        }),
      "memory_edit"),
  );

  server.registerTool(
    "memory_list_categories",
    {
      title: "List memory categories",
      description:
        "List current category names. Set scope to global or project, or omit it to list every available scope. An unbound server returns global categories only; explicit project scope requires projectPath or memory_bind.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        scope: z
          .enum(["global", "project"])
          .optional()
          .describe("Optional category scope. Omit to list global and, when bound, project categories."),
        projectPath: ProjectPathSchema,
      },
    },
    (args) =>
      handle(() => {
        maybeBind(engine, args.projectPath);
        return engine.listCategoryNames(args.scope);
      }),
  );

  server.registerTool(
    "memory_map",
    {
      title: "Memory map",
      description:
        "JSON index with memory line IDs for global, project, or both scopes. An unbound default/both request returns the global portion only; explicit project scope needs a bound workspace or projectPath. Collection lines_ids align with lines; staging also includes aligned lines_categories.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        scope: z
          .enum(["both", "global", "project"])
          .optional()
          .describe("Map scope. Defaults to both."),
        projectPath: ProjectPathSchema,
      },
    },
    (args) =>
      handle(() => {
        maybeBind(engine, args.projectPath);
        const index = args.scope === undefined || args.scope === "both"
          ? engine.map()
          : args.scope === "global"
            ? engine.map("global")
            : engine.map("project");
        const includeGlobal = args.scope === undefined || args.scope === "both" || args.scope === "global";
        return {
          ...index,
          maps: {
            ...(includeGlobal ? { global: engine.globalMapPath } : {}),
            ...("project" in index && index.project !== undefined ? { project: engine.projectMapPath } : {}),
          },
        };
      }),
  );

  server.registerTool(
    "memory_bind",
    {
      title: "Bind a project database",
      description:
        "Bind this workspace. Creates ~/.context/projects/<key>/ if missing. Later scope=project writes go there. Does not write AGENTS.md.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        projectPath: z
          .string()
          .describe("Existing workspace path to bind. Absolute or `.`."),
      },
    },
    (args) => handle(() => engine.bind(args.projectPath)),
  );

  server.registerTool(
    "memory_promote",
    {
      title: "Promote a memory",
      description: "Move a staging memory into search. Pass id, the exact line text, or both. Both must name the same note.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        category: CategorySchema.describe("Category database containing the memory."),
        id: z.string().optional().describe("Memory id. Optional when line is the exact memory text."),
        line: z.string().optional().describe("Exact memory text from memory_map lines. Optional when id is set."),
      },
    },
    (args) => handle(() => engine.promote(args.category, memorySelector(args.id, args.line))),
  );

  server.registerTool(
    "memory_demote",
    {
      title: "Demote a memory",
      description: "Move a searchable memory back to staging. Pass id, the exact line text, or both. Both must name the same note.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        category: CategorySchema.describe("Category database containing the memory."),
        id: z.string().optional().describe("Memory id. Optional when line is the exact memory text."),
        line: z.string().optional().describe("Exact memory text from memory_map lines. Optional when id is set."),
      },
    },
    (args) => handle(() => engine.demote(args.category, memorySelector(args.id, args.line))),
  );

  server.registerTool(
    "memory_delete",
    {
      title: "Delete a staging memory",
      description: "Delete a staging memory. Pass id, the exact line text, or both. Both must name the same note. Promoted rows cannot be deleted.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        category: CategorySchema.describe("Category database containing the memory."),
        id: z.string().optional().describe("Staging memory id. Optional when line is the exact memory text."),
        line: z.string().optional().describe("Exact memory text from memory_map lines. Optional when id is set."),
      },
    },
    (args) => handle(() => engine.delete(args.category, memorySelector(args.id, args.line))),
  );

  return server;
}

export async function runStdio(engine: Engine, relevanceEvaluator?: RelevanceEvaluator): Promise<void> {
  const server = createServer(engine, relevanceEvaluator);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      void server.close().finally(() => {
        engine.close();
        resolve();
      });
    };
    process.stdin.on("end", () => {
      setTimeout(finish, 200);
    });
    process.stdin.on("close", () => {
      setTimeout(finish, 200);
    });
  });
}
