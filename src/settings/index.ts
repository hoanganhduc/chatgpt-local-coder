/**
 * Live settings import.
 *
 * `loadSettings()` runs at startup; `refreshSettings()` re-reads on demand
 * through the `settings_status` tool and `chatgpt-local-coder settings refresh`.
 * There is no watcher on purpose: an explicit refresh makes behaviour
 * reproducible, and a watcher that silently stops working would leave the host
 * quietly running against stale rules.
 *
 * Source files are only ever read. Nothing in this module writes to
 * `~/.claude`, `~/.codex`, `~/.grok`, or an OpenCode config.
 */

import os from "os";
import { loadClaudeSettings } from "./claude.js";
import { loadCodexSettings } from "./codex.js";
import { loadGrokSettings } from "./grok.js";
import { loadOpenCodeSettings } from "./opencode.js";
import { evaluateRules, mergeSettings, SOURCE_PRECEDENCE } from "./merge.js";
import {
  emptySourceSettings,
  type AdapterContext,
  type NormalizedSettings,
  type SettingsSourceId,
  type SourceSettings,
} from "./types.js";

export * from "./types.js";
export { mergeSettings, evaluateRules, parseRule, SOURCE_PRECEDENCE } from "./merge.js";
export { parseMinimalToml } from "./codex.js";

const ADAPTERS: Record<SettingsSourceId, (ctx: AdapterContext) => Promise<SourceSettings>> = {
  claude: loadClaudeSettings,
  codex: loadCodexSettings,
  grok: loadGrokSettings,
  opencode: loadOpenCodeSettings,
};

export interface LoadSettingsOptions {
  workspaceRoots: string[];
  /** Which sources to import; defaults to all, in precedence order. */
  sources?: SettingsSourceId[];
  /** Set false to skip import entirely and return an empty result. */
  enabled?: boolean;
  host?: { model?: string; skillRoots?: string[] };
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

let cached: NormalizedSettings | null = null;
let cachedOptions: LoadSettingsOptions | null = null;

function emptySettings(): NormalizedSettings {
  return {
    sources: [],
    permissions: { allow: [], deny: [], ask: [] },
    mcpServers: {},
    hooks: {},
    agents: {},
    skillRoots: [],
    conflicts: [],
  };
}

export async function loadSettings(opts: LoadSettingsOptions): Promise<NormalizedSettings> {
  cachedOptions = opts;

  if (opts.enabled === false) {
    cached = emptySettings();
    return cached;
  }

  const ctx: AdapterContext = {
    homeDir: opts.homeDir ?? os.homedir(),
    workspaceRoots: opts.workspaceRoots,
    env: opts.env ?? process.env,
  };

  const wanted = opts.sources ?? SOURCE_PRECEDENCE;
  const results: SourceSettings[] = [];

  for (const id of wanted) {
    const adapter = ADAPTERS[id];
    if (!adapter) continue;
    try {
      results.push(await adapter(ctx));
    } catch (error) {
      // An adapter that throws is a bug, but it must not stop the host from
      // starting — record it as a failed source and carry on.
      const failed = emptySourceSettings(id);
      failed.statuses.push({
        id,
        path: `<${id} adapter>`,
        loadedAt: new Date().toISOString(),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      results.push(failed);
    }
  }

  cached = mergeSettings(results, { host: opts.host });
  return cached;
}

export function getSettings(): NormalizedSettings {
  return cached ?? emptySettings();
}

export function isSettingsLoaded(): boolean {
  return cached !== null;
}

export async function refreshSettings(): Promise<NormalizedSettings> {
  if (!cachedOptions) return getSettings();
  return loadSettings(cachedOptions);
}

/** Test seam: drop the cache so a fresh process state can be simulated. */
export function resetSettings(): void {
  cached = null;
  cachedOptions = null;
}

/**
 * Evaluate the loaded rules against one tool invocation. Returns null when no
 * imported rule has anything to say — the host profile then decides on its own.
 */
export function checkImportedRules(tool: string, argument: string) {
  return evaluateRules(getSettings().permissions, tool, argument);
}
