/**
 * YAML frontmatter parsing for SKILL.md files.
 *
 * A deliberately small YAML subset is supported — scalars, inline and block
 * sequences, and one level of nested mapping — because skill frontmatter in the
 * wild uses only that much, and a full YAML dependency would be a large trusted
 * surface for something this simple. Anything not recognised is preserved
 * verbatim in `raw` rather than dropped, so a skill author's data is never lost
 * silently.
 */

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  allowedTools?: string[];
  context?: string;
  model?: string;
  agent?: string;
  hooks?: Record<string, unknown>;
  platforms?: string[];
  runtime?: string;
  entrypoint?: string;
  license?: string;
  metadata?: Record<string, unknown>;
  /** Every parsed key, under its original name. */
  raw: Record<string, unknown>;
}

export interface ParsedSkillFile {
  frontmatter: SkillFrontmatter;
  /** Document body with the frontmatter block removed. */
  body: string;
  /** True when a `---` block was present at all. */
  hadFrontmatter: boolean;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;

  // Inline sequence: [a, b, c]
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => stripQuotes(part));
  }

  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d*\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);

  return stripQuotes(trimmed);
}

function indentOf(line: string): number {
  return line.length - line.replace(/^\s*/, "").length;
}

/**
 * Parse a frontmatter block body into a map. Handles:
 *   key: scalar
 *   key: [a, b]
 *   key:
 *     - item
 *   key:
 *     nested: value
 */
function parseBlock(lines: string[], startIndex: number, baseIndent: number): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const indent = indentOf(line);
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      // Content deeper than expected without a parent key — skip rather than
      // guess at its meaning.
      i++;
      continue;
    }

    const match = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }

    const key = match[1].trim();
    const inlineValue = match[2];

    if (inlineValue.trim() !== "") {
      out[key] = parseScalar(inlineValue);
      i++;
      continue;
    }

    // Look ahead: block sequence, nested mapping, or an empty value.
    const next = lines[i + 1];
    if (next === undefined || !next.trim()) {
      out[key] = "";
      i++;
      continue;
    }

    const nextIndent = indentOf(next);
    if (nextIndent <= baseIndent) {
      out[key] = "";
      i++;
      continue;
    }

    if (next.trim().startsWith("- ") || next.trim() === "-") {
      const items: unknown[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const seqLine = lines[j];
        if (!seqLine.trim()) { j++; continue; }
        if (indentOf(seqLine) <= baseIndent || !seqLine.trim().startsWith("-")) break;
        items.push(parseScalar(seqLine.trim().replace(/^-\s*/, "")));
        j++;
      }
      out[key] = items;
      i = j;
      continue;
    }

    const [nested, consumedTo] = parseBlock(lines, i + 1, nextIndent);
    out[key] = nested;
    i = consumedTo;
  }

  return [out, i];
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  // A comma-separated scalar is the other common spelling.
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function asString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseSkillFile(content: string): ParsedSkillFile {
  const normalized = content.replace(/^﻿/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);

  if (!match) {
    return { frontmatter: { raw: {} }, body: normalized, hadFrontmatter: false };
  }

  const [raw] = parseBlock(match[1].split(/\r?\n/), 0, 0);
  const body = normalized.slice(match[0].length);

  const frontmatter: SkillFrontmatter = {
    name: asString(raw.name),
    description: asString(raw.description),
    // Both spellings appear in the wild.
    allowedTools: asStringArray(raw["allowed-tools"] ?? raw.allowedTools),
    context: asString(raw.context),
    model: asString(raw.model),
    agent: asString(raw.agent),
    hooks: asRecord(raw.hooks),
    platforms: asStringArray(raw.platforms),
    runtime: asString(raw.runtime),
    entrypoint: asString(raw.entrypoint),
    license: asString(raw.license),
    metadata: asRecord(raw.metadata),
    raw,
  };

  return { frontmatter, body, hadFrontmatter: true };
}
