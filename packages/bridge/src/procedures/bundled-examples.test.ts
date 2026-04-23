import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { validateProcedure } from "./validator.js";
import { validateBindings } from "./binding-validator.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.resolve(here, "..", "..", "..", "..", "examples", "procedures");

function listExamples(): string[] {
  return fs
    .readdirSync(examplesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(examplesDir, e.name, "procedure.yaml"))
    .filter((p) => fs.existsSync(p));
}

describe("bundled examples pass schema + binding validation", () => {
  for (const yamlPath of listExamples()) {
    const name = path.basename(path.dirname(yamlPath));
    it(name, () => {
      const text = fs.readFileSync(yamlPath, "utf8");
      const parsed = YAML.parse(text);
      const schemaResult = validateProcedure(parsed);
      expect(schemaResult.valid, `schema: ${(schemaResult.errors ?? []).join("; ")}`).toBe(true);
      const bindingResult = validateBindings(parsed);
      expect(
        bindingResult.valid,
        `binding: ${(bindingResult.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join("; ")}`,
      ).toBe(true);
    });
  }
});
