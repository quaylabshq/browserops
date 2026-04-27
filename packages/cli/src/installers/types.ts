export type ClientId = "claude-code" | "cursor" | "zed" | "continue" | "windsurf" | "codex";

export interface ClientInfo {
  id: ClientId;
  label: string;
  detected: boolean;
  configPath: string;
  alreadyInstalled: boolean;
}

export interface InstallSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ClientInstaller {
  id: ClientId;
  label: string;
  detect(): Promise<ClientInfo>;
  install(spec: InstallSpec, opts?: { dryRun?: boolean }): Promise<InstallResult>;
  uninstall(opts?: { dryRun?: boolean }): Promise<InstallResult>;
}

export interface InstallResult {
  changed: boolean;
  configPath: string;
  backupPath?: string;
  message: string;
}
