import { describe, expect, it } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { FeatureName } from "@browserops/shared";
import { createPromptRegistry } from "./prompts.js";

const set = (...names: FeatureName[]) => new Set<FeatureName>(names) as ReadonlySet<FeatureName>;

describe("createPromptRegistry — listPrompts", () => {
  it("lists both browserops and browserops_procedure when procedures is enabled", () => {
    const reg = createPromptRegistry(set("procedures"));
    const names = reg
      .listPrompts()
      .prompts.map((p) => p.name)
      .sort();
    expect(names).toEqual(["browserops", "browserops_procedure"]);
  });

  it("hides browserops_procedure when procedures is disabled", () => {
    const reg = createPromptRegistry(set());
    const names = reg.listPrompts().prompts.map((p) => p.name);
    expect(names).toEqual(["browserops"]);
  });

  it("lore feature does not affect prompt visibility", () => {
    const reg = createPromptRegistry(set("lore"));
    const names = reg.listPrompts().prompts.map((p) => p.name);
    expect(names).toEqual(["browserops"]);
  });
});

describe("createPromptRegistry — getPrompt feature gating", () => {
  it("rejects browserops_procedure with a feature-enable hint when procedures is off", async () => {
    const reg = createPromptRegistry(set());
    await expect(
      reg.getPrompt("browserops_procedure", { name: "gmail.send_email" }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof McpError &&
        /requires the 'procedures' feature/.test(err.message) &&
        /browserops feature enable procedures/.test(err.message),
    );
  });

  it("rejects unknown prompt names regardless of feature state", async () => {
    const reg = createPromptRegistry(set("procedures", "lore"));
    await expect(reg.getPrompt("nope", {})).rejects.toSatisfy(
      (err: unknown) => err instanceof McpError && /unknown prompt: nope/.test(err.message),
    );
  });

  it("requires task argument for the browserops prompt", async () => {
    const reg = createPromptRegistry(set());
    await expect(reg.getPrompt("browserops", {})).rejects.toSatisfy(
      (err: unknown) => err instanceof McpError && /task argument required/.test(err.message),
    );
  });
});
