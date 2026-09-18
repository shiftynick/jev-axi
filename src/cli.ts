import { AxiError, exitCodeForError, runAxiCli } from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { renderHelp, renderWithHelp, type Renderable } from "./commands/common.js";
import { VERSION } from "./version.js";
import { homeCommand } from "./commands/home.js";
import { ASK_HELP, askCommand } from "./commands/ask.js";
import { CHECK_HELP, checkCommand, PICK_HELP, pickCommand, RATE_HELP, rateCommand } from "./commands/primitives.js";
import { FILTER_HELP, filterCommand, RANK_HELP, rankCommand } from "./commands/batch.js";
import { FIND_HELP, findCommand } from "./commands/find.js";
import { DIFF_HELP, diffCommand } from "./commands/diff.js";
import { FILES_HELP, filesCommand } from "./commands/files.js";
import { TRIAGE_HELP, triageCommand } from "./commands/triage.js";
import { PROGRESS_HELP, progressCommand } from "./commands/progress.js";
import { GUARD_HELP, guardCommand } from "./commands/guard.js";
import { COMMIT_HELP, commitCommand } from "./commands/commit.js";
import { RECIPE_HELP, recipeCommand } from "./commands/recipe.js";
import { STATS_HELP, statsCommand } from "./commands/stats.js";
import { HOOK_HELP, hookCommand } from "./commands/hook.js";
import { GUARD_EXEC_HELP, guardExecCommand } from "./commands/exec.js";
export { COMMAND_TABLE } from "./commands/table.js";
import {
  CACHE_HELP,
  cacheCommand,
  CONFIG_HELP,
  configCommand,
  MODELS_HELP,
  modelsCommand,
  SETUP_HELP,
  setupCommand,
  USAGE_HELP,
  usageCommand,
} from "./commands/meta.js";

export const DESCRIPTION =
  "Calibrated judgments from TypeSafe's Jev model in about half a second: triage failing logs, screen untrusted text and risky agent tool calls, review diffs, filter or rank many items, and locate code in large unfamiliar repos.";

export const TOP_HELP = `usage: jev-axi <command> [args] [flags]
primitives[4]: pick, rate, check, ask
batch[3]: rank, filter, find
recipes[7]: diff, files, triage, guard, progress, commit, recipe
safety[5]: guard-exec, setup safety, setup supervise, setup git-hooks, hook
meta[7]: (none)=status, models, usage, stats, cache, config, setup
global flags:
  --json, --full, --model <name>, --no-cache, --act <p>, --confirm <p>, --help, -v/--version
state:
  --state <path|->, --text "<s>", --state-json '<json>'; piped stdin is used when none given
bands:
  act (confidence >= 0.75), confirm (>= 0.45), escalate (below). Noul confidence = |p - 0.5| * 2
examples:
  jev-axi check "Does this diff touch authentication?" --state diff.txt
  jev-axi pick "Which team?" --options billing,technical,sales --text "my card was charged twice"
  jev-axi files "add a --json flag to the list command"
  jev-axi diff --staged
  npm test 2>&1 | jev-axi triage
  curl -s <url> | jev-axi guard
  jev-axi guard-exec -- "./scripts/deploy.sh prod"
  jev-axi usage --by day
`;

export const HELP: Record<string, string> = {
  ask: ASK_HELP,
  pick: PICK_HELP,
  rate: RATE_HELP,
  check: CHECK_HELP,
  rank: RANK_HELP,
  filter: FILTER_HELP,
  find: FIND_HELP,
  diff: DIFF_HELP,
  files: FILES_HELP,
  triage: TRIAGE_HELP,
  guard: GUARD_HELP,
  progress: PROGRESS_HELP,
  commit: COMMIT_HELP,
  recipe: RECIPE_HELP,
  stats: STATS_HELP,
  cache: CACHE_HELP,
  hook: HOOK_HELP,
  "guard-exec": GUARD_EXEC_HELP,
  models: MODELS_HELP,
  usage: USAGE_HELP,
  config: CONFIG_HELP,
  setup: SETUP_HELP,
};

type Cmd = (args: string[]) => Promise<Renderable>;
const wrap = (cmd: Cmd) => async (args: string[]) => {
  const out = await cmd(args);
  return typeof out === "string" ? out : renderWithHelp(out);
};

export function formatError(error: unknown): { output: string; exitCode: number } {
  const e = error instanceof AxiError ? error : new AxiError(error instanceof Error ? error.message : String(error), "UNKNOWN");
  return {
    output: [encode({ error: e.message, code: e.code }), renderHelp(e.suggestions)].filter(Boolean).join("\n") + "\n",
    exitCode: exitCodeForError(e),
  };
}

export async function main(argv = process.argv.slice(2), stdout?: { write: (chunk: string) => unknown }): Promise<void> {
  const target = (stdout ?? process.stdout) as { write: (chunk: string) => unknown; on?: (...args: any[]) => unknown };
  // Commands that print nothing (hooks, guard-exec running a command) must not add a blank line
  // to output that belongs to someone else.
  const sink = {
    write: (chunk: string) => (chunk === "\n" ? true : target.write(chunk)),
    ...(target.on ? { on: (...args: any[]) => target.on!(...args) } : {}),
  };
  // `jev-axi guard-exec -- ls --help`: a --help after -- belongs to the wrapped command.
  const sep = argv.indexOf("--");
  const helpOnlyAfterSeparator = sep !== -1 && !argv.slice(0, sep).includes("--help");
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    packageName: "jev-axi",
    argv,
    stdout: sink,
    topLevelHelp: TOP_HELP,
    getCommandHelp: (command) => (helpOnlyAfterSeparator ? undefined : HELP[command]),
    formatError,
    home: wrap(() => homeCommand()),
    commands: {
      ask: wrap(askCommand),
      pick: wrap(pickCommand),
      rate: wrap(rateCommand),
      check: wrap(checkCommand),
      rank: wrap(rankCommand),
      filter: wrap(filterCommand),
      find: wrap(findCommand),
      diff: wrap(diffCommand),
      files: wrap(filesCommand),
      triage: wrap(triageCommand),
      guard: wrap(guardCommand),
      progress: wrap(progressCommand),
      commit: wrap(commitCommand),
      recipe: wrap(recipeCommand),
      stats: wrap(statsCommand),
      cache: wrap(cacheCommand),
      hook: wrap(hookCommand),
      "guard-exec": wrap(guardExecCommand),
      models: wrap(modelsCommand),
      usage: wrap(usageCommand),
      config: wrap(configCommand),
      setup: wrap(setupCommand),
    },
  });
}
