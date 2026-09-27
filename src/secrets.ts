export const TYPE_SAFE_KEY_PROMPT = "TypeSafe API key (hidden, Enter to skip): ";
export const TYPE_SAFE_KEY_REPLACE_PROMPT = "New TypeSafe API key (hidden, Enter to keep the saved key): ";

export interface SecretStore {
  get(): string | null;
  set(secret: string): void;
}

export type TypeSafeKeyStatus = "present" | "saved" | "skipped";

const KEYCHAIN_SERVICE = "context-eng";
const KEYCHAIN_ACCOUNT = "typesafe-api-key";

export function resolveTypeSafeApiKey(
  env: { TYPESAFE_API_KEY?: string },
  read: () => string | null,
): { apiKey: string; warning?: string } {
  if (env.TYPESAFE_API_KEY !== undefined) return { apiKey: env.TYPESAFE_API_KEY.trim() };
  try {
    return { apiKey: read()?.trim() ?? "" };
  } catch (error) {
    return {
      apiKey: "",
      warning: `TypeSafe keychain unreadable. Search will stay local. ${errorText(error)}`,
    };
  }
}

export async function loadTypeSafeApiKey(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ apiKey: string; warning?: string }> {
  if (env.TYPESAFE_API_KEY !== undefined) return { apiKey: env.TYPESAFE_API_KEY.trim() };
  const store = await openOsKeychain();
  return resolveTypeSafeApiKey(env, () => store.get());
}

export async function openOsKeychain(): Promise<SecretStore> {
  try {
    const { Entry } = await import("@napi-rs/keyring");
    const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    return {
      get: () => entry.getPassword(),
      set: (secret: string) => {
        entry.setPassword(secret);
      },
    };
  } catch (error) {
    const message = `OS keychain is unavailable. ${errorText(error)}`;
    return {
      get() {
        throw new Error(message);
      },
      set() {
        throw new Error(message);
      },
    };
  }
}

export async function ensureTypeSafeKey(options: {
  store: SecretStore;
  interactive: boolean;
  prompt?: (label: string) => Promise<string>;
  log?: (line: string) => void;
}): Promise<TypeSafeKeyStatus> {
  const log = options.log ?? ((line: string) => console.log(line));
  let existing: string | null;
  try {
    existing = options.store.get();
  } catch (error) {
    log(`TypeSafe keychain unavailable. Search will stay local. ${errorText(error)}`);
    return "skipped";
  }
  const replacing = existing !== null && existing.trim() !== "";
  if (!options.interactive) {
    log(replacing
      ? "TypeSafe key is already in the OS keychain."
      : "No TypeSafe key saved. Run context-eng init in a terminal to store one in the OS keychain.");
    return replacing ? "present" : "skipped";
  }
  log(replacing
    ? "A TypeSafe key is already saved. Enter a new key to replace it, or press Enter to keep it."
    : "The key is stored in the OS keychain for this login. It is not written to the project.");
  const prompt = options.prompt ?? ((label: string) => promptHidden(label));
  const key = (await prompt(replacing ? TYPE_SAFE_KEY_REPLACE_PROMPT : TYPE_SAFE_KEY_PROMPT)).trim();
  if (key === "") {
    log(replacing
      ? "Kept the saved TypeSafe key."
      : "Skipped. Search stays on local FTS5 until a key is saved.");
    return replacing ? "present" : "skipped";
  }
  try {
    options.store.set(key);
  } catch (error) {
    log(replacing
      ? `Could not replace the TypeSafe key. The saved key is unchanged. ${errorText(error)}`
      : `Could not save the TypeSafe key. Search will stay local. ${errorText(error)}`);
    return replacing ? "present" : "skipped";
  }
  log(replacing
    ? "Replaced the TypeSafe key in the OS keychain."
    : "Saved the TypeSafe key in the OS keychain.");
  return "saved";
}

export function promptHidden(
  label: string,
  io: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream } = {},
): Promise<string> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  if (!input.isTTY || typeof input.setRawMode !== "function") return Promise.resolve("");
  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      output.write("\n");
      fn();
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          finish(() => reject(new Error("TypeSafe key prompt aborted")));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish(() => resolve(value.trim()));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " ") value += char;
      }
    };
    output.write(label);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
