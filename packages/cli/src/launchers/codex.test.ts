import { describe, expect, it } from "vitest";
import { supportsFullAuto } from "./codex.js";

describe("supportsFullAuto", () => {
  it("returns true when codex exec --help includes --full-auto", () => {
    const mockSpawner = () => ({
      stdout:
        "Usage: codex exec [OPTIONS]\n\nOptions:\n  --full-auto  Skip interactive approval prompts\n",
      stderr: "",
    });

    expect(supportsFullAuto("codex", mockSpawner as any)).toBe(true);
  });

  it("returns false when codex exec --help does not include --full-auto (older version)", () => {
    const mockSpawner = () => ({
      stdout: "Usage: codex exec [OPTIONS] [PROMPT]\n\nOptions:\n  --help  Print help\n",
      stderr: "",
    });

    expect(supportsFullAuto("codex", mockSpawner as any)).toBe(false);
  });

  it("returns false when spawnSync throws an error", () => {
    const mockSpawner = () => {
      throw new Error("spawn failed");
    };

    expect(supportsFullAuto("codex", mockSpawner as any)).toBe(false);
  });
});
