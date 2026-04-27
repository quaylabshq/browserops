import { copyFile, rename, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";

export async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

export async function backup(path: string): Promise<string | undefined> {
  try {
    await access(path, constants.F_OK);
  } catch {
    return undefined;
  }
  const dest = `${path}.bak.${Date.now()}`;
  await copyFile(path, dest);
  return dest;
}
