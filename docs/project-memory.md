# Project memory — limits, truncation and metadata

The host loads a project memory bundle at startup and injects it into every MCP
session's instructions. This document covers the load contract: configuration
sources, validation, line/byte limits, truncation metadata and the health
surface. It also records the maintenance procedure used to change a serving
host — that procedure is never implied by editing this document.

## What counts against the limits

- The byte limit (`PROJECT_MEMORY_MAX_BYTES`, default **32768**) is the total
  UTF-8 byte size of the returned `content` of all project memory sections
  together. It is not the size of the whole MCP instructions, not a token
  count, and not the raw file size.
- The line limit (`PROJECT_MEMORY_MAX_LINES`, default **500**) applies per
  section, after HTML comments are stripped and `@` imports are expanded. A
  section may pull in imported files; the cap applies to the expanded text,
  not per import.
- Agent prompt, Git snapshot, skills block, auto memory and formatting are
  budgeted separately and do not consume the project memory byte budget.
- The loader still reads a file before truncating it: the limits bound how
  much content reaches the instructions, not file I/O size.

## Configuration precedence

For each key, the sources are resolved independently in this order:

1. `opts` passed to the loader (`maxLines` / `maxBytes`), when the key is
   present and not `undefined`;
2. the matching environment variable (`PROJECT_MEMORY_MAX_LINES` /
   `PROJECT_MEMORY_MAX_BYTES`) when set to a non-empty (after trim) value;
3. the default (500 / 32768).

Only the selected source is validated. An invalid environment value is ignored
when a valid `opts` value wins for that key — it must not fail the call.

Accepted values are positive safe integers. For environment strings this means
ASCII digits only: `00500` and ` 500 ` are valid 500, while `+500`, `5e2`,
`500.0`, `500abc`, `0`, `-1`, `Infinity`, `NaN` and anything beyond
`Number.MAX_SAFE_INTEGER` are rejected. A rejected value raises
`ProjectMemoryConfigError` with `code: "ERR_PROJECT_MEMORY_LIMIT"`, the key
(`maxLines` / `maxBytes`), the source (`opts` / `env`) and the fixed message
`Invalid project memory limit: <key> (<source>); expected a positive safe
integer.` — the raw value is never echoed. There is no silent fallback. At
startup a rejected limit exits with code 1 before the MCP/Admin listeners
bind.

## Truncation semantics

For each readable candidate with remaining byte budget, the pipeline is:

1. `S` — content after HTML comment removal, `@` import expansion, then CRLF
   normalization to LF. Blank lines are not collapsed.
2. `L` — the first `maxLines` lines of `S` (`S.split("\n").slice(0,
   maxLines).join("\n")`); a trailing newline's empty split element is kept
   by that split semantics.
3. `P` — the longest prefix of `L` that fits the remaining byte budget and
   ends on a UTF-8 code point boundary. Multibyte characters are never cut in
   the middle, so valid UTF-8 never gains replacement characters (U+FFFD)
   from truncation.
4. `content = P.trim()` (JavaScript `trim`); `content_bytes` is measured on
   the returned content, and only that many bytes are subtracted from the
   budget.

`line_limit` is recorded when `L.trim() !== S.trim()`, `byte_limit` when
`P.trim() !== L.trim()`; reasons are ordered line-then-byte, never duplicated,
and `truncated` is true exactly when a reason exists. Trimming and comment
removal are normal transformations, not truncation — a comment-only file does
not get a `byte_limit` reason however large the raw file is.

Selected candidates that produce no content are recorded internally as
omissions with one of these reasons:

- `byte_budget_exhausted` — the remaining budget was already 0; the candidate
  is skipped without being read just for statistics.
- `empty_after_transform` — nothing left after comments/imports.
- `empty_after_limits` — content existed but emptied out after limits.
- `unreadable` — the file could not be read.

A candidate that empties out does not stop the later candidates.

## Health metadata

The `/health` endpoint (and the admin `/health`) expose, under `instructions`:

- `memory_contract_version` — `clc.project-memory-summary.v1`
- `memory_limits` — `{ max_lines_per_section, max_content_bytes }` actually in
  effect for the startup bundle.
- `memory_limit_sources` — `default` / `env` / `opts` per key, using the same two key names as `memory_limits` (`max_lines_per_section` / `max_content_bytes`).
- `memory_files[]` — `path`, `kind`, `truncated`, `content_bytes`,
  `truncation_reasons`.
- `memory_omitted_counts` — exactly the four omission keys, each a
  non-negative integer. Per-file omission details stay out of the public
  health surface.
- `memory_bytes` — always the sum of `memory_files[].content_bytes`.

`/health` additionally carries `runtime_instance_id` (a random UUID generated
once per boot) and `runtime_pid` (the PID of the process serving MCP). Same
boot keeps both stable; a new boot gets a new UUID. These exist so a probe can
confirm it is talking to the intended instance instead of any HTTP 200.

The metadata describes the bundle loaded at startup; it is not re-read from
disk per health request and it does not hot-reload when environment variables
change afterwards. Start a new instance to pick up new limits.

## Missing-content diagnostics in instructions

When some selected memory files could not contribute content, the formatted
project-memory block tells the agent exactly which case applies:

- no candidate file existed at all — the loader says so and suggests creating
  one;
- a candidate could not be read — reported as unreadable, not as a missing
  file;
- a candidate was empty after comment removal/import expansion;
- a candidate's content was entirely removed by the limits (with the
  truncation reasons);
- a candidate was skipped because the content byte budget was already spent
  (the effective budget is named);
- a loaded section was cut by the line limit, the byte limit, or both — the
  heading carries the specific label.

These notes are instruction formatting only: they never change the selected
section order or content, never raise the budget, and they stay out of the
public health surface (health keeps counts only).

## Maintenance rehearsal tooling

`scripts/deployment-machine.mjs` implements the section-17 state machine
(journal intents before mutations, results after verification, rename-only
slot changes, one candidate start and one baseline start per transition,
baseline rollback judged by the baseline's own schema) against injected
filesystem/service/supervisor/lock adapters — it is the logic an operator
would drive during a coordinated cutover, and it never touches a real host by
itself. `scripts/test-deployment-machine.mjs` (F23) rehearses the mandatory
failure modes against test-owned slot directories and a fake supervisor.
`scripts/test-lib/mcp-test-harness.mjs` is the shared deadline/lifecycle/port
harness used by the server-level tests and the isolated canary.

## Related configuration

- `AUTO_MEMORY_MAX_LINES` / `AUTO_MEMORY_MAX_BYTES` bound the separate
  auto-memory feature and are not affected by the project memory defaults.
- User memory candidates (`~/.chatgpt-local-coder/AGENTS.md`,
  `~/.codex/CLAUDE.md`, `~/.claude/CLAUDE.md`) and project candidates
  (`CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md`, `CLAUDE.local.md`, rules
  under `.claude/rules`) keep the same selection order and first-match
  semantics as before.

## Changing a serving host

Deploying new limits to a host that serves live sessions is a coordinated
maintenance, never a consequence of editing source or docs: it requires a
separate approval for the production switch, an out-of-band operator, a
maintenance receipt (ingress inventory, client acknowledgements, quiescence
check), a release manifest with hashes, a deployment journal with intent
records before every mutation, and a rehearsed rollback to the previous build
judged by the previous build's own health schema. The journal states are
`PLANNED → PREPARED → QUIESCENT → STOPPED → OLD_PRESERVED →
CANDIDATE_PUBLISHED → VERIFIED → COMPLETE`, with `ROLLBACK_REQUIRED →
ROLLED_BACK` (or `MANUAL_RECOVERY_REQUIRED`) on failure, one candidate start
attempt and one baseline start attempt per transition, and no infinite
auto-retry. The delivery plan document for a concrete change carries the full
checklist and evidence package.
