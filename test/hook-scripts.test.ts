import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const EXAMPLES = fileURLToPath(new URL("../.agents/skills/hook-development/examples/", import.meta.url));

type Decision = "allow" | "deny" | "ask" | "none";

/** Run a hook script the way Claude Code does: event JSON on stdin, decision JSON on stdout. */
function run(script: string, stdin: string) {
  const result = spawnSync("bash", [path.join(EXAMPLES, script)], { input: stdin, encoding: "utf8" });
  const output = result.stdout.trim();
  const decision: Decision = output
    ? (JSON.parse(output) as { hookSpecificOutput: { permissionDecision: Decision } }).hookSpecificOutput.permissionDecision
    : "none";
  return { status: result.status, decision, output };
}

function event(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: "test",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    cwd: "/home/user/project",
  });
}

const bash = (command: string) => run("validate-bash.sh", event("Bash", { command }));
const write = (file_path: string) => run("validate-write.sh", event("Write", { file_path, content: "x" }));

describe("validate-bash.sh", () => {
  it.each([
    "ls -la",
    "npm test",
    "git status && git diff",
    "npm test > /dev/null 2>&1",
    "echo hi >/dev/null",
    "cmd 2> /dev/stderr",
    "rm file.txt",
    "rm -r build",
    "rm -f stale.lock",
    "summarize --sudoku",
    "jq -r '.a | .b' data.json",
    "dd --version",
    "",
  ])("allows %j", (command) => {
    expect(bash(command)).toMatchObject({ status: 0, decision: "none" });
  });

  it.each([
    "rm -rf /tmp/x",
    "rm -fr /tmp/x",
    "rm -Rf /tmp/x",
    "rm -r -f /tmp/x",
    "rm -f -r /tmp/x",
    "rm --recursive --force /tmp/x",
    "rm -v -rf x",
    "/bin/rm -rf x",
    "ls && rm -rf /",
    "ls; rm -rf /",
    "echo ok || rm -rf ~",
    "true | xargs rm -rf",
    "bash -c \"rm -rf /\"",
    "sh -c 'rm -rf /'",
    "echo $(rm -rf /)",
    "(cd / && rm -rf x)",
    "FOO=1 rm -rf x",
    "env rm -rf x",
    "rm -rf x\nls",
  ])("denies recursive force rm: %j", (command) => {
    expect(bash(command)).toMatchObject({ status: 0, decision: "deny" });
  });

  it.each([
    "dd if=/dev/zero of=/dev/sda",
    "mkfs.ext4 /dev/sdb1",
    "mkfs -t ext4 /dev/sdb1",
    "echo x > /dev/sda",
    "cat img >> /dev/nvme0n1",
  ])("denies dangerous system operation: %j", (command) => {
    expect(bash(command)).toMatchObject({ status: 0, decision: "deny" });
  });

  it.each([
    "sudo apt update",
    "cd / && sudo ls",
    "ls | sudo tee /etc/hosts",
    "su -c whoami",
    "doas ls",
  ])("asks for elevated privileges: %j", (command) => {
    expect(bash(command)).toMatchObject({ status: 0, decision: "ask" });
  });

  it("denies when sudo wraps a dangerous command", () => {
    expect(bash("sudo rm -rf /").decision).toBe("deny");
    expect(bash("sudo -u root rm -rf /").decision).toBe("deny");
  });

  it("does not flag dd text inside a commit message that doesn't start with dd", () => {
    expect(bash("git commit -m \"fix: handle dd if=x case\"").decision).toBe("none");
  });

  it("denies unparseable input instead of crashing", () => {
    expect(run("validate-bash.sh", "not json")).toMatchObject({ status: 0, decision: "deny" });
  });

  it("emits a well-formed PreToolUse decision with a reason", () => {
    const parsed = JSON.parse(bash("rm -rf /").output);
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Dangerous command detected: rm -rf",
      },
    });
  });
});

describe("validate-write.sh", () => {
  it.each([
    "/home/user/project/src/a.ts",
    "/home/user/project/notes/a..b.md",
    "/home/user/project/.env.example",
    "/home/user/project/README.md",
  ])("allows %j", (file) => {
    expect(write(file)).toMatchObject({ status: 0, decision: "none" });
  });

  it.each([
    "/home/user/../../etc/passwd",
    "../outside.txt",
    "/home/user/project/..",
  ])("denies path traversal: %j", (file) => {
    expect(write(file).decision).toBe("deny");
  });

  it.each(["/etc/passwd", "/usr/bin/x", "/sys/kernel/x", "/boot/grub.cfg", "/dev/sda"])(
    "denies system directory: %j",
    (file) => {
      expect(write(file).decision).toBe("deny");
    },
  );

  it.each([
    "/p/.env",
    "/p/.env.local",
    "/p/.env.production",
    "/p/config/prod.env",
    "/p/src/secrets.ts",
    "/p/AWS_CREDENTIALS.json",
    "/root/.ssh/authorized_keys",
    "/root/.aws/config",
    "/p/certs/server.pem",
    "/p/tls.key",
    "/root/.npmrc",
  ])("asks for sensitive file: %j", (file) => {
    expect(write(file)).toMatchObject({ status: 0, decision: "ask" });
  });

  it("ignores events without a file path", () => {
    expect(run("validate-write.sh", event("Write", {}))).toMatchObject({ status: 0, decision: "none" });
  });

  it("denies unparseable input instead of crashing", () => {
    expect(run("validate-write.sh", "{bad")).toMatchObject({ status: 0, decision: "deny" });
  });
});
