/**
 * Deployment state machine + journal for the project-memory cutover
 * (plan §17.2–17.4, review REV-R02 / F23).
 *
 * This module is the rehearsal logic an operator is expected to drive during a
 * coordinated maintenance: every mutation is preceded by a journal intent
 * record, followed by a result record; slot changes are rename-only; start
 * attempts are budgeted (one candidate start, one baseline start per
 * transition); rollback judges the baseline by its OWN schema.
 *
 * It is fully adapter-injected: filesystem operations, service control,
 * health probing, supervisor observation, journal sink and lock backend are
 * supplied by the caller. The F23 test suite drives it with test-owned temp
 * slot directories and a fake service/supervisor; nothing here touches a real
 * host, service unit, tunnel or production path.
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

export function fileState(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) out[entry.name] = sha256OfFile(path.join(dir, entry.name));
  }
  return out;
}

/**
 * @param {object} deps
 *  - slots: { liveDir, candidateDir, backupDir, failedRuntimesDir, journalPath, lockPath }
 *  - manifest: { source_sha, baseline_live_sha256, candidate_sha256, deployment_id }
 *  - approval: { schema, plan_sha256, candidate_source_sha, service_identity,
 *      operator, approval_ref_C, ingress_inventory_ref, client_ack_refs,
 *      job_inventory_ref, quiescence_verified_at, cutover_expires_at,
 *      out_of_band_control_ref, admission_pause_method, resume_owner, state }
 *  - service: adapter (see below)
 *  - fsadapter: { rename, readdir, readFile, writeFile, exists, stat, sha256 } — injected
 *    so the tests can fault-inject at exact steps; defaults to real fs
 *  - journal: { append(record), flush(), records() }
 *  - locks: { acquire(deploymentId, runnerId), verify(deploymentId) }
 *  - now: () => Date.now() (injectable clock)
 *  - startup: { deadlineMs, healthTimeoutMs, pollMs, samples }
 *
 * service adapter contract:
 *  - state: "running" | "stopped"
 *  - stop(): Promise<void> — sets state stopped
 *  - isStopped(): Promise<boolean>
 *  - start(): Promise<void> — increments startCount; may crash per fault config
 *  - health(): Promise<object> — resolves only when healthy; rejects on failure
 *  - verifyCandidate(health): boolean — identity/schema/limits checks
 *  - verifyBaselineSchema(health): boolean — baseline judged by its OWN schema
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
    this.deps.journal.append(record);
    this.deps.journal.flush();
    this.opTrace.push(record);
    return record;
  }

  #move(from, to, transition, label, sourceState, targetState) {
    this.deps.fsadapter.rename(from, to);
    const hashes = { [label]: sha256OfFile(to) };
    this.#j(transition, "result", sourceState, targetState, {
      path_hashes: hashes,
      result: "ok",
    });
    return hashes;
  }

  /** Validate approval receipt + release manifest + deploy lock. */
  plan(approval, runnerId) {
    const a = approval ?? {};
    const ok =
      a.schema === "clc.memory-maintenance.v1" &&
      typeof a.plan_sha256 === "string" &&
      a.plan_sha256.length === 64 &&
      typeof a.candidate_source_sha === "string" &&
      a.candidate_source_sha === this.deps.manifest.source_sha &&
      typeof a.service_identity === "string" &&
      typeof a.operator === "string" &&
      typeof a.approval_ref_C === "string" &&
      Array.isArray(a.client_ack_refs) &&
      a.client_ack_refs.length > 0 &&
      typeof a.ingress_inventory_ref === "string" &&
      typeof a.job_inventory_ref === "string" &&
      typeof a.quiescence_verified_at === "string" &&
      typeof a.cutover_expires_at === "string" &&
      typeof a.out_of_band_control_ref === "string" &&
      typeof a.admission_pause_method === "string" &&
      typeof a.resume_owner === "string" &&
      (a.state === "approved" || a.state === "pending");
    this.#j("plan", "intent", this.state, ok ? "PREPARED" : "BLOCKED_BEFORE_STOP", {
      result: ok ? "ok" : "invalid-receipt",
    });
    if (!ok) {
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    const expired =
      new Date(a.cutover_expires_at).getTime() <= this.deps.now();
    if (a.state !== "approved" || expired) {
      this.#j("plan", "result", "PLANNED", "BLOCKED_BEFORE_STOP", {
        result: a.state !== "approved" ? "receipt-not-approved" : "receipt-expired",
      });
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    const locked = this.deps.locks.acquire(this.deps.manifest.deployment_id, runnerId);
    if (!locked) {
      this.#j("plan", "result", "PLANNED", "BLOCKED_BEFORE_STOP", { result: "lock-unavailable" });
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    const manifestOk =
      typeof this.deps.manifest.baseline_live_sha256 === "string" &&
      typeof this.deps.manifest.candidate_sha256 === "string";
    if (!manifestOk) {
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    this.#j("plan", "result", "PLANNED", "PREPARED", { result: "ok" });
    this.state = "PREPARED";
    return this.state;
  }

  /** Verify candidate/backup hashes before any stop. */
  prepare() {
    if (this.state !== "PREPARED") return this.state;
    this.#j("prepare", "intent", this.state, "PREPARED");
    const candidateHash = sha256OfFile(path.join(this.deps.slots.candidateDir, "index.js"));
    const liveHash = sha256OfFile(path.join(this.deps.slots.liveDir, "index.js"));
    const ok =
      candidateHash === this.deps.manifest.candidate_sha256 &&
      liveHash === this.deps.manifest.baseline_live_sha256;
    this.#j("prepare", "result", "PREPARED", ok ? "PREPARED" : "BLOCKED_BEFORE_STOP", {
      path_hashes: { candidate: candidateHash, live: liveHash },
      result: ok ? "ok" : "hash-mismatch",
    });
    if (!ok) {
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    return this.state;
  }

  /** Operator confirms all ingress sources are quiescent. */
  async quiesce() {
    if (this.state !== "PREPARED") return this.state;
    this.#j("quiesce", "intent", this.state, "QUIESCENT");
    const quiet = await this.deps.service.checkQuiescence();
    if (!quiet) {
      this.#j("quiesce", "result", this.state, "BLOCKED_BEFORE_STOP", { result: "not-quiescent" });
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    this.#j("quiesce", "result", this.state, "QUIESCENT", { result: "ok" });
    this.state = "QUIESCENT";
    return this.state;
  }

  /** Stop the serving host; rename only after stop is CONFIRMED. */
  async stop() {
    if (this.state !== "QUIESCENT") return this.state;
    this.#j("stop", "intent", this.state, "STOPPED");
    await this.deps.service.stop();
    const stopped = await this.deps.service.isStopped();
    if (!stopped) {
      this.#j("stop", "result", this.state, "QUIESCENT", {
        result: "stop-unconfirmed",
        observed_service_state: this.deps.service.state,
      });
      // No rename on an unconfirmed stop; caller must resolve with the operator.
      return this.state;
    }
    this.#j("stop", "result", this.state, "STOPPED", {
      result: "ok",
      observed_service_state: this.deps.service.state,
    });
    this.state = "STOPPED";
    return this.state;
  }

  /** Rename live→backup and verify the preserved baseline by hash. */
  preserve() {
    if (this.state !== "STOPPED") return this.state;
    this.#j("preserve", "intent", this.state, "OLD_PRESERVED");
    try {
      this.#move(path.join(this.deps.slots.liveDir, "index.js"), path.join(this.deps.slots.backupDir, "index.js"), "preserve", "backup", "STOPPED", "OLD_PRESERVED");
    } catch (err) {
      this.#j("preserve", "result", this.state, "STOPPED", { result: `rename-failed:${err.message}` });
      return this.state; // live still holds the baseline; no further mutation here
    }
    const backupHash = sha256OfFile(path.join(this.deps.slots.backupDir, "index.js"));
    if (backupHash !== this.deps.manifest.baseline_live_sha256) {
      this.#j("preserve", "result", this.state, "MANUAL_RECOVERY_REQUIRED", {
        result: "backup-hash-mismatch",
        path_hashes: { backup: backupHash },
      });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
    this.state = "OLD_PRESERVED";
    return this.state;
  }

  /** Rename candidate→live and verify the manifest hash. */
  publish() {
    if (this.state !== "OLD_PRESERVED") return this.state;
    this.#j("publish", "intent", this.state, "CANDIDATE_PUBLISHED");
    try {
      this.#move(path.join(this.deps.slots.candidateDir, "index.js"), path.join(this.deps.slots.liveDir, "index.js"), "publish", "live", "OLD_PRESERVED", "CANDIDATE_PUBLISHED");
    } catch (err) {
      this.#j("publish", "result", this.state, "ROLLBACK_REQUIRED", { result: `rename-failed:${err.message}` });
      this.state = "ROLLBACK_REQUIRED";
      return this.state;
    }
    const liveHash = sha256OfFile(path.join(this.deps.slots.liveDir, "index.js"));
    if (liveHash !== this.deps.manifest.candidate_sha256) {
      this.#j("publish", "result", this.state, "ROLLBACK_REQUIRED", {
        result: "live-hash-mismatch",
        path_hashes: { live: liveHash },
      });
      this.state = "ROLLBACK_REQUIRED";
      return this.state;
    }
    this.state = "CANDIDATE_PUBLISHED";
    return this.state;
  }

  /**
   * ONE candidate start request, then deadline-bounded verification.
   * Supervisor-triggered restarts are observed via the adapter counters and
   * are NOT masked by the single start request: any restart beyond the single
   * start fails verification.
   */
  async verifyCandidate() {
    if (this.state !== "CANDIDATE_PUBLISHED") return this.state;
    if (this.startedCandidate) {
      this.#j("verify", "result", this.state, "ROLLBACK_REQUIRED", { result: "start-already-attempted" });
      this.state = "ROLLBACK_REQUIRED";
      return this.state;
    }
    this.startedCandidate = true;
    this.#j("verify", "intent", this.state, "VERIFIED");
    const before = this.deps.service.supervisor();
    await this.deps.service.start();
    const deadlineAt = this.deps.now() + this.deps.startup.deadlineMs;
    let health = null;
    let samples = 0;
    while (this.deps.now() < deadlineAt && samples < this.deps.startup.samples) {
      try {
        health = await this.deps.service.health();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, this.deps.startup.pollMs));
      }
      samples += 1;
    }
    const after = this.deps.service.supervisor();
    const restarts = after.restarts - before.restarts;
    const okHealth = health !== null;
    const okIdentity = okHealth && this.deps.service.verifyCandidate(health);
    const okRestartStability = restarts === 0 && after.startCount - before.startCount === 1;
    const ok =
      okHealth &&
      okIdentity &&
      okRestartStability &&
      this.deps.now() < deadlineAt + this.deps.startup.healthTimeoutMs;
    this.#j("verify", "result", this.state, ok ? "VERIFIED" : "ROLLBACK_REQUIRED", {
      result: ok ? "ok" : [okHealth ? "" : "health-failed", okIdentity ? "" : "identity-failed", okRestartStability ? "" : "restart-instability"].filter(Boolean).join(","),
      observed_service_state: this.deps.service.state,
    });
    this.state = ok ? "VERIFIED" : "ROLLBACK_REQUIRED";
    return this.state;
  }

  /** Save the receipt; operator may resume ingress sources. */
  complete() {
    if (this.state !== "VERIFIED") return this.state;
    this.#j("complete", "result", this.state, "COMPLETE", { result: "ok" });
    this.state = "COMPLETE";
    return this.state;
  }

  /**
   * Rollback (plan §17.4): stop the candidate if it is still running and
   * CONFIRM the stop, keep the failed runtime as evidence (never delete it),
   * restore the backup to live by hash, restore only the two changed
   * overrides, then ONE baseline start request judged by the baseline's own
   * schema. Any ambiguity ends in MANUAL_RECOVERY_REQUIRED without loops.
   */
  async rollback() {
    if (this.state !== "ROLLBACK_REQUIRED") return this.state;
    this.#j("rollback", "intent", this.state, "ROLLED_BACK");
    try {
      if (this.deps.service.state === "running") {
        await this.deps.service.stop();
        if (!(await this.deps.service.isStopped())) {
          this.#j("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", { result: "candidate-stop-unconfirmed" });
          this.state = "MANUAL_RECOVERY_REQUIRED";
          return this.state;
        }
      }
      // Keep the failed runtime as evidence under deployment_id; never delete.
      const failedDir = path.join(this.deps.slots.failedRuntimesDir, this.deps.manifest.deployment_id);
      this.deps.fsadapter.mkdir(failedDir, { recursive: true });
      if (this.deps.fsadapter.exists(path.join(this.deps.slots.liveDir, "index.js"))) {
        this.deps.fsadapter.copyFile(
          path.join(this.deps.slots.liveDir, "index.js"),
          path.join(failedDir, "candidate-index.js")
        );
      }
      // Restore the backup to live by hash.
      const backupHash = sha256OfFile(path.join(this.deps.slots.backupDir, "index.js"));
      if (backupHash !== this.deps.manifest.baseline_live_sha256) {
        this.#j("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", {
          result: "backup-hash-mismatch",
          path_hashes: { backup: backupHash },
        });
        this.state = "MANUAL_RECOVERY_REQUIRED";
        return this.state;
      }
      this.deps.fsadapter.rename(path.join(this.deps.slots.backupDir, "index.js"), path.join(this.deps.slots.liveDir, "index.js"));
      const restoredHash = sha256OfFile(path.join(this.deps.slots.liveDir, "index.js"));
      if (restoredHash !== this.deps.manifest.baseline_live_sha256) {
        this.#j("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", {
          result: "restore-hash-mismatch",
          path_hashes: { live: restoredHash },
        });
        this.state = "MANUAL_RECOVERY_REQUIRED";
        return this.state;
      }
      // Restore only the two limit overrides changed by this deployment.
      this.deps.fsadapter.writeFile(
        path.join(this.deps.slots.liveDir, "overrides.json"),
        JSON.stringify({ PROJECT_MEMORY_MAX_LINES: "200", PROJECT_MEMORY_MAX_BYTES: "25000" })
      );
      // ONE baseline start request.
      if (this.startedBaseline) {
        this.#j("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", { result: "baseline-start-already-attempted" });
        this.state = "MANUAL_RECOVERY_REQUIRED";
        return this.state;
      }
      this.startedBaseline = true;
      await this.deps.service.start();
      const health = await this.deps.service.health();
      const ok = this.deps.service.verifyBaselineSchema(health);
      if (!ok) {
        this.#j("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", { result: "baseline-health-failed" });
        this.state = "MANUAL_RECOVERY_REQUIRED";
        return this.state;
      }
      this.#j("rollback", "result", this.state, "ROLLED_BACK", { result: "ok" });
      this.state = "ROLLED_BACK";
      return this.state;
    } catch (err) {
      this.#j("rollback", "result", this.state, "MANUAL_RECOVERY_REQUIRED", { result: `error:${err.message}` });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    }
  }

  /**
   * Crash/resume: reconcile journal intents against filesystem + service
   * evidence. The journal is a hint, never the sole truth (plan §17.3).
   */
  resume() {
    const liveExists = this.deps.fsadapter.exists(path.join(this.deps.slots.liveDir, "index.js"));
    const backupExists = this.deps.fsadapter.exists(path.join(this.deps.slots.backupDir, "index.js"));
    const candidateExists = this.deps.fsadapter.exists(path.join(this.deps.slots.candidateDir, "index.js"));
    const liveHash = liveExists ? sha256OfFile(path.join(this.deps.slots.liveDir, "index.js")) : null;
    const backupHash = backupExists ? sha256OfFile(path.join(this.deps.slots.backupDir, "index.js")) : null;
    const candidateHash = candidateExists ? sha256OfFile(path.join(this.deps.slots.candidateDir, "index.js")) : null;
    const started = this.deps.service.supervisor().startCount;
    const ambiguous = () => {
      this.#j("resume", "result", this.state, "MANUAL_RECOVERY_REQUIRED", {
        result: "ambiguous-slot-or-start-state",
        path_hashes: { live: liveHash, backup: backupHash, candidate: candidateHash },
        observed_service_state: this.deps.service.state,
      });
      this.state = "MANUAL_RECOVERY_REQUIRED";
      return this.state;
    };
    if (!liveExists && backupExists && backupHash === this.deps.manifest.baseline_live_sha256) {
      // Live slot empty, backup correct: restore is the only safe move.
      this.deps.fsadapter.rename(path.join(this.deps.slots.backupDir, "index.js"), path.join(this.deps.slots.liveDir, "index.js"));
      this.#j("resume", "result", this.state, "QUIESCENT", { result: "restored-baseline-from-backup" });
      this.state = "QUIESCENT";
      return this.state;
    }
    if (
      liveExists &&
      liveHash === this.deps.manifest.candidate_sha256 &&
      backupExists &&
      backupHash === this.deps.manifest.baseline_live_sha256
    ) {
      if (started === 0) {
        // Candidate published but provably never started: verify/start once.
        this.#j("resume", "result", this.state, "CANDIDATE_PUBLISHED", { result: "candidate-published-not-started" });
        this.state = "CANDIDATE_PUBLISHED";
        return this.state;
      }
      return ambiguous(); // start may already have happened; do not replay
    }
    if (
      liveExists &&
      liveHash === this.deps.manifest.baseline_live_sha256 &&
      candidateExists &&
      candidateHash === this.deps.manifest.candidate_sha256
    ) {
      // Live is still the baseline and the candidate was never published:
      // conclude as if the runtime was never changed.
      this.#j("resume", "result", this.state, "BLOCKED_BEFORE_STOP", { result: "no-runtime-change" });
      this.state = "BLOCKED_BEFORE_STOP";
      return this.state;
    }
    return ambiguous();
  }
}

export function realFsAdapter() {
  return {
    rename: (a, b) => fs.renameSync(a, b),
    mkdir: (d, o) => fs.mkdirSync(d, o),
    copyFile: (a, b) => fs.copyFileSync(a, b),
    writeFile: (p, c) => fs.writeFileSync(p, c),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
  };
}

export function memoryJournal(sinkPath) {
  const records = [];
  return {
    append(record) {
      records.push(record);
    },
    flush() {
      fs.appendFileSync(sinkPath, `${JSON.stringify(records[records.length - 1])}\n`);
    },
    records() {
      return records;
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
