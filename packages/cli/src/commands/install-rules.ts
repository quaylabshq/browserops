import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { bundledAssetsDir } from "../lib/paths.js";
import { ok, info, warn, err } from "../lib/ui.js";
import { backup } from "../lib/fs.js";

const SENTINEL_START = "<!-- browserops:rules:start -->";
const SENTINEL_END = "<!-- browserops:rules:end -->";

type TargetResult = { changed: boolean; path: string; message: string };

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// --- cursor ---
async function installCursor(
  content: string,
  cwd: string,
  dryRun: boolean,
): Promise<TargetResult> {
  const path = join(cwd, ".cursor", "rules", "browserops.mdc");
  const body = `---\nalwaysApply: true\n---\n${content}`;

  const existing = await readFileSafe(path);
  if (existing === body) {
    return { changed: false, path, message: "already up to date" };
  }

  if (dryRun) {
    return { changed: true, path, message: `would write ${path}` };
  }

  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, body);
  return { changed: true, path, message: `wrote ${path}` };
}

// --- windsurf ---
async function installWindsurf(
  content: string,
  cwd: string,
  dryRun: boolean,
): Promise<TargetResult> {
  const path = join(cwd, ".windsurfrules");
  const block = `${SENTINEL_START}\n${content}\n${SENTINEL_END}`;
  const existing = await readFileSafe(path);

  let newContent: string;
  if (existing === null) {
    newContent = `\n\n# browserops\n\n${block}\n`;
  } else if (existing.includes(SENTINEL_START)) {
    // Replace the existing block in place.
    newContent = existing.replace(
      new RegExp(`${escapeRegex(SENTINEL_START)}[\\s\\S]*?${escapeRegex(SENTINEL_END)}`),
      block,
    );
    if (newContent === existing) {
      return { changed: false, path, message: "already up to date" };
    }
  } else {
    newContent = `${existing}\n\n# browserops\n\n${block}\n`;
  }

  if (dryRun) {
    return { changed: true, path, message: `would write ${path}` };
  }

  await atomicWrite(path, newContent);
  return { changed: true, path, message: `wrote ${path}` };
}

// --- copilot ---
async function installCopilot(
  content: string,
  cwd: string,
  dryRun: boolean,
): Promise<TargetResult> {
  const path = join(cwd, ".github", "copilot-instructions.md");
  const block = `${SENTINEL_START}\n${content}\n${SENTINEL_END}`;
  const existing = await readFileSafe(path);

  let newContent: string;
  if (existing === null) {
    newContent = `${block}\n`;
  } else if (existing.includes(SENTINEL_START)) {
    newContent = existing.replace(
      new RegExp(`${escapeRegex(SENTINEL_START)}[\\s\\S]*?${escapeRegex(SENTINEL_END)}`),
      block,
    );
    if (newContent === existing) {
      return { changed: false, path, message: "already up to date" };
    }
  } else {
    newContent = `${existing}\n\n${block}\n`;
  }

  if (dryRun) {
    return { changed: true, path, message: `would write ${path}` };
  }

  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, newContent);
  return { changed: true, path, message: `wrote ${path}` };
}

// --- continue ---
async function installContinue(
  content: string,
  cwd: string,
  dryRun: boolean,
): Promise<TargetResult> {
  const path = join(cwd, ".continue", "config.json");
  const existing = await readFileSafe(path);

  let config: Record<string, unknown> = {};
  if (existing !== null) {
    try {
      config = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      warn(`continue: ${path} is not valid JSON — skipping`);
      return { changed: false, path, message: "skipped (unparseable JSON)" };
    }
  }

  if (config["customInstructions"] === content) {
    return { changed: false, path, message: "already up to date" };
  }

  config["customInstructions"] = content;
  const newContent = JSON.stringify(config, null, 2) + "\n";

  if (dryRun) {
    return { changed: true, path, message: `would write ${path}` };
  }

  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) {
    await backup(path);
  }
  await atomicWrite(path, newContent);
  return { changed: true, path, message: `wrote ${path}` };
}

// --- zed (no-op: manual only) ---
async function installZed(
  _content: string,
  _cwd: string,
  _dryRun: boolean,
): Promise<TargetResult> {
  info("Zed: paste AGENTS.md into Settings → Assistant → System prompt manually");
  return { changed: false, path: "", message: "manual step required" };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ALL_TARGETS = ["cursor", "windsurf", "copilot", "continue", "zed"] as const;
type TargetName = (typeof ALL_TARGETS)[number];

const INSTALLERS: Record<
  TargetName,
  (content: string, cwd: string, dryRun: boolean) => Promise<TargetResult>
> = {
  cursor: installCursor,
  windsurf: installWindsurf,
  copilot: installCopilot,
  continue: installContinue,
  zed: installZed,
};

export async function runInstallRules(opts: {
  client?: string;
  dryRun?: boolean;
}): Promise<void> {
  const dryRun = opts.dryRun ?? false;
  const cwd = process.cwd();

  const assetsDir = bundledAssetsDir();
  const agentsPath = join(assetsDir, "AGENTS.md");
  let content: string;
  try {
    content = await readFile(agentsPath, "utf8");
  } catch {
    err("AGENTS.md not bundled — reinstall browserops");
    process.exit(1);
  }

  const requested: TargetName[] = opts.client
    ? (opts.client
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is TargetName => (ALL_TARGETS as readonly string[]).includes(s)))
    : [...ALL_TARGETS];

  let installed = 0;

  for (const name of requested) {
    const run = INSTALLERS[name];
    const result = await run(content, cwd, dryRun);

    if (result.changed) {
      ok(`${name}: ${result.message}`);
      installed++;
    } else {
      info(`${name}: ${result.message}`);
    }
  }

  const verb = dryRun ? "would install" : "installed";
  info(`${verb} ${installed} rules slot${installed === 1 ? "" : "s"}`);
}
