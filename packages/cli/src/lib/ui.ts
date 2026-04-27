import pc from "picocolors";

export const c = pc;

export function ok(msg: string): void {
  process.stdout.write(`${pc.green("✓")} ${msg}\n`);
}

export function info(msg: string): void {
  process.stdout.write(`${pc.dim("·")} ${msg}\n`);
}

export function warn(msg: string): void {
  process.stderr.write(`${pc.yellow("!")} ${msg}\n`);
}

export function err(msg: string): void {
  process.stderr.write(`${pc.red("✗")} ${msg}\n`);
}

export function header(msg: string): void {
  process.stdout.write(`\n${pc.bold(msg)}\n`);
}

export function dim(s: string): string {
  return pc.dim(s);
}
