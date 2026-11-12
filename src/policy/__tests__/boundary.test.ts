import { describe, expect, it } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const policyDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = readdirSync(policyDir)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => ({
    name,
    text: readFileSync(join(policyDir, name), "utf8"),
  }));

/** The only package the primitive may load. It performs no I/O. */
const ALLOWED_PACKAGES = new Set(["minimatch"]);
const IMPORT =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

describe("policy import boundary", () => {
  it("has source files to check", () => {
    expect(sources.map((source) => source.name).sort()).toEqual(
      expect.arrayContaining(["engine.ts", "index.ts", "rules.ts", "store.ts"]),
    );
  });

  it.each(sources)(
    "$name imports only its own module and allowed packages",
    ({ text }) => {
      const specifiers = [...text.matchAll(IMPORT)].map((match) => match[1]);
      for (const specifier of specifiers) {
        if (specifier.startsWith("./")) {
          // Stays inside src/policy: no parent directory, no subdirectory.
          expect(specifier).toMatch(/^\.\/[A-Za-z]+\.js$/);
        } else {
          expect(ALLOWED_PACKAGES.has(specifier)).toBe(true);
        }
      }
    },
  );

  it.each(sources)(
    "$name does not reach for the process, filesystem, network, or clock",
    ({ text }) => {
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      for (const forbidden of [
        /\bprocess\s*[.[]/,
        /\bglobalThis\b/,
        /\brequire\s*\(/,
        /\bfetch\s*\(/,
        /\bDate\b/,
        /\bMath\.random\b/,
        /\bsetTimeout\b|\bsetInterval\b/,
        /["']node:/,
      ]) {
        expect(code).not.toMatch(forbidden);
      }
    },
  );

  it("declares no mutable module-level state", () => {
    for (const { text } of sources) {
      expect(text).not.toMatch(/^(?:export\s+)?let\s/m);
      expect(text).not.toMatch(/^(?:export\s+)?var\s/m);
    }
  });
});
