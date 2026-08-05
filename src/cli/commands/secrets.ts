/**
 * `secrets list|set|delete|path` — credential entry from a terminal.
 *
 * A value is never accepted as an argument. Command lines are readable by any
 * local user through `ps` and `/proc`, and they land in shell history, so a key
 * passed as `secrets set NAME sk-...` would leak twice over. The value is typed
 * at a hidden prompt or piped on stdin, and nothing here echoes one back.
 */

import { Writable } from "stream";
import readline from "readline";

import { KNOWN_SECRETS } from "../doctor.js";
import { deleteSecret, listSecretNames, secretsPath, setSecret } from "../../lib/secrets.js";
import { flag, parseCommand, UsageError, type CommandSpec } from "../args.js";

export const SECRETS_SUBCOMMANDS = ["list", "set", "delete", "path"];

export const SECRETS_SPEC: CommandSpec = {
  name: "secrets",
  summary: "Store the credentials the tunnel and admin API need.",
  usage: `<${SECRETS_SUBCOMMANDS.join("|")}> [name]`,
  detail:
    "`set` prompts for the value with the input hidden, or reads it from stdin when piped.\n" +
    "A value is never taken as an argument — that would expose it through `ps` and shell history.\n" +
    `Known names: ${KNOWN_SECRETS.join(", ")}.\n` +
    "Values are never printed; `list` reports only set or unset and where the value came from.",
  options: {
    json: { type: "boolean", description: "Emit JSON." },
    stdin: { type: "boolean", description: "Read the value from stdin instead of prompting." },
  },
};

/** Read a value without echoing it. Falls back to plain stdin when piped. */
async function readSecretValue(prompt: string, forceStdin: boolean): Promise<string> {
  if (forceStdin || !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf-8");
  }

  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });

  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(prompt, resolve);
      // Muted only after the prompt itself has been written, so the caller can
      // still see what is being asked for.
      muted = true;
    });
    process.stdout.write("\n");
    return answer;
  } finally {
    rl.close();
  }
}

function requireName(positionals: string[]): string {
  const name = positionals[1];
  if (!name) throw new UsageError("a secret name is required", SECRETS_SPEC);

  // A third positional is almost certainly the value itself.
  if (positionals[2]) {
    throw new UsageError(
      "a secret value must not be passed as an argument — it would be visible in `ps` and shell history.\n" +
        `Run \`chatgpt-local-coder secrets set ${name}\` and type it, or pipe it with --stdin.`,
      SECRETS_SPEC
    );
  }
  return name;
}

export async function runSecrets(argv: string[]): Promise<number> {
  const parsed = parseCommand(argv, SECRETS_SPEC);
  const sub = parsed.positionals[0] ?? "list";
  const asJson = flag(parsed.values, "json");

  if (!SECRETS_SUBCOMMANDS.includes(sub)) {
    throw new UsageError(`unknown secrets subcommand "${sub}"`, SECRETS_SPEC);
  }

  if (sub === "path") {
    console.log(secretsPath());
    return 0;
  }

  if (sub === "list") {
    const entries = await listSecretNames(KNOWN_SECRETS);
    if (asJson) {
      console.log(JSON.stringify({ path: secretsPath(), secrets: entries }, null, 2));
      return 0;
    }

    console.log(`Stored in ${secretsPath()}`);
    console.log("");
    for (const entry of entries) {
      const source = entry.source === "env" ? "environment — overrides the file" : (entry.source ?? "-");
      console.log(`  ${entry.name.padEnd(24)} ${(entry.set ? "set" : "unset").padEnd(6)} ${source}`);
    }
    console.log("");
    console.log("Names and state only — no value is ever printed.");
    return 0;
  }

  const name = requireName(parsed.positionals);

  if (sub === "delete") {
    await deleteSecret(name);
    console.log(`Removed ${name} from ${secretsPath()}.`);
    return 0;
  }

  if (!KNOWN_SECRETS.includes(name)) {
    console.warn(`Warning: ${name} is not a name this host reads. Known names: ${KNOWN_SECRETS.join(", ")}.`);
  }

  const raw = await readSecretValue(`${name}: `, flag(parsed.values, "stdin"));
  // A pasted key usually drags a trailing newline along, which would be stored
  // and then fail authentication in a way that looks arbitrary.
  const value = raw.trim();

  if (!value) {
    console.error("No value given; nothing was written.");
    return 1;
  }

  await setSecret(name, value);
  // Length only — enough to catch a truncated paste without putting any part of
  // the value on screen.
  console.log(`Saved ${name} (${value.length} characters) to ${secretsPath()}.`);

  if (name === "ADMIN_TOKEN") {
    console.log("The server reads this at startup; restart it for the change to take effect.");
  }
  return 0;
}
