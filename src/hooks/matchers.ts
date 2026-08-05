/**
 * Tool-name matching for hook entries.
 *
 * The matcher is the Claude Code shape: a regex over the tool name, with an
 * absent or empty matcher meaning "every tool". A matcher that is not valid
 * regex is treated as a literal name rather than being dropped, so a typo like
 * `write_file(` still fires on nothing instead of throwing during a tool call.
 */

const cache = new Map<string, RegExp | null>();

function compile(matcher: string): RegExp | null {
  if (cache.has(matcher)) return cache.get(matcher) ?? null;
  let regex: RegExp | null;
  try {
    regex = new RegExp(`^(?:${matcher})$`, "i");
  } catch {
    regex = null;
  }
  cache.set(matcher, regex);
  return regex;
}

export function matchesTool(matcher: string | undefined, tool: string): boolean {
  const pattern = matcher?.trim();
  if (!pattern || pattern === "*") return true;

  const regex = compile(pattern);
  if (!regex) return pattern.toLowerCase() === tool.toLowerCase();
  return regex.test(tool);
}

export function resetMatcherCache(): void {
  cache.clear();
}
