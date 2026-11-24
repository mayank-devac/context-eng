// Shared parsing for the JSON config files init and doctor read and edit.

export type JsonObject = Record<string, unknown>;

export function plainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses `text` as a JSON object; `label` names the file in both error messages. */
export function parseJsonObject(text: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is invalid JSON (${message})`, { cause: error });
  }
  if (!plainObject(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

/** Index just past the JSON string that opens at `start` (a `"`). */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  return i + 1;
}

/**
 * JSONC -> JSON: drops `//` and `/* *\/` comments and trailing commas, leaving
 * strings alone. Returns `text` unchanged when it has no JSONC-only syntax.
 */
export function stripJsonc(text: string): string {
  let noComments = "";
  for (let i = 0; i < text.length;) {
    if (text[i] === '"') {
      const end = stringEnd(text, i);
      noComments += text.slice(i, end);
      i = end;
    } else if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      noComments += " ";
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      noComments += " ";
    } else {
      noComments += text[i];
      i += 1;
    }
  }
  let out = "";
  for (let i = 0; i < noComments.length;) {
    if (noComments[i] === '"') {
      const end = stringEnd(noComments, i);
      out += noComments.slice(i, end);
      i = end;
      continue;
    }
    if (noComments[i] === ",") {
      let next = i + 1;
      while (/\s/.test(noComments[next] ?? "")) next += 1;
      if (noComments[next] === "}" || noComments[next] === "]") {
        i += 1;
        continue;
      }
    }
    out += noComments[i];
    i += 1;
  }
  return out;
}

/** Like parseJsonObject, but also accepts the comments and trailing commas OpenCode allows in its configs. */
export function parseJsoncObject(text: string, label: string): JsonObject {
  try {
    return parseJsonObject(text, label);
  } catch (error) {
    const stripped = stripJsonc(text);
    if (stripped === text) throw error;
    try {
      return parseJsonObject(stripped, label);
    } catch (strippedError) {
      // Keep the syntax error's positions from the original text; a shape error stands as is.
      const syntax = strippedError instanceof Error && strippedError.cause instanceof SyntaxError;
      throw syntax ? error : strippedError;
    }
  }
}
