import { describe, expect, it } from "vitest";
import { ensureTypeSafeKey, resolveTypeSafeApiKey, type SecretStore } from "../src/secrets.js";

function memoryStore(initial: string | null = null): SecretStore & { saved: string | null } {
  const state = { saved: initial };
  return {
    get saved() {
      return state.saved;
    },
    get: () => state.saved,
    set: (secret: string) => {
      state.saved = secret;
    },
  };
}

describe("resolveTypeSafeApiKey", () => {
  it("uses TYPESAFE_API_KEY and does not read the keychain", () => {
    expect(resolveTypeSafeApiKey({ TYPESAFE_API_KEY: " env-key " }, () => {
      throw new Error("keychain should not be read");
    })).toEqual({ apiKey: "env-key" });
  });

  it("treats an empty TYPESAFE_API_KEY as local search", () => {
    expect(resolveTypeSafeApiKey({ TYPESAFE_API_KEY: "" }, () => "stored-key")).toEqual({ apiKey: "" });
  });

  it("reads the keychain when the env var is unset", () => {
    expect(resolveTypeSafeApiKey({}, () => " stored-key ")).toEqual({ apiKey: "stored-key" });
    expect(resolveTypeSafeApiKey({}, () => null)).toEqual({ apiKey: "" });
  });

  it("stays local when the keychain cannot be read", () => {
    const resolved = resolveTypeSafeApiKey({}, () => {
      throw new Error("locked");
    });
    expect(resolved.apiKey).toBe("");
    expect(resolved.warning).toContain("locked");
  });
});

describe("ensureTypeSafeKey", () => {
  it("keeps a saved key when stdin is not a terminal", async () => {
    const store = memoryStore("already");
    const status = await ensureTypeSafeKey({
      store,
      interactive: false,
      prompt: () => Promise.reject(new Error("should not prompt")),
      log: () => undefined,
    });
    expect(status).toBe("present");
    expect(store.saved).toBe("already");
  });

  it("replaces a saved key when a new one is entered", async () => {
    const store = memoryStore("already");
    const status = await ensureTypeSafeKey({
      store,
      interactive: true,
      prompt: () => Promise.resolve("  next-key  "),
      log: () => undefined,
    });
    expect(status).toBe("saved");
    expect(store.saved).toBe("next-key");
  });

  it("keeps a saved key when the replace prompt is empty", async () => {
    const store = memoryStore("already");
    const lines: string[] = [];
    const status = await ensureTypeSafeKey({
      store,
      interactive: true,
      prompt: () => Promise.resolve("  "),
      log: (line) => lines.push(line),
    });
    expect(status).toBe("present");
    expect(store.saved).toBe("already");
    expect(lines.join("\n")).toContain("Kept the saved TypeSafe key.");
  });

  it("saves a prompted key", async () => {
    const store = memoryStore();
    const status = await ensureTypeSafeKey({
      store,
      interactive: true,
      prompt: () => Promise.resolve("  secret-key  "),
      log: () => undefined,
    });
    expect(status).toBe("saved");
    expect(store.saved).toBe("secret-key");
  });

  it("skips an empty prompt without writing", async () => {
    const store = memoryStore();
    const status = await ensureTypeSafeKey({
      store,
      interactive: true,
      prompt: () => Promise.resolve("   "),
      log: () => undefined,
    });
    expect(status).toBe("skipped");
    expect(store.saved).toBeNull();
  });

  it("does not prompt when stdin is not a terminal", async () => {
    const store = memoryStore();
    const status = await ensureTypeSafeKey({
      store,
      interactive: false,
      prompt: () => Promise.reject(new Error("should not prompt")),
      log: () => undefined,
    });
    expect(status).toBe("skipped");
    expect(store.saved).toBeNull();
  });

  it("continues when the keychain cannot be saved", async () => {
    const store: SecretStore = {
      get: () => null,
      set: () => {
        throw new Error("denied");
      },
    };
    const lines: string[] = [];
    const status = await ensureTypeSafeKey({
      store,
      interactive: true,
      prompt: () => Promise.resolve("secret-key"),
      log: (line) => lines.push(line),
    });
    expect(status).toBe("skipped");
    expect(lines.join("\n")).toContain("denied");
  });

  it("keeps the saved key when replace fails", async () => {
    const store: SecretStore = {
      get: () => "already",
      set: () => {
        throw new Error("denied");
      },
    };
    const lines: string[] = [];
    const status = await ensureTypeSafeKey({
      store,
      interactive: true,
      prompt: () => Promise.resolve("next-key"),
      log: (line) => lines.push(line),
    });
    expect(status).toBe("present");
    expect(lines.join("\n")).toContain("unchanged");
  });
});
