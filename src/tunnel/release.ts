/**
 * tunnel-client binary acquisition.
 *
 * Releases are published at github.com/openai/tunnel-client as one zip per
 * platform/arch pair plus a `SHA256SUMS.txt` manifest. Rather than pin a
 * version the way the old PowerShell wrapper did, the latest release is
 * discovered at install time and the downloaded archive is verified against the
 * published digest before anything is unpacked.
 *
 * `tunnel.binPath` in the host config overrides all of this, and a
 * `tunnel-client` already on PATH is preferred over downloading a second copy.
 */

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

import { cacheDir } from "../config/paths.js";
import { archId, exeSuffix, platformId, which, type ArchId, type PlatformId } from "../lib/platform.js";
import { extractZip } from "./unzip.js";

export const TUNNEL_REPO = "openai/tunnel-client";
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${TUNNEL_REPO}/releases/latest`;
export const CHECKSUM_ASSET = "SHA256SUMS.txt";

/** The release names Windows "windows"; the other two match Node's platform id. */
function releaseOsName(platform: PlatformId): string {
  return platform === "win32" ? "windows" : platform;
}

export function tunnelAssetName(
  version: string,
  platform: PlatformId = platformId(),
  arch: ArchId = archId()
): string {
  return `tunnel-client-${version}-${releaseOsName(platform)}-${arch}.zip`;
}

export function tunnelBinaryName(): string {
  return `tunnel-client${exeSuffix()}`;
}

export function tunnelCacheDir(version: string): string {
  return path.join(cacheDir(), "tunnel-client", version);
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface ReleaseInfo {
  version: string;
  assets: ReleaseAsset[];
}

export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<ReleaseInfo> {
  const response = await fetchImpl(LATEST_RELEASE_URL, {
    headers: { accept: "application/vnd.github+json", "user-agent": "chatgpt-local-coder" },
  });
  if (!response.ok) {
    throw new Error(`could not read the latest tunnel-client release: HTTP ${response.status}`);
  }

  const body = (await response.json()) as { tag_name?: string; assets?: ReleaseAsset[] };
  if (!body.tag_name) throw new Error("release response carried no tag_name");

  return { version: body.tag_name, assets: body.assets ?? [] };
}

/** Parse the `<sha256>  <filename>` lines of a SHA256SUMS manifest. */
export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match) map.set(match[2].trim(), match[1].toLowerCase());
  }
  return map;
}

export function selectAsset(release: ReleaseInfo, platform?: PlatformId, arch?: ArchId): ReleaseAsset {
  const wanted = tunnelAssetName(release.version, platform, arch);
  const asset = release.assets.find((a) => a.name === wanted);
  if (!asset) {
    throw new Error(
      `release ${release.version} has no asset ${wanted}; available: ${release.assets.map((a) => a.name).join(", ")}`
    );
  }
  return asset;
}

export function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export interface InstallOptions {
  /** Accept a release that publishes no checksum manifest. Off by default. */
  allowUnverified?: boolean;
  fetchImpl?: typeof fetch;
  platform?: PlatformId;
  arch?: ArchId;
}

export interface InstalledBinary {
  path: string;
  version: string;
  /** False only when `allowUnverified` was set and the release had no manifest. */
  verified: boolean;
}

/**
 * Download, verify and unpack the latest release into the cache directory. A
 * cached copy of the same version is reused rather than re-downloaded.
 */
export async function installTunnelBinary(opts: InstallOptions = {}): Promise<InstalledBinary> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const release = await fetchLatestRelease(fetchImpl);
  const dir = tunnelCacheDir(release.version);
  const binary = path.join(dir, tunnelBinaryName());

  try {
    await fs.access(binary);
    return { path: binary, version: release.version, verified: true };
  } catch {
    /* not cached yet */
  }

  const asset = selectAsset(release, opts.platform, opts.arch);

  const checksumAsset = release.assets.find((a) => a.name === CHECKSUM_ASSET);
  let expected: string | undefined;
  if (checksumAsset) {
    const response = await fetchImpl(checksumAsset.browser_download_url);
    if (!response.ok) throw new Error(`could not read ${CHECKSUM_ASSET}: HTTP ${response.status}`);
    expected = parseChecksums(await response.text()).get(asset.name);
  }

  if (!expected && !opts.allowUnverified) {
    throw new Error(
      `release ${release.version} publishes no checksum for ${asset.name}; refusing to install an unverified binary`
    );
  }

  const download = await fetchImpl(asset.browser_download_url);
  if (!download.ok) throw new Error(`download failed for ${asset.name}: HTTP ${download.status}`);
  const archive = Buffer.from(await download.arrayBuffer());

  if (expected) {
    const actual = sha256(archive);
    if (actual !== expected) {
      throw new Error(`checksum mismatch for ${asset.name}: expected ${expected}, got ${actual}`);
    }
  }

  await fs.mkdir(dir, { recursive: true });
  const archivePath = path.join(dir, asset.name);
  await fs.writeFile(archivePath, archive);

  try {
    const written = await extractZip(archivePath, dir);
    const found = written.find((e) => path.basename(e.path) === tunnelBinaryName());
    if (!found) {
      throw new Error(`${asset.name} contained no ${tunnelBinaryName()}`);
    }
    if (found.path !== binary) await fs.rename(found.path, binary);
    await fs.chmod(binary, 0o755).catch(() => undefined);
  } finally {
    await fs.rm(archivePath, { force: true });
  }

  return { path: binary, version: release.version, verified: Boolean(expected) };
}

export interface ResolveOptions extends InstallOptions {
  /** `tunnel.binPath` from the host config. */
  binPath?: string;
  /** Download when nothing is found locally. Off by default so `doctor` never installs. */
  download?: boolean;
}

export interface ResolvedBinary {
  path?: string;
  source: "config" | "cache" | "path" | "downloaded" | "missing";
  version?: string;
  error?: string;
}

/**
 * Order two release tags. Segments that are numeric compare as numbers, so
 * `v0.0.10` sorts above `v0.0.9`; a plain string sort gets that backwards and
 * would pin the cache to an older binary from v0.0.10 onwards.
 */
export function compareVersions(a: string, b: string): number {
  const segments = (version: string) => version.replace(/^v/i, "").split(/[.+-]/);
  const left = segments(a);
  const right = segments(b);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? "";
    const r = right[i] ?? "";
    if (l === r) continue;

    const ln = Number.parseInt(l, 10);
    const rn = Number.parseInt(r, 10);
    if (Number.isFinite(ln) && Number.isFinite(rn)) {
      if (ln !== rn) return ln - rn;
      continue;
    }
    return l < r ? -1 : 1;
  }

  return 0;
}

/** Newest-first, so a cache holding several versions yields the latest. */
async function newestCached(): Promise<{ path: string; version: string } | undefined> {
  const root = path.join(cacheDir(), "tunnel-client");
  let versions: string[];
  try {
    versions = await fs.readdir(root);
  } catch {
    return undefined;
  }

  for (const version of versions.sort((a, b) => compareVersions(b, a))) {
    const candidate = path.join(root, version, tunnelBinaryName());
    try {
      await fs.access(candidate);
      return { path: candidate, version };
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

export async function resolveTunnelBinary(opts: ResolveOptions = {}): Promise<ResolvedBinary> {
  if (opts.binPath) {
    const resolved = path.resolve(opts.binPath);
    try {
      await fs.access(resolved);
      return { path: resolved, source: "config" };
    } catch {
      return { source: "missing", error: `tunnel.binPath does not exist: ${resolved}` };
    }
  }

  const cached = await newestCached();
  if (cached) return { path: cached.path, source: "cache", version: cached.version };

  const onPath = which("tunnel-client");
  if (onPath) return { path: onPath, source: "path" };

  if (!opts.download) return { source: "missing", error: "tunnel-client is not installed" };

  try {
    const installed = await installTunnelBinary(opts);
    return { path: installed.path, source: "downloaded", version: installed.version };
  } catch (error) {
    return { source: "missing", error: error instanceof Error ? error.message : String(error) };
  }
}
