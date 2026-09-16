/**
 * Deployment state machine + journal for the project-memory cutover
 * (plan §17.2–17.4, review REV-R02 / F23).
 *
 * This module is the rehearsal logic an operator is expected to drive during a
 * coordinated maintenance. The runtime is modelled as a COMPLETE immutable
 * asset set (whole directories, not a single index.js): live/candidate/backup
 * are sibling runtime directories and the release manifest lists every asset
 * with path/type/mode/SHA-256 plus source/build identity. Every mutation is
 * preceded by a durable journal intent record (write + fsync) and followed by
 * a result record; slot changes are whole-directory rename-only with a
 * directory fsync before the next destructive transition is allowed; start
 * attempts are budgeted (one candidate start, one baseline start per
 * transition) and verification requires the planned number of consecutive
 * healthy samples with stable supervisor counters and instance identity;
 * rollback judges the baseline by its OWN schema and restores EXACTLY the
 * prior state of the two memory-limit overrides (including unset keys) through
 * an injected configuration adapter.
 *
 * It is fully adapter-injected: filesystem operations, service control,
 * health probing, supervisor observation, journal sink, lock backend and
 * configuration override access are supplied by the caller. The F23 test
 * suite drives it with test-owned temp slot directories and a fake
 * service/supervisor; nothing here touches a real host, service unit, tunnel
 * or production path.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEPLOYMENT_STATES = [
  "PLANNED",
  "PREPARED",
  "QUIESCENT",
  "STOPPED",
  "OLD_PRESERVED",
  "CANDIDATE_PUBLISHED",
  "VERIFIED",
  "COMPLETE",
  "ROLLBACK_REQUIRED",
  "ROLLED_BACK",
  "BLOCKED_BEFORE_STOP",
  "MANUAL_RECOVERY_REQUIRED",
];

export class DeploymentStateError extends Error {
  constructor(message, { targetState = null } = {}) {
    super(message);
    this.name = "DeploymentStateError";
    this.targetState = targetState;
  }
}

export function sha256OfFile(filePath) {
  const data = fs.readFileSync(filePath);
  return createHash("sha256").update(data).digest("hex");
}

export const RUNTIME_OVERRIDE_KEYS = ["PROJECT_MEMORY_MAX_LINES", "PROJECT_MEMORY_MAX_BYTES"];

/** Walk a runtime directory into a sorted immutable asset list:
 *  {path, type:"file", mode (octal permission string), sha256}. */
export function runtimeAssets(dir, fsadapter) {
  const out = [];
  const visit = (rel, dirPath) => {
    for (const entry of fsadapter.readdir(dirPath)) {
      const full = path.join(dirPath, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(relPath, full);
      } else if (entry.isFile()) {
        const st = fsadapter.stat(full);
        out.push({
          path: relPath,
          type: "file",
          mode: (st.mode & 0o777).toString(8),
          sha256: createHash("sha256").update(fsadapter.readFileBuf(full)).digest("hex"),
        });
      }
    }
  };
  if (fsadapter.exists(dir)) visit("", dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Canonical tree hash over a sorted asset list (path|type|mode|sha256). */
export function runtimeTreeSha256(assets) {
  const lines = assets.map((a) => `${a.path}|${a.type}|${a.mode}|${a.sha256}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** Canonical SHA-256 of a release manifest (sorted, whitespace-free). */
export function releaseManifestSha256(manifest) {
  const assets = (list) =>
    (list ?? [])
      .map((a) => ({ path: a.path, type: a.type, mode: a.mode, sha256: a.sha256 }))
      .sort((x, y) => (x.path < y.path ? -1 : 1));
  const canon = {
    schema: manifest.schema,
    deployment_id: manifest.deployment_id,
    source_sha: manifest.source_sha,
    lockfile_hash: manifest.lockfile_hash,
    target_node: manifest.target_node,
    target_os: manifest.target_os,
    target_arch: manifest.target_arch,
    ci_refs: [...(manifest.ci_refs ?? [])].sort(),
    canary_refs: [...(manifest.canary_refs ?? [])].sort(),
    baseline: { tree_sha256: manifest.baseline?.tree_sha256, assets: assets(manifest.baseline?.assets) },
    candidate: { tree_sha256: manifest.candidate?.tree_sha256, assets: assets(manifest.candidate?.assets) },
  };
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

/** Structural + integrity validation of a release manifest: schema, identity
 *  fields, per-asset path/type/mode/hash and the canonical sha256 linkage. */
export function verifyReleaseManifest(manifest) {
  const err = (error) => ({ ok: false, error });
  if (!manifest || manifest.schema !== "clc.memory-release.v1") return err("schema");
  if (typeof manifest.source_sha !== "string" || !/^[0-9a-f]{64}$/.test(manifest.source_sha)) return err("source_sha");
  for (const k of ["lockfile_hash", "target_node", "target_os", "target_arch", "release_manifest_sha256"]) {
    if (typeof manifest[k] !== "string" || manifest[k].trim().length === 0) return err(`field:${k}`);
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.release_manifest_sha256)) return err("release_manifest_sha256");
  for (const side of ["baseline", "candidate"]) {
    const desc = manifest[side];
    if (!desc || typeof desc.tree_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(desc.tree_sha256)) {
      return err(`${side}.tree_sha256`);
    }
    if (!Array.isArray(desc.assets) || desc.assets.length === 0) return err(`${side}.assets`);
    const seen = new Set();
    for (const a of desc.assets) {
      if (!a || typeof a.path !== "string" || a.path.trim().length === 0 || a.path.includes("\\")) return err(`${side}.asset.path`);
      if (a.type !== "file") return err(`${side}.asset.type`);
      if (typeof a.mode !== "string" || !/^[0-7]{1,4}$/.test(a.mode)) return err(`${side}.asset.mode`);
      if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) return err(`${side}.asset.sha256`);
      if (seen.has(a.path)) return err(`${side}.asset.dup:${a.path}`);
      seen.add(a.path);
    }
  }
  if (releaseManifestSha256(manifest) !== manifest.release_manifest_sha256) return err("release_manifest_sha256-mismatch");
  return { ok: true };
}

const DEFAULT_STARTUP = { deadlineMs: 60000, healthTimeoutMs: 3000, pollMs: 2000, samples: 2 };

/**
 * @param {object} deps
 *  - slots: { liveDir, candidateDir, backupDir, failedRuntimesDir, journalPath, lockPath }
 *      — live/candidate/backup are WHOLE runtime directories (complete asset
 *        sets), never single files.
 *  - manifest: release manifest, schema clc.memory-release.v1, with
 *      source_sha, lockfile_hash, target_node/os/arch, release_manifest_sha256,
 *      ci_refs, canary_refs, baseline: {tree_sha256, assets:[{path,type,mode,sha256}]},
 *      candidate: {...} — the manifest must verify via verifyReleaseManifest.
 *  - planIdentity: { plan_sha256, plan_revision } — the parent-supplied plan
 *      identity the receipt must match EXACTLY (not merely look like a hash).
 *  - targetOverrides: { PROJECT_MEMORY_MAX_LINES, PROJECT_MEMORY_MAX_BYTES } —
 *      the only two configuration keys this deployment may change.
 *  - configAdapter: { snapshotOverrides(), currentOverrides(), applyOverrides(ov),
 *      restoreOverrides(snapshot) } — injected; the machine never assumes a
 *      production config mechanism. Snapshot/current shapes are per-key
 *      { set: boolean, value: string|null } over exactly the two override keys.
 *  - service: adapter (see below)
 *  - fsadapter: { rename, readdir, stat, readFileBuf, mkdir, copyFile, writeFile,
 *      readFile, exists, rmTree, fsyncDir } — injected so tests can fault-inject at
 *      exact steps; defaults to real fs.
 *  - journal: { append(record), flush(), records() } — flush() must be durable
 *      (write + fsync); a throw means the record is not durable and the machine
 *      must not proceed with a destructive transition.
 *  - locks: { acquire(deploymentId, runnerId), verify(deploymentId) }
 *  - now: () => Date.now() (injectable business clock — used ONLY for journal
 *      time_utc timestamps and receipt expiry/freshness checks; may be frozen
 *      or stepped by tests without affecting deadline bounds)
 *  - monotonicNow: () => ms (injectable monotonic ELAPSED clock for all
 *      startup/health/rollback deadlines; defaults to performance.now and
 *      must always advance — deadline loops never read deps.now, so a frozen
 *      business clock can never hang the machine)
 *  - startup: { deadlineMs, healthTimeoutMs, pollMs, samples } — samples is the
 *      number of CONSECUTIVE healthy samples required; defaults match plan
 *      §17.2 (60s / 3s / 2s / 2).
 *
 * service adapter contract:
 *  - state: "running" | "stopped"
 *  - checkQuiescence(): Promise<boolean> — admission/quiescence evidence
 *  - stop(): Promise<void> — sets state stopped
 *  - isStopped(): Promise<boolean>
 *  - start(): Promise<void> — increments startCount; may crash per fault config
 *  - health(): Promise<object> — resolves only when healthy; rejects on failure;
 *      may be non-cooperative (the machine bounds every call)
 *  - verifyCandidate(health): boolean — identity/schema/limits/permissions checks
 *  - verifyBaselineSchema(health, baselineSnapshot): boolean — baseline judged by
 *      its OWN schema
 *  - supervisor(): { restarts, startCount } — counters observed by the caller
 */
export class DeploymentMachine {
  constructor(deps) {
    this.deps = deps;
    this.state = "PLANNED";
    this.opTrace = [];
    this.seq = 0;
    this.startedCandidate = false;
    this.startedBaseline = false;
    this.approval = null;
    this.runnerId = null;
    this.priorOverrides = null;
    this.baselineHealthSnapshot = null;
    // Monotonic elapsed clock for deadline bounds. Production defaults to
    // performance.now(); tests may inject a fake one, but it must advance —
    // deadline loops never read the business clock (deps.now).
    this.monotonicNow =
      typeof deps.monotonicNow === "function" ? deps.monotonicNow : () => performance.now();
  }

  #startup() {
    const s = this.deps.startup ?? {};
    return {
      deadlineMs: Number.isFinite(s.deadlineMs) ? s.deadlineMs : DEFAULT_STARTUP.deadlineMs,
      healthTimeoutMs: Number.isFinite(s.healthTimeoutMs) ? s.healthTimeoutMs : DEFAULT_STARTUP.healthTimeoutMs,
      pollMs: Number.isFinite(s.pollMs) ? s.pollMs : DEFAULT_STARTUP.pollMs,
      samples: Number.isFinite(s.samples) && s.samples >= 1 ? s.samples : DEFAULT_STARTUP.samples,
    };
  }

  #slotsRoot() {
    return path.dirname(this.deps.slots.liveDir);
  }

  #j(transition, intentOrResult, sourceState, targetState, extra = {}) {
    this.seq += 1;
    const record = {
      deployment_id: this.deps.manifest.deployment_id,
      sequence: this.seq,
      time_utc: new Date(this.deps.now()).toISOString(),
      transition,
      intent_or_result: intentOrResult,
      source_state: sourceState,
      target_state: targetState,
      path_hashes: extra.path_hashes ?? {},
      observed_service_state: extra.observed_service_state ?? null,
      result: extra.result ?? "ok",
      evidence_ref: extra.evidence_ref ?? null,
    };
    if (extra.override_snapshot !== undefined) record.override_snapshot = extra.override_snapshot;
    this.deps.journal.append(record);
    this.deps.journal.flush(); // durable: throws on write/sync failure
    this.opTrace.push(record);
    return record;
  }

  /** Best-effort result record (non-mutating or already-mutated paths): a
   *  lost result record must never throw a machine into a bad state. */
  #jSafe(transition, intentOrResult, sourceState, targetState, extra = {}) {
    try {
      return this.#j(transition, intentOrResult, sourceState, targetState, extra);
    } catch {
      return null;
    }
  }

  /** Bounded await for a possibly non-cooperative adapter promise (plain
   *  values are accepted too: every adapter call is wrapped in Promise.resolve). */
  #bounded(promise, ms, label) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`${label} exceeded ${ms}ms (non-cooperative)`));
        }
      }, ms);
      Promise.resolve(promise).then(
        (v) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(v);
          }
        },
        (e) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(e);
          }
        }
      );
    });
  }

  #sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  #treeState(dir) {
    const assets = runtimeAssets(dir, this.deps.fsadapter);
    return { exists: assets.length > 0, assets, sha256: runtimeTreeSha256(assets) };
  }

  /** Exact set-equality against a manifest runtime description: every manifest
   *  asset must exist with the right hash/type/mode, and any file not in the
   *  manifest (a mixed old/new runtime) is a mismatch. */
  #verifyTree(dir, expectedDesc) {
    const actual = this.#treeState(dir);
    const problems = [];
    const actualByPath = new Map(actual.assets.map((a) => [a.path, a]));
    const expectedPaths = new Set(expectedDesc.assets.map((a) => a.path));
    for (const want of expectedDesc.assets) {
      const act = actualByPath.get(want.path);
      if (!act) {
        problems.push(`missing:${want.path}`);
        continue;
      }
      if (act.sha256 !== want.sha256) problems.push(`hash:${want.path}`);
      if (act.type !== want.type) problems.push(`type:${want.path}`);
      if (act.mode !== want.mode) problems.push(`mode:${want.path}`);
    }
    for (const act of actual.assets) {
      if (!expectedPaths.has(act.path)) problems.push(`extra:${act.path}`);
    }
    return { ok: problems.length === 0, problems, sha256: actual.sha256, exists: actual.exists };
  }

  #copyTree(srcDir, dstDir) {
    const assets = runtimeAssets(srcDir, this.deps.fsadapter);
    for (const a of assets) {
      const dst = path.join(dstDir, a.path);
      this.deps.fsadapter.mkdir(path.dirname(dst), { recursive: true });
      this.deps.fsadapter.copyFile(path.join(srcDir, a.path), dst);
    }
  }

  #receiptFieldsValid(a) {
    const required = [
      "plan_sha256",
      "candidate_source_sha",
      "release_manifest_sha256",
      "service_identity",
      "operator",
      "approval_ref_C",
      "ingress_inventory_ref",
      "job_inventory_ref",
      "quiescence_verified_at",
      "cutover_expires_at",
      "out_of_band_control_ref",
      "admission_pause_method",
      "resume_owner",
    ];
    return (
      !!a &&
      a.schema === "clc.memory-maintenance.v1" &&
      typeof a.plan_revision === "string" &&
      a.plan_revision.trim().length > 0 &&
      required.every((k) => typeof a[k] === "string" && a[k].trim().length > 0) &&
      Array.isArray(a.client_ack_refs) &&
      a.client_ack_refs.length > 0 &&
      a.client_ack_refs.every((r) => typeof r === "string" && r.trim().length > 0) &&
      !Number.isNaN(new Date(a.quiescence_verified_at).getTime()) &&
      !Number.isNaN(new Date(a.cutover_expires_at).getTime()) &&
      (a.state === "approved" || a.state === "pending")
    );
  }

  /** Full revalidation of receipt freshness + plan identity + release-manifest
   *  linkage, re-run immediately before every destructive step. */
  #recheckReceipt() {
    const a = this.approval;
    if (!this.#receiptFieldsValid(a)) return { ok: false, reason: "invalid-receipt" };
    if (a.plan_sha256 !== this.deps.planIdentity.plan_sha256) return { ok: false, reason: "plan-sha-mismatch" };
    if (a.plan_revision !== this.deps.planIdentity.plan_revision) return { ok: false, reason: "plan-revision-mismatch" };
    if (a.candidate_source_sha !== this.deps.manifest.source_sha) return { ok: false, reason: "candidate-source-mismatch" };
    if (a.release_manifest_sha256 !== this.deps.manifest.release_manifest_sha256) {
      return { ok: false, reason: "release-manifest-linkage-mismatch" };
    }
    if (!verifyReleaseManifest(this.deps.manifest).ok) return { ok: false, reason: "release-manifest-invalid" };
    if (a.state !== "approved") return { ok: false, reason: "receipt-not-approved" };
    if (new Date(a.cutover_expires_at).getTime() <= this.deps.now()) return { ok: false, reason: "receipt-expired" };
    return { ok: true };
  }

  #targetOverridesValid() {
    const t = this.deps.targetOverrides ?? null;
    if (!t) return false;
    const keys = Object.keys(t).sort();
    const expected = [...RUNTIME_OVERRIDE_KEYS].sort();
    return (
      keys.length === 2 &&
      keys[0] === expected[0] &&
      keys[1] === expected[1] &&
      typeof t.PROJECT_MEMORY_MAX_LINES === "string" &&
      typeof t.PROJECT_MEMORY_MAX_BYTES === "string"
    );
  }

  #overrideShapeOk(shape) {
    if (!this.#targetOverridesValid()) return false;
    const keys = Object.keys(shape ?? {}).sort();
    const expected = [...RUNTIME_OVERRIDE_KEYS].sort();
    return (
      keys.length === 2 &&
      keys[0] === expected[0] &&
      keys[1] === expected[1] &&
      keys.every((k) => {
        const v = shape[k];
        return (
          v &&
          typeof v === "object" &&
          typeof v.set === "boolean" &&
          (v.set === false || typeof v.value === "string")
        );
      })
    );
  }

  #overridesEqual(a, b) {
    const keys = Object.keys(this.deps.targetOverrides);
    return keys.every((k) => {
      const x = a?.[k];
      const y = b?.[k];
      return x?.set === y?.set && (!x?.set || x?.value === y?.value);
    });
  }

  #blockedBeforeStop(reason) {
    this.#jSafe("plan", "result", this.state, "BLOCKED_BEFORE_STOP", { result: reason });
    this.state = "BLOCKED_BEFORE_STOP";
    return this.state;
  }

  /** Validate approval receipt + release manifest + deploy lock. */
  plan(approval, runnerId) {
    const a = approval ?? {};
    try {
      this.#j("plan", "intent", this.state, "PREPARED", { result: "ok" });
    } catch {
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    if (!this.#receiptFieldsValid(a)) return this.#blockedBeforeStop("invalid-receipt");
    if (a.plan_sha256 !== this.deps.planIdentity.plan_sha256) return this.#blockedBeforeStop("plan-sha-mismatch");
    if (a.plan_revision !== this.deps.planIdentity.plan_revision) return this.#blockedBeforeStop("plan-revision-mismatch");
    if (a.candidate_source_sha !== this.deps.manifest.source_sha) return this.#blockedBeforeStop("candidate-source-mismatch");
    if (a.release_manifest_sha256 !== this.deps.manifest.release_manifest_sha256) {
      return this.#blockedBeforeStop("release-manifest-linkage-mismatch");
    }
    if (!verifyReleaseManifest(this.deps.manifest).ok) return this.#blockedBeforeStop("release-manifest-invalid");
    if (a.state !== "approved") return this.#blockedBeforeStop("receipt-not-approved");
    if (new Date(a.cutover_expires_at).getTime() <= this.deps.now()) return this.#blockedBeforeStop("receipt-expired");
    if (!this.#targetOverridesValid()) return this.#blockedBeforeStop("target-overrides-invalid");
    const locked = this.deps.locks.acquire(this.deps.manifest.deployment_id, runnerId);
    if (!locked) return this.#blockedBeforeStop("lock-unavailable");
    this.approval = a;
    this.runnerId = runnerId;
    this.#jSafe("plan", "result", "PLANNED", "PREPARED", { result: "ok" });
    this.state = "PREPARED";
    return this.state;
  }

  /** Verify candidate/backup WHOLE trees, receipt freshness and baseline
   *  health/override snapshots before any stop. */
  async prepare() {
    if (this.state !== "PREPARED") return this.state;
    try {
      this.#j("prepare", "intent", this.state, "PREPARED", { result: "ok" });
    } catch {
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    const recheck = this.#recheckReceipt();
    if (!recheck.ok) {
      this.#jSafe("prepare", "result", "PREPARED", "BLOCKED_BEFORE_STOP", { result: `receipt-recheck:${recheck.reason}` });
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    const candidate = this.#verifyTree(this.deps.slots.candidateDir, this.deps.manifest.candidate);
    const live = this.#verifyTree(this.deps.slots.liveDir, this.deps.manifest.baseline);
    if (!candidate.ok || !live.ok) {
      this.#jSafe("prepare", "result", "PREPARED", "BLOCKED_BEFORE_STOP", {
        result: "tree-mismatch",
        path_hashes: { candidate: candidate.sha256, live: live.sha256 },
      });
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    let baselineHealth = null;
    try {
      baselineHealth = await this.#bounded(
        this.deps.service.health(),
        this.#startup().healthTimeoutMs,
        "baseline health snapshot"
      );
    } catch (err) {
      this.#jSafe("prepare", "result", "PREPARED", "BLOCKED_BEFORE_STOP", { result: `baseline-health-snapshot-failed:${err.message}` });
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    let snapshot = null;
    try {
      const maybe = this.deps.configAdapter.snapshotOverrides();
      snapshot = maybe && typeof maybe.then === "function" ? await maybe : maybe;
    } catch (err) {
      this.#jSafe("prepare", "result", "PREPARED", "BLOCKED_BEFORE_STOP", { result: `override-snapshot-failed:${err.message}` });
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    if (!this.#overrideShapeOk(snapshot)) {
      this.#jSafe("prepare", "result", "PREPARED", "BLOCKED_BEFORE_STOP", { result: "override-snapshot-invalid" });
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    this.baselineHealthSnapshot = baselineHealth;
    this.priorOverrides = snapshot;
    try {
      this.#j("prepare", "result", "PREPARED", "PREPARED", {
        path_hashes: { candidate: candidate.sha256, live: live.sha256 },
        override_snapshot: snapshot,
      });
    } catch {
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    return this.state;
  }

  /** Operator confirms all ingress sources are quiescent. */
  async quiesce() {
    if (this.state !== "PREPARED") return this.state;
    try {
      this.#j("quiesce", "intent", this.state, "QUIESCENT", { result: "ok" });
    } catch {
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    const quiet = await this.deps.service.checkQuiescence();
    if (!quiet) {
      this.#jSafe("quiesce", "result", this.state, "BLOCKED_BEFORE_STOP", { result: "not-quiescent" });
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    this.#jSafe("quiesce", "result", this.state, "QUIESCENT", { result: "ok" });
    this.state = "QUIESCENT";
    return this.state;
  }

  /** Stop the serving host; rename only after stop is CONFIRMED. Receipt
   *  expiry/linkage and quiescence evidence are revalidated IMMEDIATELY
   *  before the stop call (plan §17.1 step 5). */
  async stop() {
    if (this.state !== "QUIESCENT") return this.state;
    try {
      this.#j("stop", "intent", this.state, "STOPPED", { result: "ok" });
    } catch {
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    const recheck = this.#recheckReceipt();
    if (!recheck.ok) {
      this.#jSafe("stop", "result", this.state, "BLOCKED_BEFORE_STOP", { result: `receipt-recheck:${recheck.reason}` });
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    const quiet = await this.deps.service.checkQuiescence();
    if (!quiet) {
      this.#jSafe("stop", "result", this.state, "BLOCKED_BEFORE_STOP", { result: "quiescence-recheck-failed" });
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    await this.deps.service.stop();
    const stopped = await this.deps.service.isStopped();
    if (!stopped) {
      this.#jSafe("stop", "result", this.state, "QUIESCENT", {
        result: "stop-unconfirmed",
        observed_service_state: this.deps.service.state,
      });
      // No rename on an unconfirmed stop; caller must resolve with the operator.
      return this.state;
    }
    this.#jSafe("stop", "result", this.state, "STOPPED", {
      result: "ok",
      observed_service_state: this.deps.service.state,
    });
    this.state = "STOPPED";
    return this.state;
  }

  /** Rename the WHOLE live runtime directory → backup and verify the preserved
   *  baseline by its manifest tree. */
  preserve() {
    if (this.state !== "STOPPED") return this.state;
    try {
      this.#j("preserve", "intent", this.state, "OLD_PRESERVED", { result: "ok" });
    } catch {
      // Intent is not durable: no destructive transition is allowed.
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    const backup = this.#treeState(this.deps.slots.backupDir);
    if (backup.exists) {
      this.#jSafe("preserve", "result", this.state, "BLOCKED_BEFORE_STOP", { result: "backup-slot-occupied" });
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    try {
      this.deps.fsadapter.rename(this.deps.slots.liveDir, this.deps.slots.backupDir);
    } catch (err) {
      this.#jSafe("preserve", "result", this.state, "STOPPED", { result: `rename-failed:${err.message}` });
      return this.state; // live still holds the baseline; no further mutation here
    }
    try {
      this.deps.fsadapter.fsyncDir(this.#slotsRoot());
    } catch (err) {
      this.#jSafe("preserve", "result", this.state, "MANUAL_RECOVERY_REQUIRED", { result: `rename-durability-unconfirmed:${err.message}` });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    const verified = this.#verifyTree(this.deps.slots.backupDir, this.deps.manifest.baseline);
    if (!verified.ok) {
      this.#jSafe("preserve", "result", this.state, "MANUAL_RECOVERY_REQUIRED", {
        result: "backup-tree-mismatch",
        path_hashes: { backup: verified.sha256 },
      });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    try {
      this.#j("preserve", "result", "STOPPED", "OLD_PRESERVED", { path_hashes: { backup: verified.sha256 } });
    } catch {
      // Rename happened but the result record is not durable.
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    this.state = "OLD_PRESERVED";
    return this.state;
  }

  /** Rename the WHOLE candidate runtime directory → live, verify the manifest
   *  tree, then apply exactly the two limit overrides via the config adapter. */
  async publish() {
    if (this.state !== "OLD_PRESERVED") return this.state;
    try {
      this.#j("publish", "intent", this.state, "CANDIDATE_PUBLISHED", { result: "ok" });
    } catch {
      this.state = "ROLLBACK_REQUIRED";
      return this.state;
    }
    try {
      this.deps.fsadapter.rename(this.deps.slots.candidateDir, this.deps.slots.liveDir);
    } catch (err) {
      this.#jSafe("publish", "result", this.state, "ROLLBACK_REQUIRED", { result: `rename-failed:${err.message}` });
      this.state = "ROLLBACK_REQUIRED";
      return this.state;
    }
    try {
      this.deps.fsadapter.fsyncDir(this.#slotsRoot());
    } catch (err) {
      this.#jSafe("publish", "result", this.state, "ROLLBACK_REQUIRED", { result: `rename-durability-unconfirmed:${err.message}` });
      this.state = "ROLLBACK_REQUIRED";
      return this.state;
    }
    const live = this.#verifyTree(this.deps.slots.liveDir, this.deps.manifest.candidate);
    if (!live.ok) {
      this.#jSafe("publish", "result", this.state, "ROLLBACK_REQUIRED", {
        result: "live-tree-mismatch",
        path_hashes: { live: live.sha256 },
      });
      this.state = "ROLLBACK_REQUIRED";
      return this.state;
    }
    try {
      const applied = this.deps.configAdapter.applyOverrides(this.deps.targetOverrides);
      if (applied && typeof applied.then === "function") await applied;
      const curMaybe = this.deps.configAdapter.currentOverrides();
      const cur = curMaybe && typeof curMaybe.then === "function" ? await curMaybe : curMaybe;
      if (!this.#targetApplied(cur)) throw new Error("target-overrides-not-applied");
    } catch (err) {
      this.#jSafe("publish", "result", this.state, "ROLLBACK_REQUIRED", { result: `override-apply-failed:${err.message}` });
      this.state = "ROLLBACK_REQUIRED";
      return this.state;
    }
    try {
      this.#j("publish", "result", "OLD_PRESERVED", "CANDIDATE_PUBLISHED", { path_hashes: { live: live.sha256 } });
    } catch {
      this.state = "ROLLBACK_REQUIRED";
      return this.state;
    }
    this.state = "CANDIDATE_PUBLISHED";
    return this.state;
  }

  #targetApplied(cur) {
    const t = this.deps.targetOverrides;
    return Object.keys(t).every((k) => cur?.[k]?.set === true && cur?.[k]?.value === t[k]);
  }

  /**
   * ONE candidate start request, then deadline-bounded verification requiring
   * the planned number of CONSECUTIVE healthy samples with stable supervisor
   * counters and stable instance identity across samples. Every start/health
   * call is bounded: non-cooperative adapters cannot hang the machine, and a
   * supervisor-triggered restart is observed via the adapter counters and is
   * NOT masked by the single start request.
   */
  async verifyCandidate() {
    if (this.state !== "CANDIDATE_PUBLISHED") return this.state;
    if (this.startedCandidate) {
      this.#jSafe("verify", "result", this.state, "ROLLBACK_REQUIRED", { result: "start-already-attempted" });
      this.state = "ROLLBACK_REQUIRED";
      return this.state;
    }
    this.startedCandidate = true;
    try {
      this.#j("verify", "intent", this.state, "VERIFIED", { result: "ok" });
    } catch {
      this.state = "ROLLBACK_REQUIRED";
      return this.state;
    }
    const { deadlineMs, healthTimeoutMs, pollMs, samples } = this.#startup();
    const required = samples;
    const before = this.deps.service.supervisor();
    // Deadline is anchored to the monotonic elapsed clock, never to the
    // business clock: a frozen/stepped deps.now() cannot hang this loop.
    const deadlineAt = this.monotonicNow() + deadlineMs;
    try {
      await this.#bounded(this.deps.service.start(), deadlineMs, "candidate start");
    } catch (err) {
      this.#jSafe("verify", "result", this.state, "ROLLBACK_REQUIRED", { result: `start-failed:${err.message}` });
      this.state = "ROLLBACK_REQUIRED";
      return this.state;
    }
    let consecutive = 0;
    let anchor = null;
    const failures = [];
    while (this.monotonicNow() < deadlineAt && consecutive < required) {
      let health = null;
      try {
        health = await this.#bounded(this.deps.service.health(), healthTimeoutMs, "candidate health");
      } catch (err) {
        failures.push(`health:${err.message}`);
        consecutive = 0;
        anchor = null;
      }
      if (health) {
        const after = this.deps.service.supervisor();
        const stable = after.restarts === before.restarts && after.startCount - before.startCount === 1;
        const identityOk = this.deps.service.verifyCandidate(health);
        const sameIdentity =
          anchor === null ||
          (health.runtime_pid === anchor.runtime_pid &&
            health.runtime_instance_id === anchor.runtime_instance_id &&
            JSON.stringify(health.instructions?.memory_limits) === JSON.stringify(anchor.instructions?.memory_limits));
        if (identityOk && stable && sameIdentity) {
          consecutive += 1;
          anchor = health;
        } else {
          failures.push(
            !stable ? "restart-instability" : !identityOk ? "identity-failed" : "identity-change-across-samples"
          );
          consecutive = 0;
          anchor = health;
        }
      }
      if (consecutive < required) {
        const waitMs = Math.min(pollMs, Math.max(0, deadlineAt - this.monotonicNow()));
        if (waitMs > 0) await this.#sleep(waitMs);
      }
    }
    const ok = consecutive >= required;
    try {
      this.#j("verify", "result", this.state, ok ? "VERIFIED" : "ROLLBACK_REQUIRED", {
        result: ok ? "ok" : [...new Set(failures)].join(","),
        observed_service_state: this.deps.service.state,
      });
      this.state = ok ? "VERIFIED" : "ROLLBACK_REQUIRED";
    } catch {
      // Verification result is not durable: never claim VERIFIED.
      this.state = "ROLLBACK_REQUIRED";
    }
    return this.state;
  }

  /** Save the receipt; operator may resume ingress sources. */
  complete() {
    if (this.state !== "VERIFIED") return this.state;
    this.#jSafe("complete", "result", this.state, "COMPLETE", { result: "ok" });
    this.state = "COMPLETE";
    return this.state;
  }

  /**
   * Rollback (plan §17.4): stop the candidate if it is still running and
   * CONFIRM the stop, keep the failed runtime as evidence (never delete it),
   * restore the backup runtime to live by manifest tree, restore EXACTLY the
   * prior state of the two limit overrides through the config adapter
   * (including keys that were unset), then ONE bounded baseline start request
   * judged by the baseline's own schema with restart stability. Any ambiguity
   * ends in MANUAL_RECOVERY_REQUIRED without loops.
   */
  async rollback() {
    if (this.state !== "ROLLBACK_REQUIRED") return this.state;
    try {
      this.#j("rollback", "intent", this.state, "ROLLED_BACK", { result: "ok" });
    } catch {
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    const { deadlineMs, healthTimeoutMs } = this.#startup();
    if (this.deps.service.state === "running") {
      await this.deps.service.stop();
      if (!(await this.deps.service.isStopped())) {
        this.#jSafe("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", { result: "candidate-stop-unconfirmed" });
        this.state = "MANUAL_RECOVERY_REQUIRED";
        return this.state;
      }
    }
    // Keep the failed runtime as evidence under deployment_id; never delete.
    const failedDir = path.join(this.deps.slots.failedRuntimesDir, this.deps.manifest.deployment_id);
    try {
      if (this.deps.fsadapter.exists(this.deps.slots.liveDir)) {
        this.deps.fsadapter.mkdir(failedDir, { recursive: true });
        this.#copyTree(this.deps.slots.liveDir, failedDir);
      }
    } catch (err) {
      this.#jSafe("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", { result: `evidence-copy-failed:${err.message}` });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    const backup = this.#verifyTree(this.deps.slots.backupDir, this.deps.manifest.baseline);
    if (!backup.ok) {
      this.#jSafe("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", {
        result: "backup-tree-mismatch",
        path_hashes: { backup: backup.sha256 },
      });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    // Restore EXACTLY the prior override state (unset keys stay unset).
    if (!this.priorOverrides) {
      this.#jSafe("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", { result: "prior-overrides-unknown" });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    try {
      const restored = this.deps.configAdapter.restoreOverrides(this.priorOverrides);
      if (restored && typeof restored.then === "function") await restored;
      const curMaybe = this.deps.configAdapter.currentOverrides();
      const cur = curMaybe && typeof curMaybe.then === "function" ? await curMaybe : curMaybe;
      if (!this.#overridesEqual(cur, this.priorOverrides)) throw new Error("restored-overrides-mismatch");
    } catch (err) {
      this.#jSafe("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", { result: `override-restore-failed:${err.message}` });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    // Restore the backup runtime to live by whole-directory rename. The
    // failed candidate runtime has already been preserved under
    // failedRuntimesDir, so the live slot is freed first; a rename cannot
    // replace a non-empty directory, and mixing candidate leftovers into the
    // restored baseline would create a mixed old/new runtime.
    try {
      if (this.deps.fsadapter.exists(this.deps.slots.liveDir)) {
        this.deps.fsadapter.rmTree(this.deps.slots.liveDir);
      }
      this.deps.fsadapter.rename(this.deps.slots.backupDir, this.deps.slots.liveDir);
    } catch (err) {
      this.#jSafe("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", { result: `restore-rename-failed:${err.message}` });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    try {
      this.deps.fsadapter.fsyncDir(this.#slotsRoot());
    } catch (err) {
      this.#jSafe("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", { result: `restore-rename-durability-unconfirmed:${err.message}` });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    const live = this.#verifyTree(this.deps.slots.liveDir, this.deps.manifest.baseline);
    if (!live.ok) {
      this.#jSafe("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", {
        result: "restore-tree-mismatch",
        path_hashes: { live: live.sha256 },
      });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    // ONE baseline start request, bounded, judged by the baseline's own schema.
    if (this.startedBaseline) {
      this.#jSafe("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", { result: "baseline-start-already-attempted" });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    this.startedBaseline = true;
    const before = this.deps.service.supervisor();
    try {
      await this.#bounded(this.deps.service.start(), deadlineMs, "baseline start");
    } catch (err) {
      this.#jSafe("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", { result: `baseline-start-failed:${err.message}` });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    let health = null;
    try {
      health = await this.#bounded(this.deps.service.health(), healthTimeoutMs, "baseline health");
    } catch (err) {
      this.#jSafe("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", { result: `baseline-health-failed:${err.message}` });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    const after = this.deps.service.supervisor();
    const stable = after.restarts === before.restarts && after.startCount - before.startCount === 1;
    if (!stable) {
      this.#jSafe("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", { result: "baseline-restart-instability" });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    const ok = this.deps.service.verifyBaselineSchema(health, this.baselineHealthSnapshot);
    if (!ok) {
      this.#jSafe("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", { result: "baseline-health-failed" });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    try {
      this.#j("rollback", "result", this.state, "ROLLED_BACK", {
        result: "ok",
        observed_service_state: this.deps.service.state,
      });
    } catch {
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    this.state = "ROLLED_BACK";
    return this.state;
  }

  /**
   * Crash/resume: reconcile journal intents against filesystem + service
   * evidence. The journal is a hint, never the sole truth (plan §17.3); slot
   * identity is judged by WHOLE-tree hashes.
   */
  resume() {
    const live = this.#treeState(this.deps.slots.liveDir);
    const backup = this.#treeState(this.deps.slots.backupDir);
    const candidate = this.#treeState(this.deps.slots.candidateDir);
    const started = this.deps.service.supervisor().startCount;
    const ambiguous = (why) => {
      this.#jSafe("resume", "result", this.state, "MANUAL_RECOVERY_REQUIRED", {
        result: why,
        path_hashes: { live: live.sha256, backup: backup.sha256, candidate: candidate.sha256 },
        observed_service_state: this.deps.service.state,
      });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    };
    if (!live.exists && backup.exists && backup.sha256 === this.deps.manifest.baseline.tree_sha256) {
      // Live slot empty, backup correct: restore is the only safe move.
      try {
        this.deps.fsadapter.rename(this.deps.slots.backupDir, this.deps.slots.liveDir);
        this.deps.fsadapter.fsyncDir(this.#slotsRoot());
      } catch (err) {
        return ambiguous(`restore-failed:${err.message}`);
      }
      this.#jSafe("resume", "result", this.state, "QUIESCENT", {
        result: "restored-baseline-from-backup",
        path_hashes: { live: backup.sha256 },
      });
      this.state = "QUIESCENT";
      return this.state;
    }
    if (
      live.exists &&
      live.sha256 === this.deps.manifest.candidate.tree_sha256 &&
      backup.exists &&
      backup.sha256 === this.deps.manifest.baseline.tree_sha256
    ) {
      if (started === 0) {
        // Candidate published but provably never started: verify/start once.
        this.#jSafe("resume", "result", this.state, "CANDIDATE_PUBLISHED", { result: "candidate-published-not-started" });
        this.state = "CANDIDATE_PUBLISHED";
        return this.state;
      }
      return ambiguous("ambiguous-slot-or-start-state"); // start may already have happened; do not replay
    }
    if (
      live.exists &&
      live.sha256 === this.deps.manifest.baseline.tree_sha256 &&
      candidate.exists &&
      candidate.sha256 === this.deps.manifest.candidate.tree_sha256
    ) {
      // Live is still the baseline and the candidate was never published:
      // conclude as if the runtime was never changed.
      this.#jSafe("resume", "result", this.state, "BLOCKED_BEFORE_STOP", { result: "no-runtime-change" });
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    return ambiguous("ambiguous-slot-or-start-state");
  }
}

export function realFsAdapter() {
  return {
    rename: (a, b) => fs.renameSync(a, b),
    mkdir: (d, o) => fs.mkdirSync(d, o),
    copyFile: (a, b) => fs.copyFileSync(a, b),
    writeFile: (p, c) => fs.writeFileSync(p, c),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    readFileBuf: (p) => fs.readFileSync(p),
    readdir: (d) => fs.readdirSync(d, { withFileTypes: true }),
    stat: (p) => fs.statSync(p),
    exists: (p) => fs.existsSync(p),
    rmTree: (p) => fs.rmSync(p, { recursive: true, force: true }),
    fsyncDir(dir) {
      let fd = null;
      try {
        fd = fs.openSync(dir, "r");
      } catch (err) {
        // Some platforms cannot open directories at all: nothing to sync.
        if (["EPERM", "EISDIR", "EACCES", "ENOTDIR", "ENOENT"].includes(err.code)) return;
        throw err;
      }
      try {
        fs.fsyncSync(fd);
      } catch (err) {
        // Windows cannot fsync directory handles: treat as a no-op.
        if (["EPERM", "EISDIR", "EINVAL", "ENOTSUP", "EBADF"].includes(err.code)) return;
        throw err;
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}

/**
 * Durable JSONL journal: append() buffers, flush() writes every pending
 * record to the sink and fsyncs the file so the intent is durable before the
 * next destructive transition is allowed. A write/sync failure propagates to
 * the machine, which blocks before mutating anything.
 */
export function memoryJournal(sinkPath) {
  const records = [];
  let fd = null;
  let flushed = 0;
  return {
    append(record) {
      records.push(record);
    },
    flush() {
      if (records.length === flushed) return;
      if (fd === null) fd = fs.openSync(sinkPath, "a");
      for (let i = flushed; i < records.length; i++) {
        fs.writeSync(fd, `${JSON.stringify(records[i])}\n`);
      }
      fs.fsyncSync(fd);
      flushed = records.length;
    },
    records() {
      return records.slice();
    },
    close() {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed */
        }
        fd = null;
      }
    },
  };
}

export function memoryLocks() {
  const held = new Map();
  return {
    acquire(deploymentId, runnerId) {
      if (held.has(deploymentId) && held.get(deploymentId).runnerId !== runnerId) return false;
      held.set(deploymentId, { runnerId, at: Date.now() });
      return true;
    },
    verify(deploymentId) {
      return held.has(deploymentId);
    },
    release(deploymentId) {
      held.delete(deploymentId);
    },
  };
}
