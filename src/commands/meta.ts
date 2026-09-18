import { existsSync, readdirSync, readFileSync } from "node:fs";
import { configureAgent } from "./agent.js";
import { configureGitHooks } from "./githooks.js";
import { configureSuperviseHooks, SUPERVISE_HOOK_COMMAND, configureSafetyHook, safetyHookPath as configureSafetyHookPath, SAFETY_HOOK_COMMAND } from "./hook.js";
import type { Renderable as AxiRenderable } from "./common.js";
import { AxiError, installSessionStartHooks, sessionStartHookStatus } from "axi-sdk-js";
import { numberFlag, parseArgs } from "../args.js";
import { cacheStats, clearCache, listModels } from "../client.js";
import {
  DEFAULT_CACHE_TTL_HOURS,
  DEFAULT_MODEL,
  DEFAULT_PRICE,
  DEFAULT_THRESHOLDS,
  resolveCacheTtlHours,
  resolvePrices,
  paths,
  readConfig,
  redactKey,
  resolveApiKey,
  resolveModel,
  writeConfig,
  type JevConfig,
} from "../config.js";
import { validation } from "../errors.js";
import { round } from "../format.js";
import { estimateCost, formatCost, formatTokens, groupUsage, readUsage, totals, type GroupBy } from "../usage.js";

export const MODELS_HELP = `usage: jev-axi models
List the models available to this API key.
`;

export async function modelsCommand(args: string[]): Promise<AxiRenderable> {
  const p = parseArgs(args, {}, "models");
  const models = await listModels();
  const current = resolveModel(p.values["--model"]);
  const rows = models.map((m) => ({ name: m.name, released: m.release_date.slice(0, 10), current: m.name === current ? "yes" : "", description: m.description }));
  if (p.bools["--json"]) return JSON.stringify(models, null, 2);
  return { models: rows, help: ["Pass --model <name> to any command, or `jev-axi config set model <name>`"] };
}

export const USAGE_HELP = `usage: jev-axi usage [--days N] [--by command|day|model] [--json]
Token usage and estimated spend from the local ledger (the API has no spend endpoint; every call is logged here).
flags:
  --days <n>           window in days (default 7; 0 = all time)
  --by <group>         command (default), day, model, or project
notes:
  Costs assume $${DEFAULT_PRICE.input} per 1M input tokens and free output; override with jev-axi config set price.input / price.output
  Cached calls are listed separately as saved tokens.
examples:
  jev-axi usage
  jev-axi usage --days 30 --by day
`;

export async function usageCommand(args: string[]): Promise<AxiRenderable> {
  const p = parseArgs(args, { "--days": "value", "--by": "value" }, "usage");
  const days = numberFlag(p, "--days", 7, 0);
  const by = (p.values["--by"] ?? "command") as GroupBy;
  if (!["command", "day", "model", "project"].includes(by)) throw validation(`--by must be command, day, model, or project`);
  const entries = readUsage(days === 0 ? undefined : days);
  const price = resolvePrices();
  const t = totals(entries);
  const cost = estimateCost(t.input, t.output, price);
  const saved = estimateCost(t.saved_input, t.saved_output, price);
  const window = days === 0 ? "all time" : `last ${days} day${days === 1 ? "" : "s"}`;
  if (p.bools["--json"]) return JSON.stringify({ window, totals: t, cost, saved, entries }, null, 2);
  if (entries.length === 0) {
    return { usage: `0 calls recorded in the ${window}`, ledger: paths.usageLedger(), help: ["Run any jev-axi command; every API call is logged locally"] };
  }
  const groups: Record<string, unknown>[] = [...groupUsage(entries, by)].map(([key, list]) => {
    const g = totals(list);
    const c = estimateCost(g.input, g.output, price);
    return {
      [by]: key,
      calls: g.calls,
      cached: g.cached_calls,
      questions: g.questions,
      input: g.input,
      output: g.output,
      avg_ms: g.billed_calls ? Math.round(g.ms / g.billed_calls) : 0,
      cost: formatCost(c),
    };
  });
  if (by === "day") groups.sort((a, b) => String(b[by]).localeCompare(String(a[by])));
  else groups.sort((a, b) => Number(b["calls"]) - Number(a["calls"]));
  const out: Record<string, unknown> = {
    window,
    calls: `${t.calls} (${t.billed_calls} billed, ${t.cached_calls} cached)`,
    tokens: `${formatTokens(t.input)} in / ${formatTokens(t.output)} out billed; ${formatTokens(t.saved_input)} in / ${formatTokens(t.saved_output)} out saved by cache`,
    questions: t.questions,
    avg_ms: t.billed_calls ? Math.round(t.ms / t.billed_calls) : 0,
  };
  out["cost"] = `${formatCost(cost)} estimated at $${price.input}/$${price.output} per 1M in/out${saved ? ` (${formatCost(saved)} saved by cache)` : ""}`;
  out[`by_${by}`] = groups;
  const help: string[] = [];
  help.push(`Run \`jev-axi usage --by ${by === "day" ? "command" : "day"}\` for another view, or \`jev-axi stats\` for lifetime trends`);
  return { ...out, help };
}

export const CONFIG_HELP = `usage: jev-axi config [set <key> <value> | unset <key>]
Show or change persistent settings in ${paths.configFile()}.
keys:
  apiKey           TypeSafe API key (env TYPESAFE_API_KEY and ./.env take precedence)
  model            default model (default ${DEFAULT_MODEL})
  price.input      USD per 1M input tokens (default ${DEFAULT_PRICE.input})
  price.output     USD per 1M output tokens (default ${DEFAULT_PRICE.output})
  act, confirm     band thresholds on confidence (default ${DEFAULT_THRESHOLDS.act} / ${DEFAULT_THRESHOLDS.confirm})
  cacheTtlHours    hours a cached response is reused (default ${DEFAULT_CACHE_TTL_HOURS}; 0 disables the cache)
examples:
  jev-axi config
  jev-axi config set model jev-preview
  jev-axi config set price.input 0.10
`;

export async function configCommand(args: string[]): Promise<AxiRenderable> {
  const p = parseArgs(args, {}, "config");
  const [action, key, value] = p.positional;
  const config = readConfig();
  if (!action) return showConfig(config);
  if (action !== "set" && action !== "unset") throw validation(`unknown config action ${JSON.stringify(action)}`, ["jev-axi config set <key> <value>", "jev-axi config unset <key>"]);
  if (!key) throw validation(`config ${action} needs a key`, [CONFIG_HELP.split("\n").slice(3, 8).join("; ")]);
  if (action === "set" && value === undefined) throw validation(`config set ${key} needs a value`);
  const next = applyConfig(config, key, action === "set" ? value : undefined);
  writeConfig(next);
  return { config: `${key} ${action === "set" ? "set" : "unset"}`, ...showConfig(next) };
}

function applyConfig(c: JevConfig, key: string, value: string | undefined): JevConfig {
  const num = (): number | undefined => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw validation(`${key} must be a non-negative number`);
    return n;
  };
  const next: JevConfig = { ...c, price: { ...c.price }, thresholds: { ...c.thresholds } };
  switch (key) {
    case "apiKey": next.apiKey = value; break;
    case "model": next.model = value; break;
    case "price.input": next.price!.input = num(); break;
    case "price.output": next.price!.output = num(); break;
    case "act": next.thresholds!.act = num(); break;
    case "confirm": next.thresholds!.confirm = num(); break;
    case "cacheTtlHours": next.cacheTtlHours = num(); break;
    default: throw validation(`unknown config key ${JSON.stringify(key)}`, ["valid keys: apiKey, model, price.input, price.output, act, confirm, cacheTtlHours"]);
  }
  return next;
}

function showConfig(c: JevConfig): Record<string, unknown> {
  const key = resolveApiKey(c);
  return {
    file: paths.configFile(),
    apiKey: key.key ? `${redactKey(key.key)} (from ${key.file ?? key.source})` : "missing",
    model: resolveModel(undefined, c),
    price: `$${resolvePrices(c).input}/1M in, $${resolvePrices(c).output}/1M out${c.price?.input === undefined && c.price?.output === undefined ? " (default)" : ""}`,
    thresholds: `act >= ${c.thresholds?.act ?? DEFAULT_THRESHOLDS.act}, confirm >= ${c.thresholds?.confirm ?? DEFAULT_THRESHOLDS.confirm}`,
    cache: `${cacheCount()} responses in ${paths.cacheDir()}, reused for ${resolveCacheTtlHours(c)}h`,
  };
}

export function cacheCount(): number {
  const dir = paths.cacheDir();
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "aliases.json").length;
}

export const CACHE_HELP = `usage: jev-axi cache [clear [--stale]]
Show or clear locally cached responses. A cached answer is reused only while it is younger than the TTL
(config key cacheTtlHours, default ${DEFAULT_CACHE_TTL_HOURS}) and was produced by the model version its alias
(e.g. jev-latest) currently resolves to, so a model update invalidates old answers automatically.
flags:
  --stale              with clear: remove only expired or superseded entries
examples:
  jev-axi cache
  jev-axi cache clear --stale
  jev-axi config set cacheTtlHours 0     # disable caching
`;

export async function cacheCommand(args: string[]): Promise<AxiRenderable> {
  const p = parseArgs(args, { "--stale": "bool" }, "cache");
  const action = p.positional[0];
  if (action && action !== "clear") throw validation(`unknown cache action ${JSON.stringify(action)}`, ["jev-axi cache", "jev-axi cache clear [--stale]"]);
  if (p.bools["--stale"] && action !== "clear") throw validation("--stale only applies to `cache clear`");
  if (action === "clear") {
    const removed = clearCache(p.bools["--stale"]);
    return { cache: removed ? `removed ${removed} ${p.bools["--stale"] ? "stale " : ""}responses` : `0 ${p.bools["--stale"] ? "stale " : ""}responses to remove (no-op)`, ...statsView() };
  }
  const view = statsView();
  const help: string[] = [];
  if (Number(view["stale"]) > 0) help.push("Run `jev-axi cache clear --stale` to delete expired or superseded responses");
  return { ...view, ...(help.length ? { help } : {}) };
}

function statsView(): Record<string, unknown> {
  const st = cacheStats();
  return {
    dir: st.dir,
    entries: st.entries,
    fresh: st.fresh,
    stale: st.stale,
    size: st.bytes < 1024 ? `${st.bytes} B` : `${Math.round(st.bytes / 1024)} KB`,
    ttl: st.ttlHours > 0 ? `${st.ttlHours}h` : "disabled",
    models: Object.keys(st.aliases).length ? Object.entries(st.aliases).map(([a, v]) => (a === v ? a : `${a} -> ${v}`)).join(", ") : "none observed yet",
  };
}

export const SETUP_HELP = `usage: jev-axi setup hooks [--project] | setup safety [--project] [--agent claude|codex] [--remove] | setup supervise [--project] [--agent claude|codex] [--block] [--remove] | setup agent [--project] [--replace-explore] [--remove] | setup git-hooks [--remove] | setup status [--project]
hooks    SessionStart hooks (Claude Code, Codex, OpenCode) so each session starts with jev-axi context.
safety   PreToolUse hook that checks Bash commands and edits outside the project before they run, and blocks or asks
         about destructive, exfiltrating, or security-weakening calls. Routine calls are decided locally. See \`jev-axi hook --help\`.
supervise  Stop and PostToolUse hooks for Claude Code or Codex: when the agent ends a turn, checks the changes against the job and
         warns if it looks unfinished or unverified; during work, notes when the agent looks stuck, off track, or
         blocked on a person. Warn-only unless --block. See \`jev-axi hook --help\`.
agent    Claude Code subagent \`jev-explore\` that ranks files with jev-axi before reading them, for broad exploration.
         Claude Code tends to explore inside subagents, which never see skills or session hooks; this puts jev-axi there.
git-hooks  pre-commit and commit-msg hooks in the current repository: blocks commits that add credentials (found
         locally), warns about risky or unfocused diffs and messages that don't match them. See \`jev-axi hook --help\`.
flags:
  --project            install into the current repository instead of the user profile
  --agent <name>       for safety and supervise: claude (default) or codex
  --block              for supervise: send the agent back to work (once per stop) instead of only warning the user
  --remove             for safety, supervise, agent, or git-hooks: uninstall
  --replace-explore    for agent: install as \`Explore\`, overriding Claude Code's built-in explorer in this scope
examples:
  jev-axi setup hooks
  jev-axi setup safety --project
  jev-axi setup safety --agent codex
  jev-axi setup git-hooks
  jev-axi setup status
`;

export async function setupCommand(args: string[]): Promise<AxiRenderable> {
  const p = parseArgs(args, { "--project": "bool", "--agent": "value", "--remove": "bool", "--replace-explore": "bool", "--block": "bool" }, "setup");
  const action = p.positional[0];
  const scope = p.bools["--project"] ? "project" : "user";
  if (action === "hooks") {
    installSessionStartHooks({ scope });
    return { hooks: { status: "installed", scope, integrations: "Claude Code, Codex, OpenCode" }, help: ["Restart your agent session to receive jev-axi ambient context"] };
  }
  if (action === "safety") {
    const agent = (p.values["--agent"] ?? "claude") as "claude" | "codex";
    if (agent !== "claude" && agent !== "codex") throw validation("--agent must be claude or codex");
    const { file, changed } = configureSafetyHook(agent, p.bools["--project"], p.bools["--remove"]);
    const status = p.bools["--remove"] ? (changed ? "removed" : "not installed (no-op)") : changed ? "installed" : "already installed (no-op)";
    const help = p.bools["--remove"]
      ? []
      : [
          "Restart the agent session to activate it",
          "Commands and edits outside the project are sent to TypeSafe's API with secrets redacted; routine calls never leave the machine",
          "Test it: echo '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"rm -rf ~/\"}}' | jev-axi hook pre-tool-use --explain",
        ];
    return { safety: { status, agent, scope, file }, ...(help.length ? { help } : {}) };
  }
  if (action === "supervise") {
    const agent = (p.values["--agent"] ?? "claude") as "claude" | "codex";
    if (agent !== "claude" && agent !== "codex") throw validation("--agent must be claude or codex");
    const { file, changed } = configureSuperviseHooks(agent, p.bools["--project"], p.bools["--remove"], p.bools["--block"]);
    const status = p.bools["--remove"] ? (changed ? "removed" : "not installed (no-op)") : changed ? "installed" : "already installed (no-op)";
    const help = p.bools["--remove"]
      ? []
      : [
          "Restart the agent session to activate it",
          "The job, a bounded diff, and recent tool calls are sent to TypeSafe's API with secrets redacted",
          "The scores are not calibrated for every project: check `jev-axi stats` after a few sessions before turning on --block",
        ];
    return { supervise: { status, agent, mode: p.bools["--block"] ? "block" : "warn", scope, file }, ...(help.length ? { help } : {}) };
  }
  if (action === "agent") {
    const { file, status } = configureAgent(p.bools["--project"], p.bools["--remove"], p.bools["--replace-explore"]);
    const help = /installed|updated/.test(status)
      ? ["Restart Claude Code to load it", "It preloads the jev-axi skill; install that too: npx skills add shiftynick/jev-axi --skill jev-axi"]
      : [];
    return { agent: { status, scope, file }, ...(help.length ? { help } : {}) };
  }
  if (action === "git-hooks") {
    const { dir, hooks, help } = configureGitHooks(p.bools["--remove"]);
    return { git_hooks: { dir, hooks }, ...(help.length ? { help } : {}) };
  }
  if (action === "status") {
    const s = sessionStartHookStatus({ scope });
    const safetyFile = (agent: "claude" | "codex") => {
      try {
        const f = configureSafetyHookPath(agent, p.bools["--project"]);
        return existsSync(f) && readFileSync(f, "utf8").includes(SAFETY_HOOK_COMMAND) ? "installed" : "missing";
      } catch {
        return "missing";
      }
    };
    const superviseStatus = (agent: "claude" | "codex") => {
      try {
        const f = configureSafetyHookPath(agent, p.bools["--project"]);
        return existsSync(f) && readFileSync(f, "utf8").includes(SUPERVISE_HOOK_COMMAND) ? "installed" : "missing";
      } catch {
        return "missing";
      }
    };
    return {
      hooks: { scope, claude: s.claude.installed ? "installed" : "missing", codex: s.codex.installed ? "installed" : "missing", opencode: s.opencode.installed ? "installed" : "missing" },
      safety: { scope, claude: safetyFile("claude"), codex: safetyFile("codex") },
      supervise: { scope, claude: superviseStatus("claude"), codex: superviseStatus("codex") },
    };
  }
  throw new AxiError("Unknown setup action", "VALIDATION_ERROR", ["Run `jev-axi setup hooks`, `jev-axi setup safety`, `jev-axi setup supervise`, `jev-axi setup agent`, `jev-axi setup git-hooks`, or `jev-axi setup status`"]);
}

export function todayUsageLine(): string {
  const entries = readUsage(1);
  if (entries.length === 0) return "0 calls in the last 24h";
  const t = totals(entries);
  const cost = estimateCost(t.input, t.output);
  return `${t.calls} calls, ${formatTokens(t.input)} in / ${formatTokens(t.output)} out, ${t.cached_calls} cached, ${formatCost(cost)} in the last 24h`;
}

export { round };
