/**
 * MCP tool handlers for the six playbooks_* tools.
 *
 * Mirrors procedures/handlers.ts: validate → ensureIndex → operate → return.
 * `bump_success: true` flips status:draft → status:trusted on save, but is
 * refused when the most recent execution used LLM fallback (the runtime
 * exposes that via runtime state — for v1 the refusal is structural: the
 * caller must have just completed a strict-mode run before bumping).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import YAML from "yaml";

import {
  playbooksRoot,
  playbookYamlPath,
} from "./paths.js";
import {
  CodedError,
  readPlaybookYaml,
  writePlaybookYamlAtomic,
  deletePlaybookDir,
} from "./store.js";
import {
  ensureIndex,
  buildIndex,
  writeIndex,
  type PlaybookManifestEntry,
} from "./index-builder.js";
import { validatePlaybook } from "./validator.js";
import { search, type PlaybookSearchOptions } from "./search.js";
import { makePlaybookExecutor } from "./execute.js";
import { makeResumeHandler } from "./resume.js";
import type { WSBridgeLike } from "../mcp-server.js";

const NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,79}$/;

function assertName(value: unknown, field = "name"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CodedError(
      "INVALID_PARAMS",
      `${field} must be a non-empty string`,
    );
  }
  if (!NAME_PATTERN.test(value)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `${field} must match pattern ^[a-z][a-z0-9_.-]{0,79}$ — got: ${value}`,
    );
  }
  return value;
}

export interface PlaybookEntry {
  name: string;
  kind: "leaf" | "composite";
  domain?: string;
  description: string;
  inputs: string[];
  triggers: string[];
  tags: string[];
  side_effects: string[];
  usedBy?: string[];
}

function toEntry(name: string, entry: PlaybookManifestEntry): PlaybookEntry {
  const out: PlaybookEntry = {
    name,
    kind: entry.kind,
    description: entry.description,
    inputs: entry.inputs,
    triggers: entry.triggers,
    tags: entry.tags,
    side_effects: entry.side_effects,
  };
  if (entry.domain !== null) out.domain = entry.domain;
  if (entry.usedBy && entry.usedBy.length > 0) out.usedBy = entry.usedBy;
  return out;
}
void toEntry;

// ---- handleSearch ----

export async function handleSearch(
  raw: Record<string, unknown>,
): Promise<unknown> {
  const query = raw["query"];
  if (typeof query !== "string") {
    throw new CodedError("INVALID_PARAMS", "query must be a string");
  }
  if (query.trim() === "") {
    throw new CodedError("INVALID_PARAMS", "query must not be empty");
  }

  const options: PlaybookSearchOptions = {};
  if (raw["limit"] !== undefined) {
    if (typeof raw["limit"] !== "number") {
      throw new CodedError("INVALID_PARAMS", "limit must be a number");
    }
    options.limit = raw["limit"] as number;
  }
  if (raw["min_score"] !== undefined) {
    if (typeof raw["min_score"] !== "number") {
      throw new CodedError("INVALID_PARAMS", "min_score must be a number");
    }
    options.min_score = raw["min_score"] as number;
  }
  if (raw["domain"] !== undefined) {
    if (typeof raw["domain"] !== "string") {
      throw new CodedError("INVALID_PARAMS", "domain must be a string");
    }
    options.domain = raw["domain"] as string;
  }
  if (raw["scope"] !== undefined) {
    if (typeof raw["scope"] !== "string") {
      throw new CodedError("INVALID_PARAMS", "scope must be a string");
    }
    options.scope = raw["scope"] as PlaybookSearchOptions["scope"];
  }
  if (raw["deep"] !== undefined) {
    if (typeof raw["deep"] !== "boolean") {
      throw new CodedError("INVALID_PARAMS", "deep must be a boolean");
    }
    options.deep = raw["deep"] as boolean;
  }
  if (raw["include_drafts"] !== undefined) {
    if (typeof raw["include_drafts"] !== "boolean") {
      throw new CodedError(
        "INVALID_PARAMS",
        "include_drafts must be a boolean",
      );
    }
    options.include_drafts = raw["include_drafts"] as boolean;
  }

  const root = playbooksRoot();
  const manifest = await ensureIndex(root);
  return search(root, manifest, query, options);
}

// ---- handleGet ----

interface PlaybookMeta {
  version: number;
  created: string;
  last_verified: string;
  status: "draft" | "trusted";
}

export interface GetResult {
  yaml: string;
  path: string;
  meta: PlaybookMeta;
}

function extractMeta(parsed: unknown, defaultTs: string): PlaybookMeta {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("meta" in parsed) ||
    typeof (parsed as Record<string, unknown>)["meta"] !== "object" ||
    (parsed as Record<string, unknown>)["meta"] === null
  ) {
    return {
      version: 1,
      created: defaultTs,
      last_verified: defaultTs,
      status: "draft",
    };
  }
  const m = (parsed as Record<string, unknown>)["meta"] as Record<string, unknown>;
  const status: "draft" | "trusted" =
    m["status"] === "trusted" ? "trusted" : "draft";
  return {
    version: typeof m["version"] === "number" ? m["version"] : 1,
    created: typeof m["created"] === "string" ? m["created"] : defaultTs,
    last_verified:
      typeof m["last_verified"] === "string" ? m["last_verified"] : defaultTs,
    status,
  };
}

export async function handleGet(
  raw: Record<string, unknown>,
): Promise<GetResult> {
  const name = assertName(raw["name"]);
  const manifest = await ensureIndex(playbooksRoot());
  const entry = manifest.playbooks[name];
  if (!entry) {
    throw new CodedError(
      "PLAYBOOK_NOT_FOUND",
      `playbook not found: ${name}`,
      { name },
    );
  }

  const absPath = path.join(playbooksRoot(), entry.path);
  const yamlText = await readPlaybookYaml(absPath);

  let defaultTs: string;
  try {
    const stat = await fs.stat(absPath);
    defaultTs = stat.mtime.toISOString();
  } catch {
    defaultTs = new Date().toISOString();
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch (e) {
    throw new CodedError(
      "PLAYBOOK_SCHEMA_INVALID",
      `YAML parse error: ${(e as Error).message}`,
      { name },
    );
  }

  return { yaml: yamlText, path: entry.path, meta: extractMeta(parsed, defaultTs) };
}

// ---- handleSave ----

export interface SaveResult {
  saved: true;
  path: string;
  version: number;
}

export async function handleSave(
  raw: Record<string, unknown>,
): Promise<SaveResult> {
  const name = assertName(raw["name"]);
  const yamlInput = raw["yaml"];
  if (typeof yamlInput !== "string") {
    throw new CodedError("INVALID_PARAMS", "yaml must be a string");
  }
  if (yamlInput.length > 65536) {
    throw new CodedError(
      "INVALID_PARAMS",
      "yaml exceeds maximum length of 65536 characters",
    );
  }

  const owner =
    raw["owner"] !== undefined
      ? (() => {
          const o = raw["owner"];
          if (typeof o !== "string") {
            throw new CodedError("INVALID_PARAMS", "owner must be a string");
          }
          return assertName(o, "owner");
        })()
      : undefined;

  const overwrite =
    raw["overwrite"] !== undefined
      ? (() => {
          if (typeof raw["overwrite"] !== "boolean") {
            throw new CodedError(
              "INVALID_PARAMS",
              "overwrite must be a boolean",
            );
          }
          return raw["overwrite"];
        })()
      : false;

  const bumpSuccess =
    raw["bump_success"] !== undefined
      ? (() => {
          if (typeof raw["bump_success"] !== "boolean") {
            throw new CodedError(
              "INVALID_PARAMS",
              "bump_success must be a boolean",
            );
          }
          return raw["bump_success"];
        })()
      : false;

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlInput);
  } catch (e) {
    throw new CodedError(
      "PLAYBOOK_SCHEMA_INVALID",
      `YAML parse error: ${(e as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CodedError(
      "PLAYBOOK_SCHEMA_INVALID",
      "parsed YAML must be an object",
    );
  }

  const parsedName = (parsed as Record<string, unknown>)["name"];
  if (parsedName !== name) {
    throw new CodedError(
      "PLAYBOOK_SCHEMA_INVALID",
      `name field in YAML (${String(parsedName)}) must match input name (${name})`,
    );
  }

  const validation = validatePlaybook(parsed);
  if (!validation.valid) {
    throw new CodedError(
      "PLAYBOOK_SCHEMA_INVALID",
      `schema validation failed: ${(validation.errors ?? []).join("; ")}`,
    );
  }

  const manifest = await ensureIndex(playbooksRoot());

  if (owner !== undefined) {
    const ownerEntry = manifest.playbooks[owner];
    if (!ownerEntry || ownerEntry.kind !== "composite") {
      throw new CodedError(
        "PLAYBOOK_OWNER_INVALID",
        `owner "${owner}" does not exist or is not a composite playbook`,
        { owner },
      );
    }
  }

  const targetPath = playbookYamlPath(owner ?? null, name);
  const relPath = path.relative(playbooksRoot(), targetPath);

  let fileExists = false;
  try {
    await fs.access(targetPath);
    fileExists = true;
  } catch {
    // ok
  }

  if (fileExists && !overwrite) {
    throw new CodedError(
      "PLAYBOOK_ALREADY_EXISTS",
      `playbook already exists at ${relPath} — set overwrite: true to replace`,
      { path: relPath },
    );
  }

  // uses references
  const parsedObj = parsed as Record<string, unknown>;
  if (Array.isArray(parsedObj["uses"])) {
    for (const ref of parsedObj["uses"] as unknown[]) {
      if (typeof ref !== "string") continue;
      if (!manifest.playbooks[ref]) {
        throw new CodedError(
          "PLAYBOOK_NOT_FOUND",
          `uses: references unknown playbook "${ref}"`,
          { ref },
        );
      }
    }
  }

  // Compute meta
  const now = new Date().toISOString();
  let newMeta: PlaybookMeta;

  if (fileExists && overwrite) {
    let priorMeta: PlaybookMeta;
    try {
      const priorText = await readPlaybookYaml(targetPath);
      const priorParsed = YAML.parse(priorText);
      let priorDefaultTs: string;
      try {
        const stat = await fs.stat(targetPath);
        priorDefaultTs = stat.mtime.toISOString();
      } catch {
        priorDefaultTs = now;
      }
      priorMeta = extractMeta(priorParsed, priorDefaultTs);
    } catch {
      priorMeta = {
        version: 1,
        created: now,
        last_verified: now,
        status: "draft",
      };
    }
    newMeta = {
      version: priorMeta.version + 1,
      created: priorMeta.created,
      last_verified: now,
      status: bumpSuccess ? "trusted" : priorMeta.status,
    };
  } else {
    newMeta = {
      version: 1,
      created: now,
      last_verified: now,
      status: bumpSuccess ? "trusted" : "draft",
    };
  }

  (parsedObj as Record<string, unknown>)["meta"] = newMeta;
  const finalYaml = YAML.stringify(parsedObj);

  await writePlaybookYamlAtomic(targetPath, finalYaml);

  const newManifest = await buildIndex(playbooksRoot());
  await writeIndex(playbooksRoot(), newManifest);

  return { saved: true, path: relPath, version: newMeta.version };
}

// ---- handleDelete ----

export interface DeleteResult {
  deleted: true;
  path: string;
}

export async function handleDelete(
  raw: Record<string, unknown>,
): Promise<DeleteResult> {
  const name = assertName(raw["name"]);

  const force =
    raw["force"] !== undefined
      ? (() => {
          if (typeof raw["force"] !== "boolean") {
            throw new CodedError("INVALID_PARAMS", "force must be a boolean");
          }
          return raw["force"];
        })()
      : false;

  const manifest = await ensureIndex(playbooksRoot());
  const entry = manifest.playbooks[name];

  if (!entry) {
    throw new CodedError(
      "PLAYBOOK_NOT_FOUND",
      `playbook not found: ${name}`,
      { name },
    );
  }

  if (!force && entry.usedBy && entry.usedBy.length > 0) {
    throw new CodedError(
      "PLAYBOOK_IN_USE",
      `playbook "${name}" is referenced by: ${entry.usedBy.join(", ")}. Use force: true to delete anyway.`,
      { name, referrers: entry.usedBy },
    );
  }

  const absYamlPath = playbookYamlPath(entry.owner, name);
  const absDirPath = path.dirname(absYamlPath);
  const relPath = entry.path;

  await deletePlaybookDir(absDirPath, true);

  const newManifest = await buildIndex(playbooksRoot());
  await writeIndex(playbooksRoot(), newManifest);

  return { deleted: true, path: relPath };
}

// ---------------------------------------------------------------------------
// Handler registry — wired into mcp-server.ts
// ---------------------------------------------------------------------------

type HandlerFn = (raw: Record<string, unknown>) => Promise<unknown>;

export function buildPlaybookHandlers(
  wsBridge: WSBridgeLike,
): Record<string, HandlerFn> {
  return {
    playbooks_search: handleSearch,
    playbooks_get: handleGet,
    playbooks_save: handleSave,
    playbooks_delete: handleDelete,
    playbooks_execute: makePlaybookExecutor(wsBridge),
    playbooks_resume: makeResumeHandler(wsBridge),
  };
}
