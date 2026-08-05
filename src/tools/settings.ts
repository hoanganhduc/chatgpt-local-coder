import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { describePermissionProfile, getPermissionProfile } from "../lib/permissions.js";
import { getSettings, refreshSettings } from "../settings/index.js";

const IMPORT_SEMANTICS = [
  "deny: enforced — an imported deny rule blocks the call regardless of permission profile.",
  "allow: advisory — an imported allow never widens this host's profile; it cannot grant a write outside the workspace roots.",
  "ask: reported only — this host has no interactive prompt mid-call, so an ask rule is not enforced. Treat listed entries as things to confirm with the user yourself.",
];

export function registerSettingsTools(server: McpServer): void {
  server.registerTool(
    "settings_status",
    {
      title: "Settings Status",
      description:
        "Report settings imported from Claude Code, Codex, Grok, and OpenCode: which files loaded, merged permissions, MCP servers, hooks, agents, and which source won each conflict. Source files are read, never written.",
      inputSchema: {
        refresh: z.boolean().optional().describe("Re-read every source file before reporting"),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ refresh }) => {
      const settings = refresh ? await refreshSettings() : getSettings();

      return toolResult(
        "settings_status",
        {
          sources: settings.sources,
          failed_sources: settings.sources.filter((s) => !s.ok),
          permissions: settings.permissions,
          import_semantics: IMPORT_SEMANTICS,
          host_permission_profile: getPermissionProfile(),
          host_permission_description: describePermissionProfile(),
          mcp_servers: settings.mcpServers,
          hooks: settings.hooks,
          model: settings.model ?? null,
          agents: settings.agents,
          skill_roots: settings.skillRoots,
          conflicts: settings.conflicts,
        },
        {
          summary: `settings_status: ${settings.sources.filter((s) => s.ok).length} source file(s) loaded, ${settings.permissions.deny.length} deny rule(s) enforced`,
        }
      );
    }
  );
}
