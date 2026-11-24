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
