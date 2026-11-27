// OpenCode entry point of the context-eng plugin. OpenCode loads it through
// ../server.js: 2.x calls setup(), 1.x calls server(). It reuses the plugin's shared
// files, so every host gets the same instructions and skills:
//   - mcp:     adds the context-eng MCP server, unless one is already configured
//   - command: adds /context-eng:recall and /context-eng:postsession
//   - session: adds rules/AGENTS.md to each session's system prompt, unless the
//              user's own AGENTS.md already carries the context-eng block
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = "<!-- context-eng:start -->";

function read(relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

/** Splits `---` YAML frontmatter from a Markdown body; returns the description and body. */
function parseSkill(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { description: "", body: text.trim() };
  const description = /^description:\s*(.+)$/m.exec(match[1])?.[1]?.trim() ?? "";
  return { description, body: text.slice(match[0].length).trim() };
}

function systemText(part) {
  return typeof part === "string" ? part : part?.text ?? "";
}

export default {
  id: "context-eng",
  async setup(ctx) {
    const rules = read("rules/AGENTS.md").trim();

    await ctx.mcp?.transform?.((editor) => {
      if (editor.get("context-eng")) return;
      editor.set("context-eng", { type: "local", command: ["node", path.join(root, "scripts", "mcp.mjs"), "mcp"] });
    });

    await ctx.command?.transform?.((editor) => {
      for (const skill of ["recall", "postsession"]) {
        const { description, body } = parseSkill(read(`skills/${skill}/SKILL.md`));
        editor.add({
          name: `context-eng:${skill}`,
          description,
          execute: async ({ sessionID, prompt, delivery }) => {
            const topic = (prompt?.text ?? "").trim();
            const text = skill === "recall" ? `${body}\n\nTopic: ${topic}` : body;
            await ctx.session.prompt({ ...prompt, sessionID, delivery, text });
          },
        });
      }
    });

    await ctx.session?.hook?.("context", async (event) => {
      if (event.system.some((part) => systemText(part).includes(MARKER))) return;
      event.system.push({ type: "text", text: rules });
    });
  },

  // OpenCode 1.x calls server() instead of setup() and uses config and
  // system-prompt hooks instead of the 2.x editors.
  async server() {
    const rules = read("rules/AGENTS.md").trim();
    return {
      config: async (config) => {
        config.mcp ??= {};
        if (!config.mcp["context-eng"]) {
          config.mcp["context-eng"] = { type: "local", command: ["node", path.join(root, "scripts", "mcp.mjs"), "mcp"] };
        }
        config.command ??= {};
        for (const skill of ["recall", "postsession"]) {
          const { description, body } = parseSkill(read(`skills/${skill}/SKILL.md`));
          const template = skill === "recall" ? `${body}\n\nTopic: $ARGUMENTS` : body;
          config.command[`context-eng:${skill}`] ??= { description, template };
        }
      },
      "experimental.chat.system.transform": async (_input, output) => {
        if (output.system.some((part) => systemText(part).includes(MARKER))) return;
        output.system.push(rules);
      },
    };
  },
};
