import { c, dim, err, info, ok } from "../lib/ui.js";
import {
  getIdentityEmail,
  isValidEmail,
  setIdentityEmail,
} from "../lib/config.js";
import { getCliTelemetry } from "../lib/telemetry.js";

export interface IdentifyOpts {
  email?: string;
  clear?: boolean;
}

export async function runIdentify(opts: IdentifyOpts = {}): Promise<void> {
  if (opts.clear) {
    await runClear();
    return;
  }
  if (opts.email !== undefined) {
    await runSet(opts.email);
    return;
  }
  await runShow();
}

async function runShow(): Promise<void> {
  const email = await getIdentityEmail();
  if (!email) {
    info(`no identity set. Set with: ${c.cyan("browserops identify --email <you@example.com>")}`);
    return;
  }
  process.stdout.write(`identified as: ${email}\n`);
  process.stdout.write(`${dim(`clear with: browserops identify --clear`)}\n`);
}

async function runSet(email: string): Promise<void> {
  const trimmed = email.trim();
  if (!isValidEmail(trimmed)) {
    err(`invalid email: ${trimmed}`);
    process.exit(1);
  }
  await setIdentityEmail(trimmed);
  ok(`identified as ${trimmed}`);
  const t = getCliTelemetry();
  if (t) {
    t.identify({ email: trimmed, identified_via: "cli", identified_at: new Date().toISOString() });
    t.alias(trimmed);
    t.capture("cli.identify_set", { via: "cli" });
  }
}

async function runClear(): Promise<void> {
  const had = await getIdentityEmail();
  await setIdentityEmail(undefined);
  if (!had) {
    info("no identity was set");
    return;
  }
  ok("identity cleared");
  const t = getCliTelemetry();
  if (t) {
    // $unset removes the property server-side.
    t.identify({}, {}, ["email", "identified_via", "identified_at"]);
    t.capture("cli.identify_cleared", {});
  }
}
