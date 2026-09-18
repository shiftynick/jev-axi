/**
 * Pre-tool-use safety check for coding agents.
 *
 * Given a tool call an agent is about to make, decide one of:
 *   allow  - say nothing; the agent's normal permission flow applies (never auto-approves)
 *   ask    - escalate to the user
 *   deny   - block, with a reason the agent sees
 *
 * Clearly routine calls are decided locally without an API call. Everything else is sent to
 * Jev with obvious secrets redacted.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { EntryType } from "@typesafe-ai/sdk";

export type Decision = "allow" | "ask" | "deny";

export interface ToolCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd?: string;
}

export interface LocalVerdict {
  decision: "allow" | "evaluate";
  reason: string;
}

// ------------------------------------------------------------------ redaction

/** Patterns specific enough that a match is almost certainly a real credential. */
const STRONG_SECRET_COUNT = 8;

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/g, "[REDACTED STRIPE KEY]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED API KEY]"],
  [/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, "[REDACTED GITHUB TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS KEY]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[REDACTED SLACK TOKEN]"],
  [/\bapikey_[A-Za-z0-9_]{16,}/g, "[REDACTED API KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED JWT]"],
  [/(\b(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED AUTH TOKEN]"],
  [/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1[REDACTED URL PASSWORD]@"],
  [/\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*)(?!\[REDACTED)("[^"]*"|'[^']*'|[^\s'";&|]+)/gi, "$1[REDACTED VALUE]"],
];

/** Credentials matched by the specific patterns (private keys, vendor token formats, JWTs). */
export function findStrongSecrets(text: string): string[] {
  const kinds: string[] = [];
  for (const [re, replacement] of SECRET_PATTERNS.slice(0, STRONG_SECRET_COUNT)) {
    if (new RegExp(re.source, re.flags.replace("g", "")).test(text)) kinds.push(replacement.replace(/^\[REDACTED |\]$/g, "").toLowerCase());
  }
  return kinds;
}

/** Values that are clearly not a literal credential: references, placeholders, type names. */
const NOT_A_LITERAL = /^(?:\$|<|%|\{\{|process\.env|os\.environ|import\.meta|(?:string|number|boolean|null|undefined|true|false|none)\b)|^[*x.]+$/i;

/**
 * Credentials matched only by the generic patterns (auth headers, URL passwords,
 * `PASSWORD=`-style assignments). Too loose to block on, but redaction hides the value
 * from the model, so they have to be reported locally or nothing judges them.
 */
export function findPossibleSecrets(text: string): string[] {
  const kinds: string[] = [];
  const [bearer, url, assign] = SECRET_PATTERNS.slice(STRONG_SECRET_COUNT).map(([re]) => new RegExp(re.source, re.flags.replace("g", "")));
  if (bearer!.test(text)) kinds.push("auth token");
  const u = url!.exec(text);
  if (u && !NOT_A_LITERAL.test(u[0].slice(u[1]!.length))) kinds.push("url password");
  const a = assign!.exec(text);
  if (a) {
    const raw = a[2]!;
    const quoted = /^["']/.test(raw);
    const value = raw.replace(/^["']|["']$/g, "");
    // Unquoted values only count in dotenv-style `NAME=value` lines; `password: string` is a type, `token = getToken()` a call.
    const dotenv = /^\s*(?:export\s+)?[A-Z0-9_]+=/.test(text);
    if (value.length >= 8 && (quoted || dotenv) && !NOT_A_LITERAL.test(value) && !/[()]/.test(value)) kinds.push("credential value");
  }
  return kinds;
}

/** Replace credential-looking values so they are never sent off the machine. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

// ------------------------------------------------------------------ local fast path

const SIMPLE_READ_COMMANDS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "grep", "rg", "egrep", "fgrep", "sort", "uniq", "cut", "tr", "jq",
  "which", "echo", "printf", "date", "stat", "file", "du", "df", "tree", "basename", "dirname", "realpath",
  "diff", "cd", "true", "nl", "column", "whoami", "uname", "tsc", "vitest", "eslint", "pytest", "mypy",
]);
const GIT_READ = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "grep", "describe", "shortlog", "branch", "remote", "fetch", "stash list"]);
const PKG_SCRIPTS = /^(test|lint|typecheck|check|format:check|build)$/;
/** Project build output and dependency folders that are always safe to delete and recreate. */
const REBUILDABLE = /^(\.\/)?(node_modules|dist|build|out|\.next|\.nuxt|\.turbo|\.cache|coverage|target|__pycache__|\.pytest_cache|\.venv|venv|tmp)\/?$/;

function splitSegments(command: string): string[] {
  return command.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
}

function words(segment: string): string[] {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

/** Why a single shell segment is routine, or undefined when it needs a real check. */
function routineSegment(segment: string): boolean {
  const w = words(segment);
  if (!w.length) return true;
  const [cmd, ...rest] = w;
  const args = rest.join(" ");
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd!)) return false; // env assignment may hide anything
  if (SIMPLE_READ_COMMANDS.has(cmd!)) return true;
  if (cmd === "sed") return !/(^|\s)(-i|--in-place)\b/.test(args);
  if (cmd === "find") return !/\s?-(delete|exec|execdir|ok|okdir|fprint)\b/.test(` ${args}`);
  if (cmd === "git") {
    const sub = rest[0] ?? "";
    if (sub === "branch") return !/\s-(d|D|m|M|c|C)\b|--delete|--move|--force/.test(` ${args}`);
    if (sub === "remote") return rest.length === 1 || rest[1] === "-v";
    if (sub === "stash") return rest[1] === "list";
    return GIT_READ.has(sub);
  }
  if (cmd === "rm") {
    const targets = rest.filter((a) => !a.startsWith("-"));
    return targets.length > 0 && targets.every((a) => REBUILDABLE.test(a));
  }
  if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn" || cmd === "bun") {
    if (PKG_SCRIPTS.test(rest[0] ?? "")) return true;
    // Installing the project's own declared dependencies (no new package names).
    if (/^(install|i|ci)$/.test(rest[0] ?? "") && rest.slice(1).every((a) => a.startsWith("-"))) return true;
    if (rest[0] === "run" && PKG_SCRIPTS.test(rest[1] ?? "")) return true;
    return false;
  }
  if (cmd === "npx" || cmd === "pnpx") return /^(tsc|vitest|eslint|prettier|oxlint)$/.test(rest[0] ?? "") && !/--write\b/.test(args);
  if (cmd === "cargo") return /^(test|build|check|clippy|fmt)$/.test(rest[0] ?? "") && !(rest[0] === "fmt" && !/--check/.test(args));
  if (cmd === "go") return /^(test|build|vet)$/.test(rest[0] ?? "");
  if (cmd === "gh") {
    if (rest[0] === "api") return !/\s(-X|--method|-f|-F|--field|--raw-field|--input)\b/.test(` ${args}`);
    return /^(pr|issue|run|repo|release|workflow)$/.test(rest[0] ?? "") && /^(view|list|status|checks|diff)$/.test(rest[1] ?? "");
  }
  return false;
}

/** Matched against the resolved path with forward slashes, so it also works for Windows paths. */
const SENSITIVE_PATH = /(^|\/)(\.ssh|\.gnupg|\.aws|\.kube|\.docker)(\/|$)|authorized_keys|known_hosts|\.(bash|zsh|fish)rc$|\.profile$|\.bash_profile$|(^|\/)\.git\/(hooks|config)(\/|$)|^([a-z]:)?\/etc\/|(^|\/)\.config\/(systemd|autostart)\//i;

function insideDir(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(dir, path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Decide routine calls locally; everything else goes to Jev. */
export function localVerdict(call: ToolCall): LocalVerdict {
  const cwd = call.cwd ?? process.cwd();
  const input = call.tool_input ?? {};
  switch (call.tool_name) {
    case "Bash": {
      const command = String(input["command"] ?? "").trim();
      if (!command) return { decision: "allow", reason: "empty command" };
      // Substitution, redirection to files, eval, and privilege escalation can hide intent.
      const stripped = command.replace(/\d?>\s*&\d|\d?>\s*\/dev\/null/g, "");
      if (/\$\(|`|<\(|>\s*[^&\s]|>>|\beval\b|\bsudo\b|\bsu\b|\bdoas\b/.test(stripped)) {
        return { decision: "evaluate", reason: "command uses substitution, redirection, or privilege escalation" };
      }
      const segments = splitSegments(stripped);
      return segments.every(routineSegment)
        ? { decision: "allow", reason: "routine read-only or project command" }
        : { decision: "evaluate", reason: "command is not on the routine list" };
    }
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const target = String(input["file_path"] ?? input["notebook_path"] ?? "");
      if (!target) return { decision: "evaluate", reason: "no target path" };
      const abs = resolve(cwd, target.replace(/^~(?=[\\/])/, homedir()));
      const slashed = abs.replace(/\\/g, "/");
      if (SENSITIVE_PATH.test(slashed)) return { decision: "evaluate", reason: "target is a sensitive file" };
      if (insideDir(abs, cwd) || insideDir(abs, tmpdir()) || /^([a-z]:)?\/tmp\//i.test(slashed)) {
        return { decision: "allow", reason: "edit inside the project" };
      }
      return { decision: "evaluate", reason: "edit outside the project" };
    }
    default:
      return { decision: "allow", reason: `${call.tool_name} is not checked` };
  }
}

// ------------------------------------------------------------------ state for Jev

const SCRIPT_RUN = /(?:^|\s|&&|;)(?:(?:bash|sh|zsh|python3?|node|ruby|perl|deno run|bun run|tsx)\s+)?((?:\.{1,2}\/|\/)?[\w./-]+\.(?:sh|bash|py|js|mjs|cjs|ts|rb|pl))\b|(?:^|\s|&&|;)(\.\/[\w./-]+)/g;
const MAX_SCRIPT_CHARS = 4000;
const MAX_CONTENT_CHARS = 3000;

/** What Jev sees: the call with secrets redacted, plus the contents of any local script it runs. */
export function buildSafetyState(call: ToolCall): EntryType {
  const cwd = call.cwd ?? process.cwd();
  const input = call.tool_input ?? {};
  const state: Record<string, EntryType> = { tool: call.tool_name, cwd };
  if (call.tool_name === "Bash") {
    const command = String(input["command"] ?? "");
    state["command"] = redactSecrets(command);
    const scripts: Record<string, string> = {};
    for (const m of command.matchAll(SCRIPT_RUN)) {
      const path = m[1] ?? m[2];
      if (!path) continue;
      const abs = resolve(cwd, path);
      try {
        if (insideDir(abs, cwd) && existsSync(abs) && statSync(abs).isFile() && statSync(abs).size < 512_000) {
          const text = readFileSync(abs, "utf8");
          scripts[path] = redactSecrets(text.length > MAX_SCRIPT_CHARS ? `${text.slice(0, MAX_SCRIPT_CHARS)}\n... (truncated)` : text);
        }
      } catch {
        // unreadable: judge the command alone
      }
    }
    if (Object.keys(scripts).length) state["local_scripts_run"] = scripts;
  } else {
    state["file_path"] = String(input["file_path"] ?? input["notebook_path"] ?? "");
    const content = String(input["content"] ?? input["new_string"] ?? "");
    if (content) state["content_excerpt"] = redactSecrets(content.slice(0, MAX_CONTENT_CHARS));
  }
  return state;
}

// ------------------------------------------------------------------ decision

export interface SafetyScores {
  hazards: Record<string, number>;
  risk: number;
}

export interface SafetyThresholds {
  /** Any hazard at or above this blocks. */
  denyHazard: number;
  /** Any hazard at or above this asks the user. */
  askHazard: number;
  /** Risk score (0..2) at or above this asks the user. */
  askRisk: number;
}

export const DEFAULT_SAFETY_THRESHOLDS: SafetyThresholds = { denyHazard: 0.8, askHazard: 0.45, askRisk: 1.5 };

/** Hazards that justify blocking on their own. Touching files outside the project is only a
 * reason to ask, unless the damage it could do is also high. */
const BLOCKING_HAZARDS = new Set(["destructive", "exfiltration", "remote_code", "weakens_security"]);

export function decide(scores: SafetyScores, t: SafetyThresholds = DEFAULT_SAFETY_THRESHOLDS): { decision: Decision; top: [string, number] } {
  const ranked = Object.entries(scores.hazards).sort((a, b) => b[1] - a[1]);
  const top = ranked[0] ?? ["none", 0];
  const blocking = ranked.find(([k, v]) => BLOCKING_HAZARDS.has(k) && v >= t.denyHazard);
  if (blocking) return { decision: "deny", top: blocking };
  if (top[1] >= t.denyHazard && scores.risk >= t.askRisk) return { decision: "deny", top };
  if (top[1] >= t.askHazard || scores.risk >= t.askRisk) return { decision: "ask", top };
  return { decision: "allow", top };
}

const HAZARD_TEXT: Record<string, string> = {
  destructive: "irreversible deletion or overwrite of data",
  exfiltration: "sending secrets or private files off the machine",
  remote_code: "downloading and running unreviewed code",
  weakens_security: "weakening security controls",
  outside_project: "changing files or state outside the project",
};

export function reasonText(decision: Decision, top: [string, number], risk: number, audience: "agent" | "human" = "agent"): string {
  const what = HAZARD_TEXT[top[0]] ?? top[0];
  const head = `jev-axi safety check: likely ${what} (p=${top[1].toFixed(2)}, risk ${risk.toFixed(1)} of 2).`;
  if (audience === "human") return decision === "deny" ? `${head} Blocked; run it directly if you are sure it is intended.` : `${head} Needs confirmation.`;
  return decision === "deny"
    ? `${head} Blocked. If this is really intended, explain it to the user and let them run it or approve it themselves.`
    : `${head} Needs explicit user approval before running.`;
}

/** Hook output for the agent. `allow` prints nothing so the normal permission flow applies. */
export function hookOutput(decision: Decision, reason: string, agent: "claude" | "codex"): string {
  if (decision === "allow") return "";
  // Codex supports only deny today, so escalations become a deny that asks the agent to get approval.
  const permissionDecision = agent === "codex" ? "deny" : decision;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason } });
}
