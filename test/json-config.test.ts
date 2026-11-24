import { describe, expect, it } from "vitest";
import { parseJsonObject, parseJsoncObject, stripJsonc } from "../src/json-config.js";

describe("stripJsonc", () => {
  it("drops comments and trailing commas but leaves strings alone", () => {
    const text = '{\n  // line\n  "url": "http://x//y", /* block */ "s": "a, }\\" // b",\n  "list": [1, 2,],\n}\n';
    expect(JSON.parse(stripJsonc(text))).toEqual({ url: "http://x//y", s: 'a, }" // b', list: [1, 2] });
  });

  it("returns plain JSON unchanged", () => {
    const text = '{ "a": [1, 2], "b": "//, }" }';
    expect(stripJsonc(text)).toBe(text);
  });
});

describe("parseJsoncObject", () => {
  it("reads JSONC and keeps the strict error for text that is not JSONC either", () => {
    expect(parseJsoncObject('{ "a": 1, // c\n }', "Config")).toEqual({ a: 1 });
    expect(() => parseJsoncObject("{ // c\n", "Config")).toThrow("Config is invalid JSON");
    expect(() => parseJsoncObject("[1] // c", "Config")).toThrow("Config must be a JSON object");
  });

  it("parseJsonObject stays strict", () => {
    expect(() => parseJsonObject('{ "a": 1, }', "Config")).toThrow("Config is invalid JSON");
  });
});
