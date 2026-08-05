import { spawn } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Scratch space for verification evidence. Honours GOAL_SCRATCH when the caller
// sets one; otherwise a per-run temp directory on whichever OS this is.
const scratch =
  process.env.GOAL_SCRATCH || fs.mkdtempSync(path.join(os.tmpdir(), "clc-verification-"));

const child = spawn(process.execPath, [path.join(root, "scripts/capture-verification-evidence.mjs")], {
  cwd: root,
  env: { ...process.env, GOAL_SCRATCH: scratch },
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 1));