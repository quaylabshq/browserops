/**
 * Thin wrapper around PostHogHttpClient.capture that runs every event
 * through the redact() allowlist. All call-sites in the bridge / CLI
 * should go through this rather than calling client.capture directly,
 * so the allowlist is the only place property names enter the wire.
 */
import type { PostHogHttpClient } from "./posthog-http.js";
import { redact } from "./redact.js";

export interface CommonProps {
  bridge_version?: string;
  cli_version?: string;
  os_platform?: NodeJS.Platform;
  os_arch?: string;
  node_major?: number;
}

export function captureEvent(
  client: PostHogHttpClient | null | undefined,
  event: string,
  props: Record<string, unknown> = {},
  common: CommonProps = {},
): void {
  if (!client?.enabled) return;
  client.capture(event, redact(event, { ...common, ...props }));
}

export function buildCommonProps(opts: {
  bridgeVersion?: string;
  cliVersion?: string;
}): CommonProps {
  const out: CommonProps = {
    os_platform: process.platform,
    os_arch: process.arch,
    node_major: Number(process.versions.node.split(".")[0] ?? 0),
  };
  if (opts.bridgeVersion) out.bridge_version = opts.bridgeVersion;
  if (opts.cliVersion) out.cli_version = opts.cliVersion;
  return out;
}
