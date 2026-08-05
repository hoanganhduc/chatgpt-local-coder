/**
 * `init` — write `<configDir>/config.json`.
 *
 * Non-interactive by default so it can run unattended in an installer or CI;
 * `--interactive` opts into prompts. Flags always win over prompts, and an
 * existing config is merged rather than replaced unless `--force` is given.
 */

import fs from "fs/promises";
import path from "path";
import readline from "readline/promises";

import { loadConfig, writeUserConfig } from "../../config/load.js";
import { configFilePath } from "../../config/paths.js";
import { permissionProfileSchema, type PartialHostConfig } from "../../config/schema.js";
import { flag, integer, optionalString, parseCommand, stringList, UsageError, type CommandSpec } from "../args.js";

export const INIT_SPEC: CommandSpec = {
  name: "init",
  summary: "Write the host configuration file.",
  options: {
    workspace: {
      type: "string",
      multiple: true,
      description: "Workspace root the host may write in. Repeatable.",
      placeholder: "path",
    },
    profile: {
      type: "string",
      description: "Permission profile: workspace, open, or readonly.",
      placeholder: "name",
    },
    port: { type: "string", description: "MCP listener port.", placeholder: "n" },
    "admin-port": { type: "string", description: "Admin UI port (loopback only).", placeholder: "n" },
    "tunnel-alias": { type: "string", description: "tunnel-client runtime alias.", placeholder: "alias" },
    interactive: { type: "boolean", description: "Prompt for anything not given as a flag." },
    force: { type: "boolean", description: "Overwrite the existing config instead of merging into it." },
  },
};

async function prompt(rl: readline.Interface, question: string, fallback: string): Promise<string> {
  const answer = (await rl.question(`${question} [${fallback}]: `)).trim();
  return answer || fallback;
}

export async function runInit(argv: string[], cwd = process.cwd()): Promise<number> {
  const parsed = parseCommand(argv, INIT_SPEC);

  const values: PartialHostConfig = {};

  const workspaces = stringList(parsed.values, "workspace");
  if (workspaces.length) values.workspaceRoots = workspaces.map((p) => path.resolve(cwd, p));

  const profile = optionalString(parsed.values, "profile");
  if (profile) {
    const result = permissionProfileSchema.safeParse(profile);
    if (!result.success) throw new UsageError(`--profile expects workspace, open, or readonly, got "${profile}"`);
    values.permissionProfile = result.data;
  }

  const port = integer(parsed.values, "port");
  if (port !== undefined) values.port = port;

  const adminPort = integer(parsed.values, "admin-port");
  if (adminPort !== undefined) values.adminPort = adminPort;

  const alias = optionalString(parsed.values, "tunnel-alias");
  if (alias) values.tunnel = { alias };

  if (flag(parsed.values, "interactive")) {
    const current = loadConfig({ cwd }).config;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!values.workspaceRoots) {
        const answer = await prompt(rl, "Workspace root", current.workspaceRoots[0] ?? cwd);
        values.workspaceRoots = [path.resolve(cwd, answer)];
      }
      if (!values.permissionProfile) {
        const answer = await prompt(rl, "Permission profile (workspace/open/readonly)", current.permissionProfile);
        const result = permissionProfileSchema.safeParse(answer);
        if (!result.success) throw new UsageError(`"${answer}" is not a permission profile`);
        values.permissionProfile = result.data;
      }
      if (values.port === undefined) {
        values.port = Number.parseInt(await prompt(rl, "MCP port", String(current.port)), 10);
      }
      if (!values.tunnel?.alias) {
        values.tunnel = { alias: await prompt(rl, "Tunnel alias", current.tunnel.alias) };
      }
    } finally {
      rl.close();
    }
  }

  if (!values.workspaceRoots) values.workspaceRoots = [path.resolve(cwd)];

  if (flag(parsed.values, "force")) {
    await fs.rm(configFilePath(), { force: true });
  }

  const target = writeUserConfig(values);
  const { config } = loadConfig({ cwd });

  console.log(`Wrote ${target}`);
  console.log(`  workspace roots: ${config.workspaceRoots.join(", ")}`);
  console.log(`  permission profile: ${config.permissionProfile}`);
  console.log(`  port: ${config.port} (admin ${config.adminPort}), bind ${config.bindHost}`);
  console.log(`  tunnel alias: ${config.tunnel.alias}`);
  console.log("");
  console.log("Next: `chatgpt-local-coder doctor`, then `chatgpt-local-coder up`.");

  return 0;
}
