import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("scripts/check-docs-mdx", () => {
  it("rejects Thai navigation until Mintlify documents support for th", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "openclaw-docs-mdx-"));
    writeFileSync(
      join(rootDir, "docs.json"),
      `${JSON.stringify({
        navigation: {
          languages: [{ language: "en" }, { language: "th" }],
        },
      })}\n`,
    );

    try {
      expect(() =>
        execFileSync(process.execPath, ["scripts/check-docs-mdx.mjs", rootDir], {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: "pipe",
        }),
      ).toThrow(/Unsupported Mintlify navigation language: th/u);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
