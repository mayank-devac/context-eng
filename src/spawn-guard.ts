// Stops a chain of context-eng processes that start each other.
//
// context-eng never starts another copy of itself, so a normal run always
// sees depth 0. Each run sets CONTEXT_ENG_DEPTH to its own depth + 1, and
// child processes inherit that variable. If some loop (a bad link, a host
// that restarts us from inside our own child, a shell reading the wrong file
// through node) makes copies start copies, the depth climbs and the copy at
// MAX_DEPTH exits at once instead of starting more.
export const DEPTH_VARIABLE = "CONTEXT_ENG_DEPTH";
export const MAX_DEPTH = 3;

export type SpawnCheck =
  | { ok: true; nextDepth: string }
  | { ok: false; message: string };

export function checkSpawnDepth(env: NodeJS.ProcessEnv): SpawnCheck {
  const parsed = Number.parseInt(env[DEPTH_VARIABLE] ?? "0", 10);
  const depth = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  if (depth >= MAX_DEPTH) {
    return {
      ok: false,
      message: `context-eng: refusing to start: ${depth} copies are already nested (${DEPTH_VARIABLE}=${depth}). ` +
        "Something is starting context-eng in a loop. Run `context-eng doctor` to check your configs.",
    };
  }
  return { ok: true, nextDepth: String(depth + 1) };
}
