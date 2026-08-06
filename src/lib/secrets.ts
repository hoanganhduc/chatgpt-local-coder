/**
 * Private-file secret store.
 *
 * Read order: process.env[name] -> <configDir>/secrets.json
 * Writes go to the file, created 0600 (restricted DACL on Windows).
 * Values are never logged; callers report only set/unset.
 */

import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";

import { configDir, ensureDir } from "../config/paths.js";
import { isWindows, runExecutable } from "./platform.js";

export function secretsPath(): string {
  return path.join(configDir(), "secrets.json");
}

async function readStore(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(secretsPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function restrictWindowsAcl(target: string): Promise<void> {
  const user = process.env.USERNAME || os.userInfo().username;
  if (!user) return;
  await runExecutable(
    "icacls",
    [target, "/inheritance:r", "/grant:r", `${user}:F`],
    { timeoutMs: 15_000 }
  );
}

/**
 * Write a file only its owner can read.
 *
 * Exported because the secret store is not the only thing that has to land this
 * way: the generated admin token is one too, and it needs somewhere to go that
 * is not stdout. Kept as one implementation so the Windows ACL handling cannot
 * drift between the two.
 */
export async function writeRestricted(target: string, content: string): Promise<void> {
  ensureDir(path.dirname(target));

  // Create with restrictive mode before any content is written.
  const handle = await fs.open(target, "w", 0o600);
  try {
    await handle.writeFile(content, "utf-8");
  } finally {
    await handle.close();
  }

  if (isWindows()) {
    await restrictWindowsAcl(target);
  } else {
    await fs.chmod(target, 0o600);
  }
}

async function writeStore(store: Record<string, string>): Promise<void> {
  await writeRestricted(secretsPath(), `${JSON.stringify(store, null, 2)}\n`);
}

export async function getSecret(name: string): Promise<string | undefined> {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;

  const store = await readStore();
  return store[name] || undefined;
}

export async function setSecret(name: string, value: string): Promise<void> {
  const store = await readStore();
  store[name] = value;
  await writeStore(store);
}

export async function deleteSecret(name: string): Promise<void> {
  const store = await readStore();
  if (!(name in store)) return;
  delete store[name];
  await writeStore(store);
}

/** Names present in the store or the environment — never the values. */
export async function listSecretNames(names: string[]): Promise<{ name: string; set: boolean; source?: "env" | "file" }[]> {
  const store = await readStore();
  return names.map((name) => {
    if (process.env[name]) return { name, set: true, source: "env" as const };
    if (store[name]) return { name, set: true, source: "file" as const };
    return { name, set: false };
  });
}

/**
 * Write a single secret to its own file and return a `file:<path>` reference.
 * The tunnel client rejects inline key material and accepts only `env:NAME` or
 * `file:/path` references, so this is how keys reach it.
 */
export async function secretFileReference(name: string): Promise<string | undefined> {
  const value = await getSecret(name);
  if (!value) return undefined;

  const dir = path.join(configDir(), "secret-refs");
  ensureDir(dir);
  const target = path.join(dir, `${name}`);

  const handle = await fs.open(target, "w", 0o600);
  try {
    await handle.writeFile(value, "utf-8");
  } finally {
    await handle.close();
  }

  if (isWindows()) {
    await restrictWindowsAcl(target);
  } else {
    await fs.chmod(target, 0o600);
  }

  return `file:${target}`;
}

/** Synchronous existence check used by doctor. */
export function secretsFileExists(): boolean {
  return fsSync.existsSync(secretsPath());
}
