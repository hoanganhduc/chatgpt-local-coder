import { z } from "zod";

export const permissionProfileSchema = z.enum(["workspace", "open", "readonly"]);
export type PermissionProfileName = z.infer<typeof permissionProfileSchema>;

export const settingsSourceSchema = z.enum(["claude", "codex", "grok", "opencode"]);
export type SettingsSourceId = z.infer<typeof settingsSourceSchema>;

const skillsSchema = z.object({
  roots: z.array(z.string()).default([]),
  enabled: z.array(z.string()).default([]),
  disabled: z.array(z.string()).default([]),
  allowExecution: z.boolean().default(true),
  maxRuntimeSec: z.number().int().positive().default(300),
});

const settingsSchema = z.object({
  import: z.boolean().default(true),
  sources: z.array(settingsSourceSchema).default(["codex", "grok", "opencode", "claude"]),
});

const delegatesSchema = z.object({
  enabled: z.boolean().default(true),
  order: z.array(z.string()).default(["claude", "codex", "opencode", "grok"]),
  timeoutSec: z.number().int().positive().default(300),
});

const hooksSchema = z.object({
  enabled: z.boolean().default(true),
});

const tunnelSchema = z.object({
  alias: z.string().default("chatgpt-local-coder"),
  profileDir: z.string().optional(),
  binPath: z.string().optional(),
});

const baseShape = {
  workspaceRoots: z.array(z.string()).default([]),
  permissionProfile: permissionProfileSchema.default("workspace"),
  bindHost: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(3000),
  adminPort: z.number().int().positive().default(3001),
  shellTimeoutSec: z.number().int().positive().default(120),
  toolProfile: z.enum(["slim", "full"]).default("slim"),
};

export const hostConfigSchema = z.object({
  ...baseShape,
  skills: skillsSchema.default({}),
  settings: settingsSchema.default({}),
  delegates: delegatesSchema.default({}),
  hooks: hooksSchema.default({}),
  tunnel: tunnelSchema.default({}),
});

export type HostConfig = z.infer<typeof hostConfigSchema>;

/**
 * Partial config as it appears in a single layer — every key optional, at every
 * depth. Built explicitly rather than with `deepPartial()`, which does not
 * recurse through the `.default()` wrappers above and so would still demand the
 * inner keys of every nested object.
 */
export const partialHostConfigSchema = z
  .object({
    ...baseShape,
    skills: skillsSchema.partial(),
    settings: settingsSchema.partial(),
    delegates: delegatesSchema.partial(),
    hooks: hooksSchema.partial(),
    tunnel: tunnelSchema.partial(),
  })
  .partial();

export type PartialHostConfig = z.infer<typeof partialHostConfigSchema>;
