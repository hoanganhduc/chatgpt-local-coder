/**
 * Project memory loading, limits, truncation, metadata and server-level
 * identity checks — plan revision 2, fixtures F01–F23 (§16).
 *
 * Tests import the built `dist/` modules and spawn the built server on ports
 * this process owns. The fixture home and config paths are synthetic; no
 * production environment is inherited into spawned children.
 *
 * Run: node scripts/test-project-memory.mjs
 * Env used by the runner (optional):
 *   CLC_EVIDENCE_DIR   — write per-fixture result records there
 *   CLC_TEST_TAG       — suffix for the results file name
 *   CLC_GOLDEN_DIR     — when set, capture F18 import goldens; otherwise compare
 *   CLC_SOURCE_SHA / CLC_SOURCE_SHA_ROLE / CLC_PATCH_SHA256 /
 *   CLC_SOURCE_TREE_SHA256 / CLC_EXPECTED_REF — source identity per §12.3
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// ---- hermetic process environment (before any dist import) ----
for (const key of [
  "PROJECT_MEMORY_MAX_LINES",
  "PROJECT_MEMORY_MAX_BYTES",
  "AUTO_MEMORY_MAX_LINES",
  "AUTO_MEMORY_MAX_BYTES",
]) {
  delete process.env[key];
}
const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), "clc-pm-home-"));
process.env.HOME = fixtureHome;
if (process.platform === "win32") {
  // os.homedir() honours USERPROFILE on Windows, so redirect it too — the
  // fixtures must never see the runner's real user memory files.
  process.env.USERPROFILE = fixtureHome;
  process.env.APPDATA = path.join(fixtureHome, "appdata", "roaming");
  process.env.LOCALAPPDATA = path.join(fixtureHome, "appdata", "local");
}

const evidenceDir = process.env.CLC_EVIDENCE_DIR || null;
const testTag = process.env.CLC_TEST_TAG || "run";

const pmModule = await import("../dist/lib/project-memory.js");
const { loadProjectMemory } = pmModule;
const ProjectMemoryConfigError = pmModule.ProjectMemoryConfigError;
const icModule = await import("../dist/lib/instruction-context.js");
const { buildInstructionContext, summarizeInstructionContext } = icModule;

// ---- harness ----
const F02A_NAMES = [
  "writing-style-settings.md",
  "math-manuscript-style.md",
  "graph-combinatorics-style.md",
  "mathscinet-zbmath-review-style.md",
];
const results = [];
let passed = 0;
let failed = 0;

function record(fixtureId, status, expected, actual, note = "") {
  results.push({
    fixture_id: fixtureId,
    status,
    expected: String(expected),
    actual: String(actual),
    note,
    source_sha: process.env.CLC_SOURCE_SHA || "unset",
    source_sha_role: process.env.CLC_SOURCE_SHA_ROLE || "unset",
    patch_sha256: process.env.CLC_PATCH_SHA256 || "unset",
    source_tree_sha256: process.env.CLC_SOURCE_TREE_SHA256 || "unset",
    expected_ref: process.env.CLC_EXPECTED_REF || "plan-rev2-section-16",
    node_version: process.version,
    os: `${process.platform} ${process.arch}`,
  });
}

function check(fixtureId, name, cond, expected, actual) {
  if (cond) {
    console.log(`OK   ${fixtureId} ${name}`);
    record(fixtureId, "pass", expected, actual);
    passed++;
  } else {
    console.error(`FAIL ${fixtureId} ${name}: expected ${expected}, got ${actual}`);
    record(fixtureId, "fail", expected, actual);
    failed++;
  }
}

function lines(n) {
  return Array(n).fill("x").join("\n");
}

function mkFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clc-pm-fix-"));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

function omitCounts(bundle) {
  return bundle?.memory_omitted_counts ?? "absent";
}

function reasonsOf(section) {
  return section?.truncation_reasons ?? "absent";
}

const INVALID_ENV_STRINGS = [
  "+500",
  "5e2",
  "500.0",
  "500abc",
  "0",
  "-1",
  "Infinity",
  "NaN",
  "9007199254740992",
];

const INVALID_OPT_VALUES = [null, "500", true, {}, 0, -1, 1.5, NaN];

const EXPECTED_ERROR_MESSAGE =
  "Invalid project memory limit: <key> (<source>); expected a positive safe integer.";

// =====================================================================
// Unit fixtures F01–F18
// =====================================================================

async function runUnitFixtures() {
  // F01 — one ok file, no opts/env: defaults 500/32768.
  {
    const dir = mkFixture({ "AGENTS.md": "ok" });
    const bundle = await loadProjectMemory(dir);
    check(
      "F01",
      "default limits 500/32768",
      bundle.memory_limits?.max_lines_per_section === 500 &&
        bundle.memory_limits?.max_content_bytes === 32768,
      "500/32768",
      JSON.stringify(bundle.memory_limits ?? "absent")
    );
    check(
      "F01",
      "sources default/default",
      bundle.memory_limit_sources?.maxLines === "default" &&
        bundle.memory_limit_sources?.maxBytes === "default",
      "default/default",
      JSON.stringify(bundle.memory_limit_sources ?? "absent")
    );
    const sec = bundle.sections?.[0];
    check("F01", "content ok, 2 bytes", sec?.content === "ok" && sec?.content_bytes === 2, "ok/2", JSON.stringify({ content: sec?.content, bytes: sec?.content_bytes }));
    check("F01", "reasons [] and truncated false", reasonsOf(sec)?.length === 0 && sec?.truncated === false, "[]/false", JSON.stringify({ reasons: reasonsOf(sec), truncated: sec?.truncated }));
    check(
      "F01",
      "omissions all zero",
      omitCounts(bundle)?.byte_budget_exhausted === 0 &&
        omitCounts(bundle)?.empty_after_transform === 0 &&
        omitCounts(bundle)?.empty_after_limits === 0 &&
        omitCounts(bundle)?.unreadable === 0,
      "0/0/0/0",
      JSON.stringify(omitCounts(bundle))
    );
    check("F01", "total_bytes === 2", bundle.total_bytes === 2, "2", String(bundle.total_bytes));
  }

  // F02 — 323-line fixture, router at ~315. Default keeps it; opts 200/25000 cuts it.
  {
    const content = [
      ...Array(314).fill("x"),
      "# Writing Instructions",
      ...F02A_NAMES,
      ...Array(4).fill("x"),
    ].join("\n");
    const dir = mkFixture({ "AGENTS.md": content });
    const def = await loadProjectMemory(dir);
    const defContent = def.sections?.[0]?.content ?? "";
    check(
      "F02",
      "default keeps title and all 4 names, not truncated",
      defContent.includes("# Writing Instructions") &&
        F02A_NAMES.every((n) => defContent.includes(n)) &&
        def.sections?.[0]?.truncated === false,
      "kept/truncated=false",
      JSON.stringify({
        has_title: defContent.includes("# Writing Instructions"),
        names_found: F02A_NAMES.filter((n) => defContent.includes(n)).length,
        truncated: def.sections?.[0]?.truncated,
      })
    );
    const cut = await loadProjectMemory(dir, { maxLines: 200, maxBytes: 25000 });
    const cutContent = cut.sections?.[0]?.content ?? "";
    check(
      "F02",
      "opts 200/25000 loses title and 4 names, line_limit only",
      !cutContent.includes("# Writing Instructions") &&
        F02A_NAMES.every((n) => !cutContent.includes(n)) &&
        JSON.stringify(reasonsOf(cut.sections?.[0])) === JSON.stringify(["line_limit"]),
      "lost/line_limit",
      JSON.stringify({
        has_title: cutContent.includes("# Writing Instructions"),
        names_found: F02A_NAMES.filter((n) => cutContent.includes(n)).length,
        reasons: reasonsOf(cut.sections?.[0]),
      })
    );
  }

  // F03 — 499/500/501 lines.
  {
    const cases = [
      { n: 499, bytes: 997, reasons: [] },
      { n: 500, bytes: 999, reasons: [] },
      { n: 501, bytes: 999, reasons: ["line_limit"], content: lines(500) },
    ];
    for (const c of cases) {
      const dir = mkFixture({ "AGENTS.md": lines(c.n) });
      const bundle = await loadProjectMemory(dir);
      const sec = bundle.sections?.[0];
      const okReasons =
        JSON.stringify(reasonsOf(sec) ?? "absent") === JSON.stringify(c.reasons);
      const okBytes = sec?.content_bytes === c.bytes;
      const okContent = c.content !== undefined ? sec?.content === c.content : true;
      check(
        "F03",
        `lines(${c.n}) -> bytes ${c.bytes}, reasons ${JSON.stringify(c.reasons)}`,
        okReasons && okBytes && okContent,
        `${c.bytes}/${JSON.stringify(c.reasons)}`,
        JSON.stringify({ bytes: sec?.content_bytes, reasons: reasonsOf(sec), content_len: sec?.content?.length })
      );
    }
  }

  // F04 — trailing newline and CRLF variants.
  {
    const noNewline = lines(500);
    for (const [label, body] of [
      ["LF+trailing newline", `${noNewline}\n`],
      ["CRLF everywhere", noNewline.replace(/\n/g, "\r\n")],
    ]) {
      const dir = mkFixture({ "AGENTS.md": body });
      const bundle = await loadProjectMemory(dir);
      const sec = bundle.sections?.[0];
      check(
        "F04",
        `${label} -> lines(500), 999 bytes, reasons [], truncated false`,
        sec?.content === noNewline &&
          sec?.content_bytes === 999 &&
          JSON.stringify(reasonsOf(sec) ?? "absent") === "[]" &&
          sec?.truncated === false,
        "lines(500)/999/[]/false",
        JSON.stringify({
          content_eq: sec?.content === noNewline,
          bytes: sec?.content_bytes,
          reasons: reasonsOf(sec),
          truncated: sec?.truncated,
        })
      );
    }
  }

  // F05 — 500 LFs then TAIL: no content, empty_after_limits, internal line_limit.
  {
    const dir = mkFixture({ "AGENTS.md": `${"\n".repeat(500)}TAIL` });
    const bundle = await loadProjectMemory(dir);
    const counts = omitCounts(bundle);
    check(
      "F05",
      "no section content; empty_after_limits=1; line_limit reason; blank lines not collapsed",
      (bundle.sections?.length ?? -1) === 0 &&
        counts?.empty_after_limits === 1 &&
        bundle.omitted_sections?.[0]?.reason === "empty_after_limits" &&
        bundle.omitted_sections?.[0]?.truncation_reasons?.includes("line_limit") &&
        bundle.total_bytes === 0,
      "empty_after_limits=1,line_limit",
      JSON.stringify({
        sections: bundle.sections?.length,
        counts: omitCounts(bundle),
        omitted0: bundle.omitted_sections?.[0],
        total_bytes: bundle.total_bytes,
      })
    );
  }

  // F06 — comment-only file; huge-comment variant: empty_after_transform, no byte_limit.
  {
    for (const [label, body] of [
      ["small comment", "<!-- note -->\n   \n"],
      ["huge comment", `<!-- ${"a".repeat(40000)} -->`],
    ]) {
      const dir = mkFixture({ "AGENTS.md": body });
      const bundle = await loadProjectMemory(dir);
      const counts = omitCounts(bundle);
      check(
        "F06",
        `${label} -> empty_after_transform=1, memory_bytes=0, no byte_limit`,
        counts?.empty_after_transform === 1 &&
          bundle.total_bytes === 0 &&
          !(bundle.omitted_sections?.[0]?.truncation_reasons ?? []).includes("byte_limit"),
        "empty_after_transform=1,0,no byte_limit",
        JSON.stringify({ counts: omitCounts(bundle), total_bytes: bundle.total_bytes, omitted0: bundle.omitted_sections?.[0] })
      );
    }
  }

  // F07 — single line of a*N at 32767/32768/32769 bytes.
  {
    const cases = [
      { n: 32767, bytes: 32767, reasons: [] },
      { n: 32768, bytes: 32768, reasons: [] },
      { n: 32769, bytes: 32768, reasons: ["byte_limit"] },
    ];
    for (const c of cases) {
      const dir = mkFixture({ "AGENTS.md": "a".repeat(c.n) });
      const bundle = await loadProjectMemory(dir);
      const sec = bundle.sections?.[0];
      check(
        "F07",
        `a*${c.n} -> bytes ${c.bytes}, reasons ${JSON.stringify(c.reasons)}`,
        sec?.content_bytes === c.bytes && JSON.stringify(reasonsOf(sec) ?? "absent") === JSON.stringify(c.reasons),
        `${c.bytes}/${JSON.stringify(c.reasons)}`,
        JSON.stringify({ bytes: sec?.content_bytes, reasons: reasonsOf(sec) })
      );
    }
  }

  // F08 — two project files share the byte budget.
  {
    const dir = mkFixture({ "CLAUDE.md": "AAAA", "AGENTS.md": "BBBB" });
    const b6 = await loadProjectMemory(dir, { maxBytes: 6, maxLines: 500 });
    check(
      "F08",
      "maxBytes=6 -> AAAA/BB, total 6, second byte_limit",
      b6.sections?.length === 2 &&
        b6.sections?.[0]?.content === "AAAA" &&
        b6.sections?.[1]?.content === "BB" &&
        b6.total_bytes === 6 &&
        JSON.stringify(reasonsOf(b6.sections?.[1]) ?? "absent") === JSON.stringify(["byte_limit"]),
      "AAAA/BB/6/byte_limit",
      JSON.stringify({
        contents: b6.sections?.map((s) => s.content),
        total: b6.total_bytes,
        reasons1: reasonsOf(b6.sections?.[1]),
      })
    );
    const b4 = await loadProjectMemory(dir, { maxBytes: 4, maxLines: 500 });
    check(
      "F08",
      "maxBytes=4 -> only first file, byte_budget_exhausted=1",
      b4.sections?.length === 1 &&
        b4.sections?.[0]?.content === "AAAA" &&
        omitCounts(b4)?.byte_budget_exhausted === 1 &&
        b4.total_bytes === 4,
      "AAAA/1/4",
      JSON.stringify({ contents: b4.sections?.map((s) => s.content), counts: omitCounts(b4), total: b4.total_bytes })
    );
  }

  // F09 — UTF-8 boundary cutting.
  {
    const expectedContents = ["a", "ab", "ab", "abé", "abé", "abé", "abé", "abé🙂", "abé🙂Z"];
    const expectedBytes = [1, 2, 2, 4, 4, 4, 4, 8, 9];
    for (let i = 0; i < 9; i++) {
      const maxBytes = i + 1;
      const dir = mkFixture({ "AGENTS.md": "abé🙂Z" });
      const bundle = await loadProjectMemory(dir, { maxBytes, maxLines: 500 });
      const sec = bundle.sections?.[0];
      const expectedReasons = maxBytes === 9 ? [] : ["byte_limit"];
      check(
        "F09",
        `maxBytes=${maxBytes} -> content ok, no replacement chars`,
        sec?.content === expectedContents[i] &&
          sec?.content_bytes === expectedBytes[i] &&
          !(sec?.content ?? "").includes("\uFFFD") &&
          JSON.stringify(reasonsOf(sec) ?? "absent") === JSON.stringify(expectedReasons),
        `${JSON.stringify(expectedContents[i])}/${expectedBytes[i]}`,
        JSON.stringify({ content: sec?.content, bytes: sec?.content_bytes, reasons: reasonsOf(sec) })
      );
    }
  }

  // F10 — first candidate empties, next candidate still gets budget.
  {
    const dir = mkFixture({ "CLAUDE.md": "é", "AGENTS.md": "A" });
    const bundle = await loadProjectMemory(dir, { maxBytes: 1, maxLines: 500 });
    check(
      "F10",
      "budget=1: first empty_after_limits/byte_limit, second keeps A",
      bundle.sections?.length === 1 &&
        bundle.sections?.[0]?.content === "A" &&
        omitCounts(bundle)?.empty_after_limits === 1 &&
        bundle.omitted_sections?.[0]?.reason === "empty_after_limits" &&
        bundle.omitted_sections?.[0]?.truncation_reasons?.includes("byte_limit"),
      "A / empty_after_limits+byte_limit",
      JSON.stringify({ contents: bundle.sections?.map((s) => s.content), counts: omitCounts(bundle), omitted0: bundle.omitted_sections?.[0] })
    );
  }

  // F11 — reasons order line_limit then byte_limit.
  {
    const dir = mkFixture({ "AGENTS.md": "AA\nBB\nCC" });
    const bundle = await loadProjectMemory(dir, { maxLines: 2, maxBytes: 3 });
    const sec = bundle.sections?.[0];
    check(
      "F11",
      "maxLines=2,maxBytes=3 -> content AA, 2 bytes, reasons [line_limit,byte_limit]",
      sec?.content === "AA" &&
        sec?.content_bytes === 2 &&
        JSON.stringify(reasonsOf(sec) ?? "absent") === JSON.stringify(["line_limit", "byte_limit"]),
      "AA/2/[line_limit,byte_limit]",
      JSON.stringify({ content: sec?.content, bytes: sec?.content_bytes, reasons: reasonsOf(sec) })
    );
  }

  // F12 — valid opts mask invalid env.
  {
    process.env.PROJECT_MEMORY_MAX_LINES = "500abc";
    const dir = mkFixture({ "AGENTS.md": "ok" });
    let error = null;
    let bundle = null;
    try {
      bundle = await loadProjectMemory(dir, { maxLines: 500 });
    } catch (e) {
      error = e;
    }
    check(
      "F12",
      "opts.maxLines=500 with invalid env -> no error, sources opts/default",
      error === null &&
        bundle?.memory_limit_sources?.maxLines === "opts" &&
        bundle?.memory_limit_sources?.maxBytes === "default" &&
        bundle?.memory_limits?.max_lines_per_section === 500,
      "opts/default",
      JSON.stringify({ error: error?.message, sources: bundle?.memory_limit_sources })
    );
    delete process.env.PROJECT_MEMORY_MAX_LINES;
  }

  // F13 — env unset/empty/whitespace -> default; 00500 / padded 500 -> env 500.
  {
    const dir = mkFixture({ "AGENTS.md": "ok" });
    const variants = [
      { env: undefined, source: "default" },
      { env: "", source: "default" },
      { env: "   ", source: "default" },
      { env: "00500", source: "env" },
      { env: " 500 ", source: "env" },
    ];
    for (const v of variants) {
      if (v.env === undefined) delete process.env.PROJECT_MEMORY_MAX_LINES;
      else process.env.PROJECT_MEMORY_MAX_LINES = v.env;
      const bundle = await loadProjectMemory(dir);
      check(
        "F13",
        `env lines=${JSON.stringify(v.env)} -> source ${v.source}, value 500`,
        bundle.memory_limit_sources?.maxLines === v.source &&
          bundle.memory_limits?.max_lines_per_section === 500,
        `${v.source}/500`,
        JSON.stringify({ source: bundle.memory_limit_sources?.maxLines, value: bundle.memory_limits?.max_lines_per_section })
      );
    }
    delete process.env.PROJECT_MEMORY_MAX_LINES;
  }

  // F14 — invalid values reject with code/key/source, fixed message, no raw value.
  {
    const dir = mkFixture({ "AGENTS.md": "ok" });
    for (const raw of INVALID_ENV_STRINGS) {
      process.env.PROJECT_MEMORY_MAX_LINES = raw;
      const err = await loadProjectMemory(dir).then(
        () => null,
        (e) => e
      );
      const message = err?.message ?? "";
      check(
        "F14",
        `env lines=${JSON.stringify(raw)} rejects with code/key/source env`,
        err?.code === "ERR_PROJECT_MEMORY_LIMIT" &&
          err?.key === "maxLines" &&
          err?.source === "env" &&
          message === "Invalid project memory limit: maxLines (env); expected a positive safe integer.",
        "ERR_PROJECT_MEMORY_LIMIT/maxLines/env",
        JSON.stringify({ code: err?.code, key: err?.key, source: err?.source, message })
      );
    }
    delete process.env.PROJECT_MEMORY_MAX_LINES;
    for (const raw of INVALID_OPT_VALUES) {
      const err = await loadProjectMemory(dir, { maxLines: raw }).then(
        () => null,
        (e) => e
      );
      check(
        "F14",
        `opts.maxLines=${String(raw)} rejects with code/key/source opts`,
        err?.code === "ERR_PROJECT_MEMORY_LIMIT" &&
          err?.key === "maxLines" &&
          err?.source === "opts" &&
          err?.message === "Invalid project memory limit: maxLines (opts); expected a positive safe integer.",
        "ERR_PROJECT_MEMORY_LIMIT/maxLines/opts",
        JSON.stringify({ code: err?.code, key: err?.key, source: err?.source, message: err?.message })
      );
    }
    // maxBytes key too, one case each source.
    process.env.PROJECT_MEMORY_MAX_BYTES = "notanumber";
    let errBytes = await loadProjectMemory(dir).then(
      () => null,
      (e) => e
    );
    check(
      "F14",
      "env bytes invalid rejects with key maxBytes",
      errBytes?.code === "ERR_PROJECT_MEMORY_LIMIT" && errBytes?.key === "maxBytes" && errBytes?.source === "env",
      "maxBytes/env",
      JSON.stringify({ key: errBytes?.key, source: errBytes?.source })
    );
    delete process.env.PROJECT_MEMORY_MAX_BYTES;
    errBytes = await loadProjectMemory(dir, { maxBytes: 1.5 }).then(
      () => null,
      (e) => e
    );
    check(
      "F14",
      "opts bytes 1.5 rejects with key maxBytes",
      errBytes?.code === "ERR_PROJECT_MEMORY_LIMIT" && errBytes?.key === "maxBytes" && errBytes?.source === "opts",
      "maxBytes/opts",
      JSON.stringify({ key: errBytes?.key, source: errBytes?.source })
    );
  }

  // F15 — two calls in one process, env change between them; first bundle is a snapshot.
  {
    const dir = mkFixture({ "AGENTS.md": lines(501) });
    process.env.PROJECT_MEMORY_MAX_LINES = "200";
    const first = await loadProjectMemory(dir);
    const firstContent = first.sections?.[0]?.content ?? "";
    process.env.PROJECT_MEMORY_MAX_LINES = "500";
    const second = await loadProjectMemory(dir);
    process.env.PROJECT_MEMORY_MAX_LINES = "123";
    check(
      "F15",
      "env 200 then 500 -> bundles 200/500; later env change leaves first bundle untouched",
      first?.memory_limits?.max_lines_per_section === 200 &&
        first?.memory_limit_sources?.maxLines === "env" &&
        firstContent === lines(200) &&
        second?.memory_limits?.max_lines_per_section === 500 &&
        second?.sections?.[0]?.content === lines(500) &&
        first?.memory_limits?.max_lines_per_section === 200,
      "200/500/snapshot",
      JSON.stringify({
        first_limits: first?.memory_limits,
        first_source: first?.memory_limit_sources?.maxLines,
        first_content_len: firstContent.length,
        second_limits: second?.memory_limits,
        second_content_len: second?.sections?.[0]?.content?.length,
        first_after: first?.memory_limits,
      })
    );
    delete process.env.PROJECT_MEMORY_MAX_LINES;
  }

  // F16 — 500-line cap is per section.
  {
    const dir = mkFixture({ "CLAUDE.md": lines(300), "AGENTS.md": lines(300) });
    const bundle = await loadProjectMemory(dir);
    check(
      "F16",
      "two 300-line files -> both kept (600 lines total)",
      bundle.sections?.length === 2 &&
        bundle.sections?.[0]?.content === lines(300) &&
        bundle.sections?.[1]?.content === lines(300) &&
        bundle.sections?.every((s) => s.truncated === false),
      "600 lines, not truncated",
      JSON.stringify({ sections: bundle.sections?.length, lengths: bundle.sections?.map((s) => s.content?.length) })
    );
  }

  // F17 — line cap applies after import expansion, no per-import allowance.
  {
    const dir = mkFixture({ "AGENTS.md": "@imported.md\nTAIL", "imported.md": lines(501) });
    const bundle = await loadProjectMemory(dir);
    const content = bundle.sections?.[0]?.content ?? "";
    check(
      "F17",
      "expanded 503 lines -> 500 kept, TAIL absent, line_limit",
      content.includes("@import") &&
        !content.includes("TAIL") &&
        content.split("\n").filter((l) => l === "x").length === 499 &&
        JSON.stringify(reasonsOf(bundle.sections?.[0]) ?? "absent") === JSON.stringify(["line_limit"]),
      "marker + 499 x, line_limit",
      JSON.stringify({ has_tail: content.includes("TAIL"), reasons: reasonsOf(bundle.sections?.[0]) })
    );
  }

  // F18 — import semantics unchanged. Expected strings below are the baseline
  // goldens captured from the unmodified loader (see evidence/fixtures/golden/);
  // `${TMP}` normalizes the per-run temp prefix. Do not regenerate these from
  // the candidate implementation.
  {
    const F18_EXPECTED = {
      fence: "```\n@inside-fence.md\n```\nKEEP",
      circular: [
        "<!-- @import ${TMP}/clc-pm-golden-import/circular/a.md -->",
        "<!-- @import ${TMP}/clc-pm-golden-import/circular/b.md -->",
        "<!-- skipped circular import ${TMP}/clc-pm-golden-import/circular/a.md -->",
        "B",
        "A",
      ].join("\n"),
      missing: [
        "<!-- import failed: ${TMP}/clc-pm-golden-import/missing/missing-file.md -->",
        "M",
      ].join("\n"),
      depth: [
        "<!-- @import ${TMP}/clc-pm-golden-import/depth/d0.md -->",
        "<!-- @import ${TMP}/clc-pm-golden-import/depth/d1.md -->",
        "<!-- @import ${TMP}/clc-pm-golden-import/depth/d2.md -->",
        "<!-- @import ${TMP}/clc-pm-golden-import/depth/d3.md -->",
        "@d4.md",
        "D3",
        "D2",
        "D1",
        "D0",
      ].join("\n"),
    };
    const GOLDEN_BASE = path.join(os.tmpdir(), "clc-pm-golden-import");
    fs.rmSync(GOLDEN_BASE, { recursive: true, force: true });
    fs.mkdirSync(GOLDEN_BASE, { recursive: true });
    const cases = {
      fence: {
        "AGENTS.md": "```\n@inside-fence.md\n```\nKEEP",
        "inside-fence.md": "INSIDE",
      },
      circular: {
        "AGENTS.md": "@a.md\n",
        "a.md": "@b.md\nA",
        "b.md": "@a.md\nB",
      },
      missing: {
        "AGENTS.md": "@missing-file.md\nM",
      },
      depth: {
        "AGENTS.md": "@d0.md\n",
        "d0.md": "@d1.md\nD0",
        "d1.md": "@d2.md\nD1",
        "d2.md": "@d3.md\nD2",
        "d3.md": "@d4.md\nD3",
        "d4.md": "@d5.md\nD4",
        "d5.md": "D5",
      },
    };
    // Fixed opts so the comparison is limit-independent.
    const GOLDEN_OPTS = { maxLines: 10000, maxBytes: 1000000 };
    for (const [caseName, caseFiles] of Object.entries(cases)) {
      const caseDir = path.join(GOLDEN_BASE, caseName);
      fs.mkdirSync(caseDir, { recursive: true });
      for (const [rel, content] of Object.entries(caseFiles)) {
        fs.writeFileSync(path.join(caseDir, rel), content);
      }
      const bundle = await loadProjectMemory(caseDir, GOLDEN_OPTS);
      const content = bundle.sections?.find((s) => s.path === path.join(caseDir, "AGENTS.md"))?.content ?? "";
      const tmpNormalized = os.tmpdir().replace(/\\/g, "/");
      const normalized = content.replace(/\\/g, "/").split(tmpNormalized).join("${TMP}");
      const expected = F18_EXPECTED[caseName];
      check(
        "F18",
        `${caseName} matches baseline golden`,
        normalized === expected,
        "baseline golden",
        JSON.stringify({ expected_len: expected?.length, actual_len: normalized.length })
      );
    }
  }

  // T10 / summary schema — instruction context summary on a fixture workspace.
  {
    const dir = mkFixture({ "CLAUDE.md": "ok", "AGENTS.md": lines(600) });
    const ctx = await buildInstructionContext({
      workspaceRoot: dir,
      workspaceRoots: [dir],
      pid: process.pid,
      adminPort: 3001,
    });
    const summary = summarizeInstructionContext(ctx);
    const sumBytes = (summary.memory_files ?? []).reduce((a, f) => a + (f.content_bytes ?? 0), 0);
    check(
      "T10",
      "summary contract fields",
      summary.memory_contract_version === "clc.project-memory-summary.v1" &&
        summary.memory_limits?.max_lines_per_section === 500 &&
        summary.memory_limits?.max_content_bytes === 32768 &&
        summary.memory_limit_sources?.maxLines === "default" &&
        summary.memory_limit_sources?.maxBytes === "default",
      "v1/500/32768/default/default",
      JSON.stringify({
        v: summary.memory_contract_version,
        limits: summary.memory_limits,
        sources: summary.memory_limit_sources,
      })
    );
    check(
      "T10",
      "memory_files carry content_bytes and truncation_reasons; line_limit on 600-line file",
      Array.isArray(summary.memory_files) &&
        summary.memory_files?.length === 2 &&
        summary.memory_files?.every((f) => typeof f.content_bytes === "number" && Array.isArray(f.truncation_reasons)) &&
        JSON.stringify(summary.memory_files?.[1]?.truncation_reasons) === JSON.stringify(["line_limit"]),
      "content_bytes + [line_limit]",
      JSON.stringify(summary.memory_files)
    );
    check(
      "T10",
      "omitted counts exactly four keys and memory_bytes === sum(content_bytes)",
      summary.memory_omitted_counts &&
        Object.keys(summary.memory_omitted_counts).length === 4 &&
        ["byte_budget_exhausted", "empty_after_transform", "empty_after_limits", "unreadable"].every((k) => typeof summary.memory_omitted_counts[k] === "number") &&
        summary.memory_bytes === sumBytes,
      "4 keys, sum matches",
      JSON.stringify({ counts: summary.memory_omitted_counts, memory_bytes: summary.memory_bytes, sum: sumBytes })
    );
    check(
      "T10",
      "no internal omitted_sections in public summary",
      !("omitted_sections" in summary) && !JSON.stringify(summary).includes("omitted_sections"),
      "absent",
      "present"
    );
  }
}

// =====================================================================
// Server-level fixtures F19–F23
// =====================================================================

function makeServerEnv(overrides = {}) {
  const base = path.join(
    os.tmpdir(),
    `clc-pm-server-${process.pid}-${Math.random().toString(36).slice(2)}`
  );
  const env = {
    // Toolchain lookup only — the parent (test runner) is already inside the
    // harness environment, so its PATH is the approved one. Nothing else is
    // inherited from the operator's environment.
    PATH: process.env.PATH || "",
    HOME: fixtureHome,
    XDG_CONFIG_HOME: path.join(base, "xdg-config"),
    XDG_STATE_HOME: path.join(base, "xdg-state"),
    XDG_CACHE_HOME: path.join(base, "xdg-cache"),
    CLC_CONFIG_DIR: path.join(base, "clc-config"),
    CLC_STATE_DIR: path.join(base, "clc-state"),
    CLC_CACHE_DIR: path.join(base, "clc-cache"),
    MCP_SHELL_STATE_DIR: path.join(base, "shell-state"),
    CODEX_HOME: path.join(base, "codex"),
    CHECKPOINT_PATH: path.join(base, "checkpoints"),
    AUDIT_LOG_PATH: path.join(base, "logs", "audit.jsonl"),
    MCP_UPSTREAM_CONFIG: path.join(base, "upstream.json"),
    TMPDIR: path.join(base, "tmp"),
    TMP: path.join(base, "tmp"),
    TEMP: path.join(base, "tmp"),
    CLC_PERMISSION_PROFILE: "workspace",
    CLC_SETTINGS_IMPORT: "false",
    CLC_DELEGATES: "false",
    CLC_HOOKS: "false",
    CLC_SKILL_EXECUTION: "false",
    CHATGPT_TOOL_PROFILE: "slim",
    ...(process.platform === "win32"
      ? {
          USERPROFILE: fixtureHome,
          APPDATA: path.join(fixtureHome, "appdata", "roaming"),
          LOCALAPPDATA: path.join(fixtureHome, "appdata", "local"),
        }
      : {}),
    ...overrides,
  };
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  fs.mkdirSync(path.dirname(env.AUDIT_LOG_PATH), { recursive: true });
  fs.writeFileSync(env.MCP_UPSTREAM_CONFIG, '{"version":1,"servers":[]}');
  return env;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function spawnServer(env, port) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (d) => (output += d));
  child.stderr?.on("data", (d) => (output += d));
  child.__output = () => output;
  return child;
}

function waitExit(child, ms = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { child.kill("SIGKILL"); } catch {}
        resolve({ code: "timeout", output: child.__output() });
      }
    }, ms);
    child.on("exit", (code, signal) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ code, signal, output: child.__output() });
      }
    });
  });
}

async function waitForHealth(port, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function reachable(port, ms = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(ms),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function runServerFixtures() {
  const marker = `CLCPMMARKER-${Math.random().toString(36).slice(2)}`;
  const serverWs = mkFixture({
    "AGENTS.md": [
      "# Fixture workspace",
      marker,
      "# Writing Instructions",
      ...F02A_NAMES,
      "END",
    ].join("\n"),
  });

  // F19 — port occupied by another (run-owned) host returning 200: candidate must fail.
  {
    const port = await freePort();
    const STUB_MARKER = "stub-owner-marker";
    const stub = http.createServer((_req, res) => {
      res.end(JSON.stringify({ status: "stub", marker: STUB_MARKER }));
    });
    await new Promise((res) => stub.listen(port, "127.0.0.1", res));
    const child = spawnServer(
      makeServerEnv({
        PORT: String(port),
        ADMIN_PORT: String(port + 1),
        WORKSPACE_PATH: serverWs,
        ADMIN_TOKEN: "fixture-admin-token",
      }),
      port
    );
    const outcome = await waitExit(child, 30000);
    check("F19", "candidate exits non-zero when port is taken", outcome.code === 1, "exit 1", JSON.stringify({ code: outcome.code, signal: outcome.signal }));
    const body = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
    check(
      "F19",
      "health on the port still belongs to the stub owner, not the candidate",
      body?.marker === STUB_MARKER && body?.runtime_instance_id === undefined,
      "stub marker, no instance id",
      JSON.stringify(body)
    );
    check("F19", "stub owner is still alive (candidate must not stop it)", stub.listening === true, "listening", String(stub.listening));
    await new Promise((res) => stub.close(res));
  }

  // F20 + F21 — instance identity, stable across boots and health polls.
  const port = await freePort();
  const env = makeServerEnv({
    PORT: String(port),
    ADMIN_PORT: String(port + 1),
    WORKSPACE_PATH: serverWs,
    ADMIN_TOKEN: "fixture-admin-token",
  });
  const child1 = spawnServer(env, port);
  const h1 = await waitForHealth(port);
  check("F20", "health reachable on first boot", h1 !== null, "health json", JSON.stringify(h1?.status ?? null));
  check("F20", "runtime_pid equals child pid", h1?.runtime_pid === child1.pid, String(child1.pid), String(h1?.runtime_pid));
  check("F20", "runtime_instance_id is a UUID", UUID_RE.test(h1?.runtime_instance_id ?? ""), "uuid v4", String(h1?.runtime_instance_id));
  const h1b = await waitForHealth(port);
  check(
    "F20",
    "same boot: UUID and PID stable across polls",
    h1b?.runtime_instance_id === h1?.runtime_instance_id && h1b?.runtime_pid === h1?.runtime_pid,
    "stable",
    `${h1?.runtime_instance_id} -> ${h1b?.runtime_instance_id} / ${h1?.runtime_pid} -> ${h1b?.runtime_pid}`
  );
  const ins = h1?.instructions ?? {};
  check(
    "F20",
    "health shows effective limits 500/32768 and contract version",
    ins?.memory_limits?.max_lines_per_section === 500 &&
      ins?.memory_limits?.max_content_bytes === 32768 &&
      ins?.memory_contract_version === "clc.project-memory-summary.v1",
    "500/32768/v1",
    JSON.stringify({ limits: ins?.memory_limits, version: ins?.memory_contract_version })
  );
  const om = ins?.memory_omitted_counts ?? {};
  check(
    "F20",
    "omitted counts present with exactly four keys",
    Object.keys(om).length === 4 &&
      ["byte_budget_exhausted", "empty_after_transform", "empty_after_limits", "unreadable"].every((k) => typeof om[k] === "number"),
    "4 keys",
    JSON.stringify(om)
  );
  const sumBytes = (ins?.memory_files ?? []).reduce((a, f) => a + (f.content_bytes ?? 0), 0);
  check("F20", "memory_bytes equals sum of content_bytes", ins?.memory_bytes === sumBytes, String(sumBytes), String(ins?.memory_bytes));
  check("F20", "public health has no omitted_sections", !("omitted_sections" in ins), "absent", "present");

  // F21 — full instructions via MCP initialize (not the 12k preview).
  {
    const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" },
        },
      }),
    });
    const text = await initRes.text();
    check("F21", "initialize response includes fixture marker", text.includes(marker), marker, "in response");
    for (const name of F02A_NAMES) {
      check("F21", `initialize response includes ${name}`, text.includes(name), name, "in response");
    }
    const sid = initRes.headers.get("mcp-session-id");
    const toolsRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sid,
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const toolsText = await toolsRes.text();
    check(
      "F21",
      "tools/list works on the new session (basic tools present)",
      sid !== null && toolsText.includes("apply_patch") && toolsText.includes("run_command"),
      "apply_patch + run_command",
      JSON.stringify({ sid: sid !== null, has_patch: toolsText.includes("apply_patch"), has_run: toolsText.includes("run_command") })
    );
  }

  // F20 continued — second boot: new UUID, matching PID.
  await new Promise((resolve) => {
    child1.once("exit", resolve);
    child1.kill("SIGTERM");
  });
  const child2 = spawnServer(env, port);
  const h2 = await waitForHealth(port);
  check("F20", "second boot health reachable", h2 !== null, "health json", String(h2 === null));
  check("F20", "second boot runtime_pid equals child pid", h2?.runtime_pid === child2.pid, String(child2.pid), String(h2?.runtime_pid));
  check(
    "F20",
    "second boot has a new UUID",
    h2?.runtime_instance_id !== h1?.runtime_instance_id && UUID_RE.test(h2?.runtime_instance_id ?? ""),
    "new uuid",
    `${h1?.runtime_instance_id} -> ${h2?.runtime_instance_id}`
  );
  // single-start observation: this harness never auto-restarts the child
  check(
    "F23",
    "harness does not auto-restart a stopped child (single start per boot)",
    child2.pid !== child1.pid && h2?.runtime_pid === child2.pid,
    "no auto-restart",
    JSON.stringify({ pid1: child1.pid, pid2: child2.pid })
  );
  await new Promise((resolve) => {
    child2.once("exit", resolve);
    child2.kill("SIGTERM");
  });

  // F22 — invalid limit: exit 1 before bind, error names code/key/source, no raw value.
  {
    const portBad = await freePort();
    const child = spawnServer(
      makeServerEnv({
        PORT: String(portBad),
        ADMIN_PORT: String(portBad + 1),
        WORKSPACE_PATH: serverWs,
        ADMIN_TOKEN: "fixture-admin-token",
        PROJECT_MEMORY_MAX_LINES: "500abc",
      }),
      portBad
    );
    const outcome = await waitExit(child, 30000);
    check("F22", "invalid limit -> exit code 1", outcome.code === 1, "exit 1", JSON.stringify({ code: outcome.code, signal: outcome.signal }));
    const out = outcome.output ?? "";
    check(
      "F22",
      "error names code/key/source",
      out.includes("ERR_PROJECT_MEMORY_LIMIT") && out.includes("maxLines") && out.includes("env"),
      "code+key+source",
      out.slice(0, 400)
    );
    check("F22", "raw input value not printed", !out.includes("500abc"), "no raw value", out.slice(0, 400));
    check("F22", "port was never bound", !(await reachable(portBad)), "not bound", String(await reachable(portBad)));
  }
}

// =====================================================================
// Instruction-shape checks (kept from the original suite)
// =====================================================================
async function runInstructionShapeChecks() {
  const workspaceRoot = process.env.WORKSPACE_PATH || process.cwd();
  const ctx = await buildInstructionContext({
    workspaceRoot,
    workspaceRoots: [workspaceRoot],
    pid: process.pid,
    adminPort: 3001,
  });

  check("T10", "agent prompt in instructions", ctx.instructionsText.includes("Agent workflow"), "present", "missing");
  check("T10", "environment block", ctx.instructionsText.includes("## Environment"), "present", "missing");
  check("T10", "git block", ctx.instructionsText.includes("## Git"), "present", "missing");
  check("T10", "footer pointers", ctx.instructionsText.includes("agent_status"), "present", "missing");
  check("T10", "instruction size > 500 bytes", ctx.instructionBytes >= 500, ">=500", String(ctx.instructionBytes));

  const summary = summarizeInstructionContext(ctx);
  check("T10", "summarizeInstructionContext has root", Boolean(summary.root), "root", JSON.stringify(summary.root));

  console.log("\nGit:", ctx.git.is_repo ? ctx.git.branch : "not a repo");
  console.log(
    "Memory files:",
    ctx.projectMemory.sections.map((s) => s.path).join(", ") || "(none)"
  );
}

// =====================================================================
// Main
// =====================================================================
try {
  await runUnitFixtures();
  await runServerFixtures();
  await runInstructionShapeChecks();
} catch (err) {
  console.error("FATAL", err);
  failed++;
  record("FATAL", "fail", "no fatal error", String(err?.stack || err));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (evidenceDir) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const outFile = path.join(evidenceDir, `project-memory-results-${testTag}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ passed, failed, results }, null, 2));
  console.log(`results -> ${outFile}`);
}
process.exit(failed > 0 ? 1 : 0);
