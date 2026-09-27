import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../src/engine.js";

export function openIsolatedEngine(): {
  engine: Engine;
  home: string;
  project: string;
  cleanup: () => void;
} {
  const home = mkdtempSync(path.join(os.tmpdir(), "ce-"));
  const project = mkdtempSync(path.join(os.tmpdir(), "ce-"));
  const engine = new Engine({ home, projectPath: project });
  return {
    engine,
    home,
    project,
    cleanup() {
      engine.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    },
  };
}
