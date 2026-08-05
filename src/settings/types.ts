/**
 * The normalized shape every settings source is projected onto.
 *
 * Sources are read, never written. A user's `~/.claude/settings.json` belongs to
 * Claude Code; this host borrows from it and must leave it exactly as found.
 */

export type SettingsSourceId = "claude" | "codex" | "grok" | "opencode";

export interface SettingsSourceStatus {
  id: SettingsSourceId;
  path: string;
  loadedAt: string;
  ok: boolean;
  error?: string;
}

export interface HookAction {
  type: string;
  command: string;
  timeoutSec?: number;
}

export interface HookMatcher {
  /** Tool-name pattern the hook applies to; absent means "every tool". */
  matcher?: string;
  hooks: HookAction[];
}

export interface McpServerSpec {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface AgentSpec {
  description?: string;
  model?: string;
  tools?: string[];
  /** Absolute path to the file the agent was defined in. */
  path?: string;
}

export interface PermissionRules {
  allow: string[];
  deny: string[];
  ask: string[];
}

export interface SettingsConflict {
  key: string;
  winner: SettingsSourceId | "host";
  losers: Array<SettingsSourceId | "host">;
}

export interface NormalizedSettings {
  sources: SettingsSourceStatus[];
  permissions: PermissionRules;
  mcpServers: Record<string, McpServerSpec>;
  hooks: Record<string, HookMatcher[]>;
  model?: string;
  agents: Record<string, AgentSpec>;
  skillRoots: string[];
  conflicts: SettingsConflict[];
}

/** What a single adapter produces before merging. */
export interface SourceSettings {
  id: SettingsSourceId;
  statuses: SettingsSourceStatus[];
  permissions: PermissionRules;
  mcpServers: Record<string, McpServerSpec>;
  hooks: Record<string, HookMatcher[]>;
  model?: string;
  agents: Record<string, AgentSpec>;
  skillRoots: string[];
}

export function emptySourceSettings(id: SettingsSourceId): SourceSettings {
  return {
    id,
    statuses: [],
    permissions: { allow: [], deny: [], ask: [] },
    mcpServers: {},
    hooks: {},
    agents: {},
    skillRoots: [],
  };
}

export interface AdapterContext {
  homeDir: string;
  workspaceRoots: string[];
  env: NodeJS.ProcessEnv;
}
