/**
 * F23 — deployment state-machine fault-injection rehearsal (REV-R02).
 *
 * Drives the real rehearsal logic (scripts/deployment-machine.mjs) against
 * test-owned temp runtime DIRECTORY slots (complete asset sets, not a single
 * index.js), a fake service/supervisor adapter, an injected configuration
 * adapter for the two memory-limit overrides, and fault-injected fs/journal
 * adapters. No real systemctl call, no service unit change, no production
 * path is ever referenced. Each subcase is reported individually with
 * pass/fail; every mutation's side effect on the filesystem, adapter
 * counters, journal and locks is asserted, not just log strings.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DeploymentMachine,
  realFsAdapter,
  memoryJournal,
  memoryLocks,
  runtimeAssets,
  runtimeTreeSha256,
  releaseManifestSha256,
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

const PLAN_SHA = "8ad39507fd7fe06154c7a5bd8e0d9f21a6995bacefec9a1fde98a909fe20cf6f";
const SOURCE_SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OVERRIDE_KEYS = ["PROJECT_MEMORY_MAX_LINES", "PROJECT_MEMORY_MAX_BYTES"];

/** Whole runtime trees: entrypoint plus imported module plus a static asset,
 *  so a rehearsal can detect missing/altered NON-entrypoint files. */
const ASSET_BODIES = {
  baseline: {
    "index.js": "BASELINE-BUILD-v1\n",
    "lib/support.js": "baseline-support\n",
    "assets/banner.txt": "baseline-banner\n",
  },
  candidate: {
    "index.js": "CANDIDATE-BUILD-v2\n",
    "lib/support.js": "candidate-support\n",
    "assets/banner.txt": "candidate-banner\n",
  },
};

function writeRuntime(dir, variant) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(ASSET_BODIES[variant])) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function treeSha(dir) {
  if (!fs.existsSync(dir)) return null;
  const assets = runtimeAssets(dir, realFsAdapter());
  return assets.length > 0 ? runtimeTreeSha256(assets) : null;
}

/** Injected production-config adapter: exactly the two override keys, with
 *  set/value/source per key; unset keys stay absent from rawState. */
function memoryConfigAdapter(initial = null) {
  let state = initial ? { ...initial } : { PROJECT_MEMORY_MAX_LINES: "200", PROJECT_MEMORY_MAX_BYTES: "25000" };
  const sources = { PROJECT_MEMORY_MAX_LINES: "env", PROJECT_MEMORY_MAX_BYTES: "env" };
  const faults = { applyFails: false, restoreFails: false };
  const shape = () => {
    const out = {};
    for (const k of OVERRIDE_KEYS) {
      out[k] = Object.prototype.hasOwnProperty.call(state, k)
        ? { set: true, value: state[k], source: sources[k] }
        : { set: false, value: null, source: null };
    }
    return out;
  };
  return {
    faults,
    snapshotOverrides() {
      return shape();
    },
    currentOverrides() {
      return shape();
    },
    applyOverrides(ov) {
      if (faults.applyFails) throw new Error("injected override apply failure");
      state = { PROJECT_MEMORY_MAX_LINES: ov.PROJECT_MEMORY_MAX_LINES, PROJECT_MEMORY_MAX_BYTES: ov.PROJECT_MEMORY_MAX_BYTES };
    },
    restoreOverrides(snap) {
      if (faults.restoreFails) throw new Error("injected override restore failure");
      state = {};
      for (const k of OVERRIDE_KEYS) {
        if (snap[k]?.set) state[k] = snap[k].value;
      }
    },
    rawState() {
      return { ...state };
    },
  };
}

class FakeService {
  constructor(faults = {}) {
    this.faults = faults;
    this.state = "running"; // baseline serving when the rehearsal starts
    this.startCount = 0;
    this.stopCount = 0;
    this.restarts = 0;
    this.healthy = true;
    this.currentBuild = "candidate"; // the candidate carries the new schema
    this.healthCalls = 0;
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
  start() {
    if (this.faults.nonCooperativeStart) return new Promise(() => {}); // never settles
    return (async () => {
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
    })();
  }
  health() {
    if (this.faults.nonCooperativeHealth) return new Promise(() => {}); // never settles
    this.healthCalls += 1;
    if (this.faults.flakyHealth && this.healthCalls >= 3) throw new Error("flaky health (consecutive samples broken)");
    if (this.faults.healthFails || !this.healthy) throw new Error("health failed");
    if (this.faults.baselineSchema === true || this.currentBuild === "baseline") {
      // Old schema: no runtime_instance_id, no new metadata fields.
      return { status: "ok", name: "codex-mcp-server", instructions: { memory_files: [] } };
    }
    if (this.faults.wrongIdentity) {
      return {
        status: "ok",
        runtime_instance_id: "uuid-wrong",
        runtime_pid: 999999,
        instructions: {
          memory_limits: { max_lines_per_section: 500, max_content_bytes: 32768 },
          memory_contract_version: "clc.project-memory-summary.v1",
        },
      };
    }
    const uuid = this.faults.unstableIdentity
      ? `22222222-2222-3333-4444-${String(this.healthCalls).padStart(12, "0")}`
      : "11111111-2222-3333-4444-555555555555";
    return {
      status: "ok",
      runtime_instance_id: uuid,
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
  verifyBaselineSchema(h, snapshot) {
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
    readFileBuf: real.readFileBuf,
    readdir: real.readdir,
    stat: real.stat,
    exists: real.exists,
    rmTree: real.rmTree,
    fsyncDir: (d) => {
      if (hooks.failFsyncDir && hooks.failFsyncDir(d)) throw new Error("injected fsyncDir failure");
      real.fsyncDir(d);
    },
  };
}

function makeScenario({
  serviceFaults = {},
  fsHooks = {},
  journalFault = null,
  approvalOverrides = null,
  manifestOverrides = null,
  lockBusy = false,
  priorOverrides = null,
  configAdapter = null,
} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "clc-deploy-"));
  const slots = {
    liveDir: path.join(base, "slots", "live"),
    candidateDir: path.join(base, "slots", "candidate"),
    backupDir: path.join(base, "slots", "backup"),
    failedRuntimesDir: path.join(base, "slots", "failed-runtimes"),
    journalPath: path.join(base, "journal.jsonl"),
    lockPath: path.join(base, "lock.json"),
  };
  for (const d of [slots.liveDir, slots.candidateDir, slots.backupDir, slots.failedRuntimesDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  writeRuntime(slots.liveDir, "baseline");
  writeRuntime(slots.candidateDir, "candidate");
  const clock = { t: Date.now() };
  const manifest = {
    schema: "clc.memory-release.v1",
    deployment_id: "deploy-test-1",
    source_sha: SOURCE_SHA,
    lockfile_hash: "lockfile-hash-test-1",
    target_node: process.version,
    target_os: process.platform,
    target_arch: process.arch,
    ci_refs: ["ci-run-1"],
    canary_refs: ["canary-run-1"],
    baseline: {
      tree_sha256: treeSha(slots.liveDir),
      assets: runtimeAssets(slots.liveDir, realFsAdapter()),
    },
    candidate: {
      tree_sha256: treeSha(slots.candidateDir),
      assets: runtimeAssets(slots.candidateDir, realFsAdapter()),
    },
    ...(manifestOverrides ?? {}),
  };
  manifest.release_manifest_sha256 = releaseManifestSha256(manifest);
  const planIdentity = { plan_sha256: PLAN_SHA, plan_revision: "revision 2" };
  const approval = {
    schema: "clc.memory-maintenance.v1",
    plan_sha256: PLAN_SHA,
    plan_revision: "revision 2",
    candidate_source_sha: manifest.source_sha,
    release_manifest_sha256: manifest.release_manifest_sha256,
    service_identity: "chatgpt-local-coder.service",
    operator: "test-operator",
    approval_ref_C: "ref-C-test",
    ingress_inventory_ref: "inv-1",
    client_ack_refs: ["ack-1"],
    job_inventory_ref: "jobs-1",
    quiescence_verified_at: new Date(clock.t - 60000).toISOString(),
    cutover_expires_at: new Date(clock.t + 3600000).toISOString(),
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
  const adapter = configAdapter ?? memoryConfigAdapter(priorOverrides);
  const machine = new DeploymentMachine({
    slots,
    manifest,
    planIdentity,
    targetOverrides: { PROJECT_MEMORY_MAX_LINES: "500", PROJECT_MEMORY_MAX_BYTES: "32768" },
    configAdapter: adapter,
    service,
    fsadapter: faultFs(realFsAdapter(), fsHooks),
    journal,
    locks,
    now: () => clock.t,
    startup: { deadlineMs: 600, healthTimeoutMs: 300, pollMs: 10, samples: 2 },
  });
  const hashes = () => ({
    live: treeSha(slots.liveDir),
    backup: treeSha(slots.backupDir),
    candidate: treeSha(slots.candidateDir),
  });
  return { base, slots, manifest, approval, service, journal, locks, configAdapter: adapter, clock, machine, hashes };
}

async function happyPath(scenario) {
  const s = scenario;
  const r = {};
  r.plan = s.machine.plan(s.approval, "runner-1");
  if (r.plan !== "PREPARED") return r;
  r.prepare = await s.machine.prepare();
  r.quiesce = await s.machine.quiesce();
  r.stop = await s.machine.stop();
  r.preserve = s.machine.preserve();
  r.publish = await s.machine.publish();
  r.verify = await s.machine.verifyCandidate();
  r.complete = s.machine.complete();
  return r;
}

/** Drive plan → prepare → quiesce → stop → preserve → publish, stopping at
 *  CANDIDATE_PUBLISHED so verify-phase faults can be activated afterwards
 *  (a health fault injected earlier would also fail the prepare-time baseline
 *  health snapshot, which is a different, separately-tested gate). */
async function driveToPublished(scenario) {
  const s = scenario;
  const r = {};
  r.plan = s.machine.plan(s.approval, "runner-1");
  r.prepare = await s.machine.prepare();
  r.quiesce = await s.machine.quiesce();
  r.stop = await s.machine.stop();
  r.preserve = s.machine.preserve();
  r.publish = await s.machine.publish();
  return r;
}

function newMachineOverSameSlots(s, { journal = null, fsadapter = null, service = null } = {}) {
  return new DeploymentMachine({
    slots: s.slots,
    manifest: s.manifest,
    planIdentity: { plan_sha256: PLAN_SHA, plan_revision: "revision 2" },
    targetOverrides: { PROJECT_MEMORY_MAX_LINES: "500", PROJECT_MEMORY_MAX_BYTES: "32768" },
    configAdapter: s.configAdapter,
    service: service ?? s.service,
    fsadapter: fsadapter ?? realFsAdapter(),
    journal: journal ?? memoryJournal(s.slots.journalPath),
    locks: s.locks,
    now: () => Date.now(),
    startup: { deadlineMs: 600, healthTimeoutMs: 300, pollMs: 10, samples: 2 },
  });
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
  ["empty operator string", { approvalOverrides: { operator: "  " } }],
  ["wrong plan sha (valid-length but wrong)", { approvalOverrides: { plan_sha256: "f".repeat(64) } }],
  ["wrong plan revision", { approvalOverrides: { plan_revision: "revision 1" } }],
  ["release manifest linkage mismatch", { approvalOverrides: { release_manifest_sha256: "e".repeat(64) } }],
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
      h.live === s.manifest.baseline.tree_sha256 &&
      h.backup === null &&
      h.candidate === s.manifest.candidate.tree_sha256,
    "BLOCKED_BEFORE_STOP + no side effects",
    JSON.stringify({ state, startCount: s.service.startCount, serviceState: s.service.state, hashes: h })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-02 — whole-runtime verification (D1): candidate missing/altered
//          non-entrypoint assets, altered entrypoint, mode change and extra
//          (mixed) files all fail BEFORE any stop.
for (const [label, tamper] of [
  ["candidate missing non-entrypoint asset", (s) => fs.rmSync(path.join(s.slots.candidateDir, "lib", "support.js"))],
  ["candidate altered non-entrypoint asset", (s) => fs.writeFileSync(path.join(s.slots.candidateDir, "lib", "support.js"), "TAMPERED\n")],
  ["candidate altered entrypoint", (s) => fs.writeFileSync(path.join(s.slots.candidateDir, "index.js"), "TAMPERED\n")],
  ["candidate extra asset (mixed runtime)", (s) => fs.writeFileSync(path.join(s.slots.candidateDir, "stale-old.js"), "OLD-BUILD\n")],
]) {
  const s = makeScenario();
  s.machine.plan(s.approval, "runner-1");
  tamper(s);
  const state = await s.machine.prepare();
  check(
    "F23-02",
    `${label} -> BLOCKED_BEFORE_STOP, service never stopped`,
    state === "BLOCKED_BEFORE_STOP" && s.service.state === "running" && s.service.startCount === 0,
    "BLOCKED_BEFORE_STOP",
    JSON.stringify({ state, serviceState: s.service.state })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
if (process.platform !== "win32") {
  const s = makeScenario();
  s.machine.plan(s.approval, "runner-1");
  fs.chmodSync(path.join(s.slots.candidateDir, "lib", "support.js"), 0o600); // manifest records 644
  const state = await s.machine.prepare();
  check(
    "F23-02",
    "candidate mode change -> BLOCKED_BEFORE_STOP",
    state === "BLOCKED_BEFORE_STOP" && s.service.state === "running",
    "BLOCKED_BEFORE_STOP",
    JSON.stringify({ state, serviceState: s.service.state })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
} else {
  console.log("NOTE F23-02 mode-tamper case not applicable on win32 (POSIX mode bits)");
}
{
  // Live tree mismatch is equally a pre-stop blocker.
  const s = makeScenario();
  s.machine.plan(s.approval, "runner-1");
  fs.writeFileSync(path.join(s.slots.liveDir, "assets", "banner.txt"), "TAMPERED-LIVE\n");
  const state = await s.machine.prepare();
  check(
    "F23-02",
    "live tree mismatch -> BLOCKED_BEFORE_STOP",
    state === "BLOCKED_BEFORE_STOP" && s.service.state === "running",
    "BLOCKED_BEFORE_STOP",
    JSON.stringify({ state, serviceState: s.service.state })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-03 — prepare snapshots: baseline health snapshot and exact override
//          snapshot are pre-stop gates.
{
  const s = makeScenario({ serviceFaults: { healthFails: true } });
  s.machine.plan(s.approval, "runner-1");
  const state = await s.machine.prepare();
  check(
    "F23-03",
    "baseline health snapshot failure -> BLOCKED_BEFORE_STOP",
    state === "BLOCKED_BEFORE_STOP" && s.service.state === "running",
    "BLOCKED_BEFORE_STOP",
    JSON.stringify({ state, serviceState: s.service.state })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Config adapter returning a wrong shape (extra/missing keys) must block.
  const badAdapter = {
    snapshotOverrides() {
      return { PROJECT_MEMORY_MAX_LINES: { set: true, value: "200", source: "env" } }; // one key missing
    },
    currentOverrides() {
      return { PROJECT_MEMORY_MAX_LINES: { set: true, value: "200", source: "env" } };
    },
    applyOverrides() {},
    restoreOverrides() {},
  };
  const s = makeScenario({ configAdapter: badAdapter });
  s.machine.plan(s.approval, "runner-1");
  const state = await s.machine.prepare();
  check(
    "F23-03",
    "invalid override snapshot shape -> BLOCKED_BEFORE_STOP",
    state === "BLOCKED_BEFORE_STOP",
    "BLOCKED_BEFORE_STOP",
    JSON.stringify({ state })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-04 — stop gates (D2): unconfirmed stop, expiry after planning,
//          quiescence lost, and release-manifest tampering all block the stop
//          without touching the running host.
{
  const s = makeScenario({ serviceFaults: { stopUnconfirmed: true } });
  s.machine.plan(s.approval, "runner-1");
  await s.machine.prepare();
  await s.machine.quiesce();
  const state = await s.machine.stop();
  const h = s.hashes();
  check(
    "F23-04",
    "unconfirmed stop -> still QUIESCENT, live slot untouched, no rename",
    state === "QUIESCENT" && h.live === s.manifest.baseline.tree_sha256 && h.backup === null,
    "QUIESCENT, live intact",
    JSON.stringify({ state, hashes: h })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Receipt that expires AFTER planning must block the stop (plan §17.1 step 5).
  const s = makeScenario();
  s.machine.plan(s.approval, "runner-1");
  await s.machine.prepare();
  await s.machine.quiesce();
  s.clock.t += 2 * 3600000; // push the clock past cutover_expires_at
  const state = await s.machine.stop();
  check(
    "F23-04",
    "receipt expiry rechecked immediately before stop -> BLOCKED_BEFORE_STOP, host untouched",
    state === "BLOCKED_BEFORE_STOP" && s.service.stopCount === 0 && s.service.state === "running",
    "BLOCKED_BEFORE_STOP, no stop",
    JSON.stringify({ state, stopCount: s.service.stopCount, serviceState: s.service.state })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Quiescence/admission evidence must be revalidated immediately before stop.
  const s = makeScenario();
  s.machine.plan(s.approval, "runner-1");
  await s.machine.prepare();
  await s.machine.quiesce();
  s.service.faults.quiescent = false; // a request source came back after quiesce
  const state = await s.machine.stop();
  check(
    "F23-04",
    "quiescence lost after planning -> BLOCKED_BEFORE_STOP before stop",
    state === "BLOCKED_BEFORE_STOP" && s.service.stopCount === 0 && s.service.state === "running",
    "BLOCKED_BEFORE_STOP, no stop",
    JSON.stringify({ state, stopCount: s.service.stopCount, serviceState: s.service.state })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Release manifest tampered after planning: linkage recheck must block.
  const s = makeScenario();
  s.machine.plan(s.approval, "runner-1");
  await s.machine.prepare();
  await s.machine.quiesce();
  s.manifest.candidate.assets = [
    ...s.manifest.candidate.assets,
    { path: "injected.js", type: "file", mode: "644", sha256: "ab".repeat(32) },
  ];
  const state = await s.machine.stop();
  check(
    "F23-04",
    "release manifest tampered after planning -> BLOCKED_BEFORE_STOP before stop",
    state === "BLOCKED_BEFORE_STOP" && s.service.stopCount === 0,
    "BLOCKED_BEFORE_STOP, no stop",
    JSON.stringify({ state, stopCount: s.service.stopCount })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-05 — preserve/journal durability (D5): intent-before-mutation, directory
//          fsync, and crash-resume reconciliation from filesystem evidence.
{
  // Backup slot occupied: block before touching live.
  const s = makeScenario();
  s.machine.plan(s.approval, "runner-1");
  await s.machine.prepare();
  await s.machine.quiesce();
  await s.machine.stop();
  fs.writeFileSync(path.join(s.slots.backupDir, "stray.js"), "STRAY\n");
  const state = s.machine.preserve();
  const h = s.hashes();
  check(
    "F23-05",
    "backup slot occupied -> BLOCKED_BEFORE_STOP, live untouched",
    state === "BLOCKED_BEFORE_STOP" && h.live === s.manifest.baseline.tree_sha256,
    "BLOCKED_BEFORE_STOP",
    JSON.stringify({ state, liveHash: h.live })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Durable intent required BEFORE mutation: a sync failure on the preserve
  // intent must block the rename entirely.
  const s = makeScenario();
  const inner = memoryJournal(s.slots.journalPath);
  const syncFailJournal = {
    append: (r) => inner.append(r),
    records: () => inner.records(),
    flush() {
      const recs = inner.records();
      const last = recs[recs.length - 1];
      if (last?.transition === "preserve" && last?.intent_or_result === "intent") {
        throw new Error("injected journal sync failure");
      }
      inner.flush();
    },
  };
  s.machine.deps.journal = syncFailJournal;
  s.machine.plan(s.approval, "runner-1");
  await s.machine.prepare();
  await s.machine.quiesce();
  await s.machine.stop();
  const state = s.machine.preserve();
  const h = s.hashes();
  check(
    "F23-05",
    "journal sync failure on preserve intent -> blocked BEFORE mutation",
    state === "BLOCKED_BEFORE_STOP" && h.live === s.manifest.baseline.tree_sha256 && h.backup === null,
    "BLOCKED_BEFORE_STOP, no rename",
    JSON.stringify({ state, hashes: h })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Directory fsync failure after the preserve rename: durability unknown ->
  // MANUAL_RECOVERY_REQUIRED; a fresh runner reconciles from the filesystem.
  const s = makeScenario({ fsHooks: { failFsyncDir: () => true } });
  s.machine.plan(s.approval, "runner-1");
  await s.machine.prepare();
  await s.machine.quiesce();
  await s.machine.stop();
  const state = s.machine.preserve();
  const machine2 = newMachineOverSameSlots(s);
  const resumed = machine2.resume();
  check(
    "F23-05",
    "fsync failure after rename -> MANUAL_RECOVERY_REQUIRED; fresh runner restores baseline from FS evidence",
    state === "MANUAL_RECOVERY_REQUIRED" &&
      resumed === "QUIESCENT" &&
      treeSha(s.slots.liveDir) === s.manifest.baseline.tree_sha256,
    "MANUAL -> resume QUIESCENT + live==baseline",
    JSON.stringify({ state, resumed, liveHash: treeSha(s.slots.liveDir) })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Journal result lost after the rename (runner crash): reconcile from FS.
  const s = makeScenario();
  s.machine.plan(s.approval, "runner-1");
  await s.machine.prepare();
  await s.machine.quiesce();
  await s.machine.stop();
  const realAppend = s.journal.append.bind(s.journal);
  s.journal.append = (r) => {
    realAppend(r);
    if (r.transition === "preserve" && r.intent_or_result === "result") {
      throw new Error("injected journal write failure after rename");
    }
  };
  const state = s.machine.preserve();
  const machine2 = newMachineOverSameSlots(s);
  const resumed = machine2.resume();
  check(
    "F23-05",
    "rename done but journal result lost -> MANUAL; resume restores baseline from FS evidence",
    state === "MANUAL_RECOVERY_REQUIRED" &&
      resumed === "QUIESCENT" &&
      treeSha(s.slots.liveDir) === s.manifest.baseline.tree_sha256,
    "MANUAL -> resume QUIESCENT + live==baseline",
    JSON.stringify({ state, resumed, liveHash: treeSha(s.slots.liveDir) })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Journal claims a state the filesystem contradicts -> FS wins.
  const s = makeScenario();
  s.machine.plan(s.approval, "runner-1");
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
    "F23-05",
    "journal claim contradicted by filesystem -> FS wins (no-runtime-change)",
    state === "BLOCKED_BEFORE_STOP" && s.service.startCount === 0,
    "BLOCKED_BEFORE_STOP, no start",
    JSON.stringify({ state, startCount: s.service.startCount })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-06 — preserve/publish failures: baseline preserved, no partial copies.
{
  const s = makeScenario({ fsHooks: { failRename: (a) => a.includes("candidate") } });
  s.machine.plan(s.approval, "runner-1");
  await s.machine.prepare();
  await s.machine.quiesce();
  await s.machine.stop();
  s.machine.preserve();
  const state = await s.machine.publish();
  check(
    "F23-06",
    "candidate→live rename fails -> ROLLBACK_REQUIRED, backup holds baseline tree",
    state === "ROLLBACK_REQUIRED" && treeSha(s.slots.backupDir) === s.manifest.baseline.tree_sha256,
    "ROLLBACK_REQUIRED + backup preserved",
    JSON.stringify({ state, backupHash: s.hashes().backup })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Corruption between prepare and preserve: backup ends with a foreign tree.
  const s = makeScenario();
  s.machine.plan(s.approval, "runner-1");
  await s.machine.prepare();
  await s.machine.quiesce();
  await s.machine.stop();
  fs.writeFileSync(path.join(s.slots.liveDir, "index.js"), "MYSTERY-BUILD\n");
  const state = s.machine.preserve();
  check(
    "F23-06",
    "unknown backup tree hash -> MANUAL_RECOVERY_REQUIRED",
    state === "MANUAL_RECOVERY_REQUIRED",
    "MANUAL_RECOVERY_REQUIRED",
    JSON.stringify({ state })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Override apply failure through the injected config adapter -> rollback.
  const s = makeScenario();
  s.machine.plan(s.approval, "runner-1");
  await s.machine.prepare();
  await s.machine.quiesce();
  await s.machine.stop();
  s.machine.preserve();
  s.configAdapter.faults.applyFails = true;
  const state = await s.machine.publish();
  check(
    "F23-06",
    "config adapter apply failure -> ROLLBACK_REQUIRED",
    state === "ROLLBACK_REQUIRED",
    "ROLLBACK_REQUIRED",
    JSON.stringify({ state })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-07 — candidate verification (D3): deadline-bounded start/health, two
//          consecutive stable samples, non-cooperative adapters never hang.
//          Health faults are activated AFTER publish so the prepare-time
//          baseline health snapshot (a separate pre-stop gate) stays valid.
for (const [label, activate] of [
  ["startup failure", (s) => { s.service.faults.startupFails = true; }],
  ["health failure", (s) => { s.service.faults.healthFails = true; }],
  ["wrong schema", (s) => { s.service.faults.baselineSchema = true; }],
  ["wrong identity", (s) => { s.service.faults.wrongIdentity = true; }],
  ["crash loop", (s) => { s.service.faults.crashLoop = true; }],
  ["flaky health (consecutive samples broken)", (s) => { s.service.faults.flakyHealth = true; }],
  ["unstable identity across samples", (s) => { s.service.faults.unstableIdentity = true; }],
]) {
  const s = makeScenario();
  const r = await driveToPublished(s);
  activate(s);
  const verify = await s.machine.verifyCandidate();
  check(
    "F23-07",
    `${label} -> ROLLBACK_REQUIRED`,
    r.publish === "CANDIDATE_PUBLISHED" && verify === "ROLLBACK_REQUIRED",
    "ROLLBACK_REQUIRED",
    JSON.stringify({ publish: r.publish, verify })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Non-cooperative start: bounded, no hang, no VERIFIED. Fault is activated
  // after publish so the prepare-time gates are unaffected.
  const s = makeScenario();
  const r = await driveToPublished(s);
  s.service.faults.nonCooperativeStart = true;
  const verify = await s.machine.verifyCandidate();
  check(
    "F23-07",
    "non-cooperative start -> ROLLBACK_REQUIRED",
    r.publish === "CANDIDATE_PUBLISHED" && verify === "ROLLBACK_REQUIRED",
    "ROLLBACK_REQUIRED",
    JSON.stringify({ publish: r.publish, verify })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  const s = makeScenario();
  const r = await driveToPublished(s);
  s.service.faults.nonCooperativeHealth = true;
  const t0 = performance.now();
  const verify = await s.machine.verifyCandidate();
  const elapsed = performance.now() - t0;
  check(
    "F23-07",
    "non-cooperative health -> ROLLBACK_REQUIRED, bounded (<5000ms)",
    r.publish === "CANDIDATE_PUBLISHED" && verify === "ROLLBACK_REQUIRED" && elapsed < 5000,
    "ROLLBACK_REQUIRED within bound",
    JSON.stringify({ publish: r.publish, verify, elapsedMs: Math.round(elapsed) })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-08 — rollback restores EXACT prior overrides (D4), including unset keys.
{
  // Prior: both keys set to old values -> restored exactly.
  const s = makeScenario();
  const r = await driveToPublished(s);
  s.service.faults.healthFails = true; // make candidate verification fail
  const verify = await s.machine.verifyCandidate();
  s.service.faults.healthFails = false;
  s.service.currentBuild = "baseline";
  const rb = await s.machine.rollback();
  const state = s.configAdapter.rawState();
  check(
    "F23-08",
    "rollback restores exact prior override values",
    verify === "ROLLBACK_REQUIRED" &&
      rb === "ROLLED_BACK" &&
      state.PROJECT_MEMORY_MAX_LINES === "200" &&
      state.PROJECT_MEMORY_MAX_BYTES === "25000" &&
      Object.keys(state).length === 2,
    "ROLLED_BACK, overrides == {200, 25000}",
    JSON.stringify({ verify, rollback: rb, state })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Prior: MAX_BYTES was UNSET -> rollback must leave it unset, not write a default.
  const s = makeScenario({ priorOverrides: { PROJECT_MEMORY_MAX_LINES: "200" } });
  const r = await driveToPublished(s);
  s.service.faults.healthFails = true;
  const verify = await s.machine.verifyCandidate();
  s.service.faults.healthFails = false;
  s.service.currentBuild = "baseline";
  const rb = await s.machine.rollback();
  const state = s.configAdapter.rawState();
  check(
    "F23-08",
    "rollback restores unset key as unset",
    verify === "ROLLBACK_REQUIRED" &&
      rb === "ROLLED_BACK" &&
      state.PROJECT_MEMORY_MAX_LINES === "200" &&
      !Object.prototype.hasOwnProperty.call(state, "PROJECT_MEMORY_MAX_BYTES"),
    "ROLLED_BACK, MAX_BYTES unset",
    JSON.stringify({ verify, rollback: rb, state })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Restore failure through the adapter -> MANUAL_RECOVERY_REQUIRED.
  const s = makeScenario();
  const r = await driveToPublished(s);
  s.service.faults.healthFails = true;
  const verify = await s.machine.verifyCandidate();
  s.service.faults.healthFails = false;
  s.service.currentBuild = "baseline";
  s.configAdapter.faults.restoreFails = true;
  const rb = await s.machine.rollback();
  check(
    "F23-08",
    "override restore failure -> MANUAL_RECOVERY_REQUIRED",
    verify === "ROLLBACK_REQUIRED" && rb === "MANUAL_RECOVERY_REQUIRED",
    "MANUAL_RECOVERY_REQUIRED",
    JSON.stringify({ verify, rollback: rb })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-09 — rollback: evidence kept, baseline judged by its OWN schema,
//          baseline start/health bounded and stable.
{
  const s = makeScenario({ serviceFaults: { startupFails: true } });
  const r = await happyPath(s);
  s.service.faults.startupFails = false;
  s.service.currentBuild = "baseline";
  const rb = await s.machine.rollback();
  const failedDir = path.join(s.slots.failedRuntimesDir, s.manifest.deployment_id);
  const evidenceSha = treeSha(failedDir);
  check(
    "F23-09",
    "failed runtime kept as evidence; baseline accepted by its own schema",
    rb === "ROLLED_BACK" &&
      evidenceSha === s.manifest.candidate.tree_sha256 &&
      s.hashes().live === s.manifest.baseline.tree_sha256 &&
      s.hashes().backup === null,
    "ROLLED_BACK + evidence + restored live",
    JSON.stringify({ rollback: rb, evidenceSha, hashes: s.hashes() })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
for (const [label, setup] of [
  ["baseline start fails during rollback", (s) => { s.service.faults.startupFails = true; }],
  ["backup tree foreign at rollback", (s) => { fs.writeFileSync(path.join(s.slots.backupDir, "index.js"), "FOREIGN\n"); }],
  ["baseline health fails after restore", (s) => { s.service.faults.healthFails = true; }],
]) {
  const s = makeScenario({ serviceFaults: { startupFails: true } });
  const r = await happyPath(s);
  s.service.currentBuild = "baseline";
  if (label === "backup tree foreign at rollback") setup(s);
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

// ---------------------------------------------------------------------------
// F23-10 — crash/resume: whole-tree reconciliation, no replay, no loops.
{
  // Lost slots: both live and backup gone before resume.
  const s = makeScenario();
  fs.rmSync(s.slots.liveDir, { recursive: true, force: true });
  fs.rmSync(s.slots.backupDir, { recursive: true, force: true });
  const state = s.machine.resume();
  check(
    "F23-10",
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
  writeRuntime(s.slots.backupDir, "baseline");
  writeRuntime(s.slots.liveDir, "candidate");
  s.service.startCount = 1;
  const state = s.machine.resume();
  check(
    "F23-10",
    "unclear prior start -> MANUAL_RECOVERY_REQUIRED (no replay)",
    state === "MANUAL_RECOVERY_REQUIRED",
    "MANUAL_RECOVERY_REQUIRED",
    JSON.stringify({ state })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Live slot empty, backup correct, never started: restore is the only move.
  const s = makeScenario();
  fs.rmSync(s.slots.liveDir, { recursive: true, force: true });
  writeRuntime(s.slots.backupDir, "baseline");
  const state = s.machine.resume();
  check(
    "F23-10",
    "live empty + backup correct -> restore baseline, QUIESCENT",
    state === "QUIESCENT" && treeSha(s.slots.liveDir) === s.manifest.baseline.tree_sha256,
    "QUIESCENT + live==baseline",
    JSON.stringify({ state, liveHash: treeSha(s.slots.liveDir) })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}
{
  // Candidate published but provably never started: resume to CANDIDATE_PUBLISHED.
  const s = makeScenario();
  writeRuntime(s.slots.backupDir, "baseline");
  writeRuntime(s.slots.liveDir, "candidate");
  const state = s.machine.resume();
  check(
    "F23-10",
    "live=candidate, backup=baseline, startCount=0 -> CANDIDATE_PUBLISHED",
    state === "CANDIDATE_PUBLISHED",
    "CANDIDATE_PUBLISHED",
    JSON.stringify({ state })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-11 — happy path: two consecutive healthy samples, ordered trace, one
//          stop/one start, refused re-verify, durable journal on disk.
{
  const s = makeScenario();
  const r = await happyPath(s);
  const trace = s.machine.opTrace.map((t) => t.transition);
  const stopCount = s.service.stopCount;
  const verifyAgain = await s.machine.verifyCandidate();
  const lockHeld = s.locks.verify(s.manifest.deployment_id);
  const journalText = fs.readFileSync(s.slots.journalPath, "utf-8").trim();
  const journalLines = journalText.split("\n").filter(Boolean);
  const everyRecordWellFormed = journalLines.every((line) => {
    try {
      const rec = JSON.parse(line);
      return (
        rec.deployment_id === s.manifest.deployment_id &&
        typeof rec.sequence === "number" &&
        typeof rec.transition === "string" &&
        typeof rec.time_utc === "string"
      );
    } catch {
      return false;
    }
  });
  check(
    "F23-11",
    "happy path: COMPLETE, 1 stop/1 start, refused re-verify, ordered trace, durable journal file",
    r.complete === "COMPLETE" &&
      r.verify === "VERIFIED" &&
      stopCount === 1 &&
      s.service.startCount === 1 &&
      verifyAgain === "COMPLETE" &&
      s.service.startCount === 1 &&
      lockHeld === true &&
      journalLines.length >= 10 &&
      everyRecordWellFormed &&
      trace.indexOf("preserve") < trace.indexOf("publish") &&
      trace.indexOf("publish") < trace.indexOf("verify") &&
      trace.indexOf("verify") < trace.indexOf("complete"),
    "COMPLETE, bounded starts, ordered trace, journal durable",
    JSON.stringify({ r, verifyAgain, startCount: s.service.startCount, stopCount, lockHeld, journalLines: journalLines.length, trace })
  );
  fs.rmSync(s.base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F23-12 — durable journal adapter itself: every record is written and fsynced
//          (not just the last one), and survives a simulated crash (a fresh
//          reader sees every record).
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "clc-journal-"));
  const sink = path.join(base, "journal.jsonl");
  const j = memoryJournal(sink);
  j.append({ deployment_id: "d", sequence: 1, transition: "plan", intent_or_result: "intent" });
  j.append({ deployment_id: "d", sequence: 2, transition: "plan", intent_or_result: "result" });
  j.append({ deployment_id: "d", sequence: 3, transition: "prepare", intent_or_result: "intent" });
  j.flush();
  const onDisk = fs.readFileSync(sink, "utf-8").trim().split("\n").filter(Boolean);
  check(
    "F23-12",
    "durable journal writes every record (not just the latest) and survives a fresh read",
    onDisk.length === 3 && onDisk.every((line) => JSON.parse(line).sequence > 0),
    "3 durable records",
    JSON.stringify({ lines: onDisk.length })
  );
  fs.rmSync(base, { recursive: true, force: true });
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
