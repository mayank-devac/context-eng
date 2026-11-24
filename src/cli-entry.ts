#!/usr/bin/env node
import { checkSpawnDepth, DEPTH_VARIABLE } from "./spawn-guard.js";

// Check the copy limit before loading the CLI, so a runaway copy exits in a
// few milliseconds without opening databases or native modules.
const spawn = checkSpawnDepth(process.env);
if (!spawn.ok) {
  console.error(spawn.message);
  process.exit(1);
}
process.env[DEPTH_VARIABLE] = spawn.nextDepth;

const { main } = await import("./cli.js");

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
