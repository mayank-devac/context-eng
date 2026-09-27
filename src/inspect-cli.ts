#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Engine, EngineError, type SearchInput } from "./engine.js";
import { renderSearchInspection, runSearchInspection } from "./inspect.js";
import { loadTypeSafeApiKey } from "./secrets.js";
import { TypeSafeRelevanceEvaluator } from "./typesafe.js";

const USAGE = `Usage:
  npm run inspect:search -- --project <path> --query <text> [--scope project|global|both] [--jev] [--json]
  npm run inspect:search -- --project <path> --input '<SearchInput JSON>' [--jev] [--json]

Examples:
  npm run inspect:search -- --project . --query "memory create rules" --scope project
  npm run inspect:search -- --project . --input '{"query":"memory rules","filters":{"scope":"project"}}' --jev

The script never reads .env itself. --jev uses TYPESAFE_API_KEY when set, otherwise the OS keychain entry saved by context-eng init. TYPESAFE_API_URL still comes from the environment.
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: "string", default: "." },
      query: { type: "string" },
      scope: { type: "string" },
      input: { type: "string" },
      jev: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.input !== undefined && values.query !== undefined) {
    throw new Error("use either --input or --query, not both");
  }

  const input = values.input !== undefined
    ? parseInput(values.input)
    : shorthandInput(values.query, values.scope);
  const engine = new Engine({ projectPath: values.project ?? "." });
  try {
    const jev = values.jev === true ? await loadTypeSafeApiKey() : undefined;
    if (jev?.warning) console.error(jev.warning);
    const report = await runSearchInspection(engine, input, {
      evaluateJev: values.jev === true,
      ...(jev ? { evaluator: new TypeSafeRelevanceEvaluator({ apiKey: jev.apiKey }) } : {}),
    });
    process.stdout.write(values.json === true ? `${JSON.stringify(report, null, 2)}\n` : renderSearchInspection(report));
  } finally {
    engine.close();
  }
}

function parseInput(raw: string): SearchInput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`--input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (!isSearchInput(value)) throw new Error("--input.query must be a non-empty string");
  return value;
}

function isSearchInput(value: unknown): value is SearchInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const query = (value as { query?: unknown }).query;
  return typeof query === "string" && query.trim() !== "";
}

function shorthandInput(query: string | undefined, scope: string | undefined): SearchInput {
  if (query === undefined || query.trim() === "") throw new Error("--query is required when --input is omitted");
  if (scope !== undefined && !isSearchScope(scope)) {
    throw new Error("--scope must be project, global, or both");
  }
  return {
    query,
    ...(scope !== undefined ? { filters: { scope } } : {}),
  };
}

function isSearchScope(value: string): value is "project" | "global" | "both" {
  return value === "project" || value === "global" || value === "both";
}

main().catch((error: unknown) => {
  const message = error instanceof EngineError
    ? `${error.code}: ${error.message}`
    : error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exitCode = 1;
});
