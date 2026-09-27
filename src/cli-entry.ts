#!/usr/bin/env node
import { main } from "./cli.js";

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
