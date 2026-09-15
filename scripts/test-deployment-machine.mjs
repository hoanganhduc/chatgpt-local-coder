/**
 * F23 — deployment state-machine fault-injection rehearsal (REV-R02).
 *
 * Drives the real rehearsal logic (scripts/deployment-machine.mjs) against
 * test-owned temp slot directories, a fake service/supervisor adapter and
 * fault-injected fs/journal adapters. No real systemctl call, no service unit
 * change, no production path is ever referenced. Each subcase is reported
 * individually (F23-01 … F23-10) with pass/fail; every mutation's side effect
 * on the filesystem, adapter counters, journal and locks is asserted, not just
 * log strings.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  DeploymentMachine,
  realFsAdapter,
  memoryJournal,
  memoryLocks,
  sha256OfFile,
} from "./deployment-machine.mjs";

const results = [];
let passed = 0;
let failed = 0;
function record(id, name, status, expected, actual) {
  results.push({ subcase: id, name, status, expected: String(expected), actual: String(actual) });
  console.log(`${status === "pass" ? "OK  " : "FAIL"} ${id} ${name}: expected=${expected} actual=${actual}`);
  status === "pass" ? passed++ : failed++;
}
function check(id, name, cond, expected, actual) {
  record(id, name, cond ? "pass" : "fail", expected, actual);
  return cond;
}

const BASELINE_BODY = "BASELINE-BUILD-v1\n";
const CANDIDATE_BODY = "CANDIDATE-BUILD-v2\n";

class FakeService {
  constructor(faults = {}) {
    this.faults = faults;
    this.state = "running"; // baseline serving when the rehearsal starts
    this.startCount = 0;
    this.stopCount = 0;
    this.restarts = 0;
    this.healthy = true;
    this.currentBuild = "candidate"; // the candidate carries the new schema
  }
  async checkQuiescence() {
    return this.faults.quiescent !== false;
  }
  async stop() {
    if (this.faults.stopFails) throw new Error("injected stop failure");
    this.stopCount += 1;
    this.state = "stopped";
    this.healthy = false;
  }
  async isStopped() {
    if (this.faults.stopUnconfirmed) return false;
    return this.state === "stopped";
  }
  async start() {
    this.startCount += 1;
    this.state = "running";
    if (this.faults.crashLoop) {
      // A supervisor that restarts on its own, observed via counters.
      this.restarts += 1;
      this.healthy = false;
      return;
    }
    if (this.faults.startupFails) {
      this.healthy = false;
      return;
    }
    this.healthy = true;
  }
  async health() {
    if (this.faults.healthFails || !this.healthy) throw new Error("health failed");
    if (this.faults.baselineSchema === true || this.currentBuild === "baseline") {
      // Old schema: no runtime_instance_id, no new metadata fields.
      return { status: "ok", name: "codex-mcp-server", instructions: { memory_files: [] } };
    }
    if (this.faults.wrongIdentity) {
      return { status: "ok", runtime_instance_id: "uuid-wrong", runtime_pid: 999999, instructions: { memory_limits: { max_lines_per_section: 500, max_content_bytes: 32768 }, memory_contract_version: "clc.project-memory-summary.v1" } };
    }
    return {
      status: "ok",
      runtime_instance_id: "11111111-2222-3333-4444-555555555555",
      runtime_pid: 42,
      instructions: {
        memory_limits: { max_lines_per_section: 500, max_content_bytes: 32768 },
        memory_contract_version: "clc.project-memory-summary.v1",
      },
    };
  }
  verifyCandidate(h) {
    return Boolean(
      h?.runtime_instance_id && h?.runtime_pid === 42 &&
      h?.instructions?.memory_limits?.max_lines_per_section === 500
    );
  }
  verifyBaselineSchema(h) {
    // Baseline is accepted by its own (old) schema: no new identity fields.
    return h?.status === "ok" && h?.runtime_instance_id === undefined;
  }
  supervisor() {
    return { restarts: this.restarts, startCount: this.startCount };
  }
}

function faultFs(real, hooks = {}) {
  return {
    rename: (a, b) => {
      if (hooks.failRename && hooks.failRename(a, b)) throw new Error("injected rename failure");
      real.rename(a, b);
    },
    mkdir: real.mkdir,
    copyFile: real.copyFile,
    writeFile: real.writeFile,
    readFile: real.readFile,
    exists: real.exists,
  };
}

function makeScenario({ serviceFaults = {}, fsHooks = {}, journalFault = null, approvalOverrides = null, manifestOverrides = null, lockBusy = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "clc-deploy-"));
  const slots = {
    liveDir: path.join(base, "slots", "live"),
    candidateDir: path.join(base, "slots", "candidate"),
    backupDir: path.join(base, "slots", "backup"),
    failedRuntimesDir: path.join(base, "slots", "failed-runtimes"),
    journalPath: path.join(base, "journal.jsonl"),
    lockPath: path.join(base, "lock.json"),
  };
  for (const d of Object.values(slots).slice(0, 4)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(slots.liveDir, "index.js"), BASELINE_BODY);
  fs.writeFileSync(path.join(slots.candidateDir, "index.js"), CANDIDATE_BODY);
  fs.writeFileSync(path.join(slots.liveDir, "overrides.json"), JSON.stringify({ PROJECT_MEMORY_MAX_LINES: "500", PROJECT_MEMORY_MAX_BYTES: "32768" }));

  const manifest = {
    deployment_id: "deploy-test-1",
    source_sha: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    baseline_live_sha256: sha256OfFile(path.join(slots.liveDir, "index.js")),
    candidate_sha256: sha256OfFile(path.join(slots.candidateDir, "index.js")),
    ...(manifestOverrides ?? {}),
  };
  const approval = {
    schema: "clc.memory-maintenance.v1",
    plan_sha256: "8ad39507fd7fe06154c7a5bd8e0d9f21a6995bacefec9a1fde98a909fe20cf6f",
    candidate_source_sha: manifest.source_sha,
    service_identity: "chatgpt-local-coder.service",
    operator: "test-operator",
    approval_ref_C: "ref-C-test",
    ingress_inventory_ref: "inv-1",
    client_ack_refs: ["ack-1"],
    job_inventory_ref: "jobs-1",
    quiescence_verified_at: new Date(Date.now() - 60000).toISOString(),
    cutover_expires_at: new Date(Date.now() + 3600000).toISOString(),
    out_of_band_control_ref: "oob-1",
    admission_pause_method: "manual-operator",
    resume_owner: "test-operator",
    state: "approved",
    ...(approvalOverrides ?? {}),
  };
  const service = new FakeService(serviceFaults);
  const journal = journalFault ?? memoryJournal(slots.journalPath);
  const locks = memoryLocks();
  if (lockBusy) locks.acquire(manifest.deployment_id, "someone-else");
  const machine = new DeploymentMachine({
    slots,
    manifest,
    service,
    fsadapter: faultFs(realFsAdapter(), fsHooks),
    journal,
    locks,
    now: () => Date.now(),
    startup: { deadlineMs: 600, healthTimeoutMs: 300, pollMs: 10, samples: 100 },
  });
  const hashes = () => ({
    live: fs.existsSync(path.join(slots.liveDir, "index.js")) ? sha256OfFile(path.join(slots.liveDir, "index.js")) : null,
    backup: fs.existsSync(path.join(slots.backupDir, "index.js")) ? sha256OfFile(path.join(slots.backupDir, "index.js")) : null,
    candidate: fs.existsSync(path.join(slots.candidateDir, "index.js")) ? sha256OfFile(path.join(slots.candidateDir, "index.js")) : null,
  });
  return { base, slots, manifest, approval, service, journal, locks, machine, hashes };
}

const okApproval = () => null;

async function happyPath(scenario) {
  const s = scenario;
  const r = {};
  r.plan = s.machine.plan(s.approval, "runner-1");
  if (r.plan !== "PREPARED") return r;
  r.prepare = s.machine.prepare();
  r.quiesce = await s.machine.quiesce();
  r.stop = await s.machine.stop();
  r.preserve = s.machine.preserve();
  r.publish = s.machine.publish();
  r.verify = await s.machine.verifyCandidate();
  r.complete = s.machine.complete();
  return r;
}

// ---------------------------------------------------------------------------
// F23-01 — missing/invalid approval, manifest or lock: BLOCKED_BEFORE_STOP,
//          zero stop/rename/start side effects.
for (const [label, overrides] of [
  ["missing approval", { missing: true }],
  ["wrong receipt schema", { approvalOverrides: { schema: "other-schema.v1" } }],
  ["receipt pending", { approvalOverrides: { state: "pending" } }],
  ["receipt expired", { approvalOverrides: { cutover_expires_at: new Date(Date.now() - 1000).toISOString() } }],
  ["no client acks", { approvalOverrides: { client_ack_refs: [] } }],
  ["lock busy", { lockBusy: true }],
]) {
  const s = makeScenario(overrides.missing ? {} : overrides);
  const approval = overrides.missing ? null : s.approval;
  const state = s.machine.plan(approval, "runner-1");
  const h = s.hashes();
  check(
    "F23-01",
    `${label} -> BLOCKED_BEFORE_STOP, no stop/rename/start`,
    state === "BLOCKED_BEFORE_STOP" &&
      s.service.startCount === 0 &&
      s.service.state === "running" &&
      h.live === s.manifest.baseline_live_sha256 &&
      h.backup === null &&
      h.candidate === s.manifest.candidate_sha256,
    "BLOCKED_BEFORE_STOP + no side effects",
    JSON.stringify({ state, startCount: s.service.startCount, serviceState: s.service.state, hashes: h })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// manifest hash mismatch at prepare: BLOCKED_BEFORE_STOP before any stop.
{
  const s = makeScenario();
  s.machine.plan(s.approval, "runner-1");
  fs.writeFileSync(path.join(s.slots.candidateDir, "index.js"), "WRONG-CANDIDATE\n");
  const state = s.machine.prepare();
  check(
    "F23-01",
    "candidate hash mismatch at prepare -> BLOCKED_BEFORE_STOP, service never stopped",
    state === "BLOCKED_BEFORE_STOP" && s.service.state === "running" && s.service.startCount === 0,
    "BLOCKED_BEFORE_STOP",
    JSON.stringify({ state, serviceState: s.service.state })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-02 — stop not confirmed: no rename of the live slot.
{
  const s = makeScenario({ serviceFaults: { stopUnconfirmed: true } });
  s.machine.plan(s.approval, "runner-1");
  s.machine.prepare();
  await s.machine.quiesce();
  const state = await s.machine.stop();
  const h = s.hashes();
  check(
    "F23-02",
    "unconfirmed stop -> still QUIESCENT, live slot untouched, no rename",
    state === "QUIESCENT" && h.live === s.manifest.baseline_live_sha256 && h.backup === null,
    "QUIESCENT, live intact",
    JSON.stringify({ state, hashes: h })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-03 — journal failures: resume reconciles FILESYSTEM + SERVICE evidence,
//          never the journal blindly.
// (a) rename performed but the journal result flush was lost.
{
  const s = makeScenario({ journalFault: null });
  s.machine.plan(s.approval, "runner-1");
  s.machine.prepare();
  await s.machine.quiesce();
  await s.machine.stop();
  // Fault: rename succeeds, but the result record is never flushed because we
  // swap the journal sink right after the intent.
  let flushed = 0;
  const realAppend = s.journal.append.bind(s.journal);
  s.journal.append = (r) => {
    realAppend(r);
    if (r.transition === "preserve" && r.intent_or_result === "result") {
      throw new Error("injected journal write failure after rename");
    }
  };
  try {
    s.machine.preserve();
  } catch {
    // The crash point: result record lost; machine instance is gone.
  }
  // Fresh machine, fresh journal: reconcile from the filesystem alone.
  const s2 = makeScenario({ serviceFaults: {} });
  // Rebuild the SAME slots into scenario 2's machine.
  const journal2 = memoryJournal(s.slots.journalPath);
  const machine2 = new DeploymentMachine({
    slots: s.slots,
    manifest: s.manifest,
    service: s.service,
    fsadapter: realFsAdapter(),
    journal: journal2,
    locks: s.locks,
    now: () => Date.now(),
    startup: { deadlineMs: 600, healthTimeoutMs: 300, pollMs: 10, samples: 100 },
  });
  const state = machine2.resume();
  const h = {
    live: fs.existsSync(path.join(s.slots.liveDir, "index.js")) ? sha256OfFile(path.join(s.slots.liveDir, "index.js")) : null,
  };
  check(
    "F23-03",
    "rename done but journal result lost -> resume restores baseline from FS evidence",
    state === "QUIESCENT" && h.live === s.manifest.baseline_live_sha256,
    "QUIESCENT + live==baseline by hash",
    JSON.stringify({ state, liveHash: h.live })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
  fs.rmSync(s2.base, { recursive: true, force: true });
}
// (b) journal claims a state the filesystem contradicts.
{
  const s = makeScenario();
  s.machine.plan(s.approval, "runner-1");
  // Lie: append a journal record claiming CANDIDATE_PUBLISHED although the
  // slots still hold live=baseline and candidate unpublished.
  s.journal.append({
    deployment_id: s.manifest.deployment_id,
    sequence: 99,
    time_utc: new Date().toISOString(),
    transition: "publish",
    intent_or_result: "result",
    source_state: "OLD_PRESERVED",
    target_state: "CANDIDATE_PUBLISHED",
    path_hashes: {},
    observed_service_state: null,
    result: "ok",
    evidence_ref: null,
  });
  s.journal.flush();
  const state = s.machine.resume();
  check(
    "F23-03",
    "journal claim contradicted by filesystem -> FS wins (no-runtime-change)",
    state === "BLOCKED_BEFORE_STOP" && s.service.startCount === 0,
    "BLOCKED_BEFORE_STOP, no start",
    JSON.stringify({ state, startCount: s.service.startCount })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-04 — failure after live→backup / before candidate→live: baseline is
//          preserved; ambiguous backup hash ends in MANUAL_RECOVERY_REQUIRED.
{
  const s = makeScenario({
    fsHooks: { failRename: (a) => a.includes("candidate") },
  });
  s.machine.plan(s.approval, "runner-1");
  s.machine.prepare();
  await s.machine.quiesce();
  await s.machine.stop();
  s.machine.preserve();
  const state = s.machine.publish();
  check(
    "F23-04",
    "candidate→live rename fails -> ROLLBACK_REQUIRED, backup holds baseline",
    state === "ROLLBACK_REQUIRED" &&
      sha256OfFile(path.join(s.slots.backupDir, "index.js")) === s.manifest.baseline_live_sha256,
    "ROLLBACK_REQUIRED + backup preserved",
    JSON.stringify({ state, backupHash: s.hashes().backup })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Corruption between prepare and preserve: backup ends with a foreign hash.
  const s = makeScenario();
  s.machine.plan(s.approval, "runner-1");
  s.machine.prepare();
  await s.machine.quiesce();
  await s.machine.stop();
  // Sabotage the live file right before preserve (simulates an unknown hash).
  fs.writeFileSync(path.join(s.slots.liveDir, "index.js"), "MYSTERY-BUILD\n");
  const state = s.machine.preserve();
  check(
    "F23-04",
    "unknown backup hash -> MANUAL_RECOVERY_REQUIRED",
    state === "MANUAL_RECOVERY_REQUIRED",
    "MANUAL_RECOVERY_REQUIRED",
    JSON.stringify({ state })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-05 — failure after candidate publish: rollback order correct, failed
//          runtime kept as evidence, backup not overwritten.
{
  const s = makeScenario({ serviceFaults: { healthFails: true } });
  const r = await happyPath(s);
  // The candidate failure was already recorded by verify; the baseline for
  // the rollback starts healthy and is judged by its own old schema.
  s.service.faults.healthFails = false;
  s.service.currentBuild = "baseline";
  const rb = await s.machine.rollback();
  const failedEvidence = path.join(s.slots.failedRuntimesDir, s.manifest.deployment_id, "candidate-index.js");
  const h = s.hashes();
  const overrides = JSON.parse(fs.readFileSync(path.join(s.slots.liveDir, "overrides.json"), "utf-8"));
  const trace = s.machine.opTrace.map((t) => `${t.transition}:${t.intent_or_result}`).join(">");
  check(
    "F23-05",
    "post-publish failure -> ROLLED_BACK, evidence kept, backup restored, overrides restored",
    r.verify === "ROLLBACK_REQUIRED" &&
      rb === "ROLLED_BACK" &&
      fs.existsSync(failedEvidence) &&
      sha256OfFile(failedEvidence) === s.manifest.candidate_sha256 &&
      h.live === s.manifest.baseline_live_sha256 &&
      h.backup === null &&
      overrides.PROJECT_MEMORY_MAX_LINES === "200",
    "ROLLED_BACK + evidence + hashes + overrides",
    JSON.stringify({ verify: r.verify, rollback: rb, failedEvidence: fs.existsSync(failedEvidence), hashes: h, overrides, trace })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-06 — candidate startup fail / deadline fail / wrong schema / wrong
//          identity: ROLLBACK_REQUIRED per contract.
for (const [label, faults] of [
  ["startup failure", { startupFails: true }],
  ["health deadline exceeded", { healthFails: true }],
  ["wrong schema", { baselineSchema: true }],
  ["wrong identity", { wrongIdentity: true }],
]) {
  const s = makeScenario({ serviceFaults: faults });
  const r = await happyPath(s);
  check(
    "F23-06",
    `${label} -> ROLLBACK_REQUIRED`,
    r.verify === "ROLLBACK_REQUIRED",
    "ROLLBACK_REQUIRED",
    JSON.stringify(r)
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-07 — supervisor-triggered crash/restart is OBSERVED via counters and
//          fails verification; a single start request must not mask it.
{
  const s = makeScenario({ serviceFaults: { crashLoop: true } });
  const r = await happyPath(s);
  check(
    "F23-07",
    "supervisor restart observed -> ROLLBACK_REQUIRED",
    r.verify === "ROLLBACK_REQUIRED" && s.service.restarts > 0,
    "ROLLBACK_REQUIRED with observed restarts",
    JSON.stringify({ verify: r.verify, restarts: s.service.restarts, startCount: s.service.startCount })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-08 — baseline without new metadata: rollback accepted by the BASELINE
//          schema (no runtime_instance_id required).
{
  const s = makeScenario({ serviceFaults: { startupFails: true } });
  const r = await happyPath(s);
  // After the failed candidate, the baseline must be able to start healthy
  // and is judged by its own old schema.
  s.service.faults.startupFails = false;
  s.service.currentBuild = "baseline";
  const rb = await s.machine.rollback();
  check(
    "F23-08",
    "rollback judged by baseline schema -> ROLLED_BACK",
    rb === "ROLLED_BACK",
    "ROLLED_BACK via old schema",
    JSON.stringify({ rollback: rb })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-09 — rollback startup failure / foreign hashes / lost slots / unclear
//          prior start: MANUAL_RECOVERY_REQUIRED, never an infinite loop.
for (const [label, setup] of [
  ["baseline start fails during rollback", (s) => { s.service.faults.startupFails = true; }],
  ["backup hash foreign at rollback", (s) => { fs.writeFileSync(path.join(s.slots.backupDir, "index.js"), "FOREIGN\n"); }],
]) {
  const s = makeScenario({ serviceFaults: { startupFails: true } });
  const r = await happyPath(s);
  s.service.currentBuild = "baseline";
  if (label === "backup hash foreign at rollback") setup(s);
  const rb = await s.machine.rollback();
  check(
    "F23-09",
    `${label} -> MANUAL_RECOVERY_REQUIRED`,
    rb === "MANUAL_RECOVERY_REQUIRED" && s.service.startCount <= 2,
    "MANUAL_RECOVERY_REQUIRED, bounded starts",
    JSON.stringify({ rollback: rb, startCount: s.service.startCount })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Lost slots: both live and backup gone before resume.
  const s = makeScenario();
  fs.rmSync(path.join(s.slots.liveDir, "index.js"));
  if (fs.existsSync(path.join(s.slots.backupDir, "index.js"))) {
    fs.rmSync(path.join(s.slots.backupDir, "index.js"));
  }
  const state = s.machine.resume();
  check(
    "F23-09",
    "lost live+backup slots -> MANUAL_RECOVERY_REQUIRED",
    state === "MANUAL_RECOVERY_REQUIRED",
    "MANUAL_RECOVERY_REQUIRED",
    JSON.stringify({ state })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Unclear prior start: live holds the candidate, but the service may have
  // already been started once.
  const s = makeScenario();
  s.machine.plan(s.approval, "runner-1");
  s.machine.prepare();
  // Force the FS into candidate-published state.
  fs.writeFileSync(path.join(s.slots.backupDir, "index.js"), BASELINE_BODY);
  fs.rmSync(path.join(s.slots.liveDir, "index.js"));
  fs.writeFileSync(path.join(s.slots.liveDir, "index.js"), CANDIDATE_BODY);
  s.service.startCount = 1; // may or may not be the candidate start
  const state = s.machine.resume();
  check(
    "F23-09",
    "unclear prior start -> MANUAL_RECOVERY_REQUIRED (no replay)",
    state === "MANUAL_RECOVERY_REQUIRED",
    "MANUAL_RECOVERY_REQUIRED",
    JSON.stringify({ state })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-10 — crash/resume and repeated operations: op trace, start counts, slot
//          hashes, journal and lock ownership; no repeated rename/start.
{
  const s = makeScenario();
  const r = await happyPath(s);
  const trace = s.machine.opTrace.map((t) => t.transition);
  const stopCount = s.service.stopCount;
  const verifyAgain = await s.machine.verifyCandidate();
  const lockHeld = s.locks.verify(s.manifest.deployment_id);
  const journalLines = fs.readFileSync(s.slots.journalPath, "utf-8").trim().split("\n").length;
  check(
    "F23-10",
    "happy path completes with correct trace; re-verify is refused without a second start",
    r.complete === "COMPLETE" &&
      r.verify === "VERIFIED" &&
      stopCount === 1 &&
      s.service.startCount === 1 &&
      verifyAgain === "COMPLETE" &&
      s.service.startCount === 1 &&
      lockHeld === true &&
      journalLines >= 10 &&
      trace.indexOf("preserve") < trace.indexOf("publish") &&
      trace.indexOf("publish") < trace.indexOf("verify") &&
      trace.indexOf("verify") < trace.indexOf("complete"),
    "COMPLETE, 1 stop/1 start, refused re-verify, ordered trace, journal+lock ok",
    JSON.stringify({ r, verifyAgain, startCount: s.service.startCount, stopCount, lockHeld, journalLines, trace })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (process.env.CLC_EVIDENCE_DIR) {
  const out = path.join(
    process.env.CLC_EVIDENCE_DIR,
    `deployment-machine-results-${process.env.CLC_TEST_TAG || "run"}.json`
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ passed, failed, results }, null, 2));
  console.log(`results -> ${out}`);
}
process.exit(failed > 0 ? 1 : 0);
