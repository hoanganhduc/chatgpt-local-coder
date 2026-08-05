/**
 * Minimal zip reader.
 *
 * The tunnel-client releases ship as `.zip` on every platform, and there is no
 * portable extractor to shell out to: GNU tar cannot read zip, `unzip` is not
 * installed by default on many Linux images, and `Expand-Archive` is Windows
 * only. Rather than add a dependency for one archive with one entry in it, this
 * parses the central directory directly and inflates each member.
 *
 * Supported: stored (method 0) and deflate (method 8), which is everything the
 * releases use. Zip64 is detected and refused rather than mis-read.
 */

import fs from "fs/promises";
import path from "path";
import zlib from "zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;

export interface ZipEntry {
  name: string;
  /** Unix permission bits from the external attributes, 0 when absent. */
  mode: number;
  size: number;
  method: number;
  localHeaderOffset: number;
  compressedSize: number;
}

function findEndOfCentralDirectory(buf: Buffer): number {
  // The EOCD is last, but a trailing comment may follow it, so scan backwards
  // over the largest comment the format allows.
  const start = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error("not a zip archive: no end-of-central-directory record");
}

export function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);

  if (centralOffset === ZIP64_MARKER || total === 0xffff) {
    throw new Error("zip64 archives are not supported");
  }

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;

  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`corrupt central directory at entry ${i}`);
    }

    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const size = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const externalAttrs = buf.readUInt32LE(cursor + 38);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString("utf-8", cursor + 46, cursor + 46 + nameLen);

    if (compressedSize === ZIP64_MARKER || size === ZIP64_MARKER || localHeaderOffset === ZIP64_MARKER) {
      throw new Error(`zip64 entry is not supported: ${name}`);
    }

    entries.push({
      name,
      // The high 16 bits of the external attributes carry the unix mode when
      // the archive was produced on a unix-like system; zero otherwise.
      mode: (externalAttrs >>> 16) & 0o7777,
      size,
      method,
      localHeaderOffset,
      compressedSize,
    });

    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * Inflate one entry. Sizes come from the central directory rather than the
 * local header, which may be zeroed when a data descriptor is used.
 */
export function readZipEntryData(buf: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (buf.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new Error(`corrupt local header for ${entry.name}`);
  }

  const nameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
}

/**
 * Reject anything that would land outside `destDir`. The archive is fetched
 * over the network, so its member names are untrusted input.
 */
function safeJoin(destDir: string, name: string): string {
  const normalized = name.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`refusing absolute path in archive: ${name}`);
  }

  const target = path.resolve(destDir, normalized);
  const root = path.resolve(destDir);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`refusing path outside the extraction directory: ${name}`);
  }
  return target;
}

export interface ExtractedEntry {
  name: string;
  path: string;
  size: number;
}

/** Extract every file member; directory members are created but not returned. */
export async function extractZip(zipPath: string, destDir: string): Promise<ExtractedEntry[]> {
  const buf = await fs.readFile(zipPath);
  const entries = readZipEntries(buf);
  const written: ExtractedEntry[] = [];

  await fs.mkdir(destDir, { recursive: true });

  for (const entry of entries) {
    const target = safeJoin(destDir, entry.name);

    if (entry.name.endsWith("/")) {
      await fs.mkdir(target, { recursive: true });
      continue;
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    const data = readZipEntryData(buf, entry);
    if (data.length !== entry.size) {
      throw new Error(`size mismatch for ${entry.name}: expected ${entry.size}, got ${data.length}`);
    }

    await fs.writeFile(target, data);
    if (entry.mode) {
      // chmod is a no-op on Windows; the archive's unix bits are irrelevant there.
      await fs.chmod(target, entry.mode).catch(() => undefined);
    }

    written.push({ name: entry.name, path: target, size: entry.size });
  }

  return written;
}
