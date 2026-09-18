# jev-axi command reference

Generated from `jev-axi <command> --help` by scripts/build-skill.ts. Do not edit by hand.

Global flags accepted by every command: `--json` (machine-readable output), `--full`
(no truncation, full distributions), `--model <name>`, `--no-cache`, `--act <p>` and
`--confirm <p>` (band thresholds), `--help`.

## Contents

- [pick](#pick)
- [rate](#rate)
- [check](#check)
- [ask](#ask)
- [rank](#rank)
- [filter](#filter)
- [find](#find)
- [files](#files)
- [diff](#diff)
- [triage](#triage)
- [guard](#guard)
- [progress](#progress)
- [setup](#setup)
- [setup](#setup)
- [guard](#guard)
- [setup](#setup)
- [setup](#setup)
- [commit](#commit)
- [recipe](#recipe)
- [usage](#usage)
- [stats](#stats)
- [cache](#cache)
- [hook](#hook)
- [guard-exec](#guard-exec)
- [models](#models)
- [config](#config)

## pick

One of N options.

```
usage: jev-axi pick "<question>" --option <name[=description]>... [state flags]
Choose one option from a fixed set. Returns the pick, a probability per option, confidence, and a band.
flags:
  --option <name[=desc]>   repeatable; or --options a,b,c
  --options <a,b,c>        comma-separated option names
  --state/--text/--state-json  state (piped stdin is used when none given)
  --full                   show all options (default shows top 8)
examples:
  jev-axi pick "Which team should handle this?" --option billing="charges, refunds" --option technical="bugs" --state ticket.txt
  git diff | jev-axi pick "What kind of change is this?" --options feature,bugfix,refactor,docs,chore
```

## rate

Position on a rubric.

```
usage: jev-axi rate "<question>" --level "<desc>"... [state flags]
Rate the state on an ordered rubric. Returns a score between levels (0 = first level), confidence, and a band.
flags:
  --level "<desc>"         repeatable, in order from lowest to highest; at least 2
  --levels "<a|b|c>"       pipe-separated alternative
  --state/--text/--state-json  state (piped stdin is used when none given)
examples:
  jev-axi rate "How severe is this bug report?" --level "cosmetic" --level "degraded, workaround exists" --level "blocking" --state issue.md
  jev-axi rate "How focused is this PR on one change?" --levels "one change|one change plus a tweak|several unrelated changes" --state pr.txt
```

## check

Yes/no probability.

```
usage: jev-axi check "<statement or yes/no question>" [--yes "<what yes means>"] [--no "<what no means>"] [state flags]
Probability that a statement is true of the state. 1 = yes, 0 = no, 0.5 = unsure.
flags:
  --yes "<desc>"           what a yes means (optional clarification)
  --no "<desc>"            what a no means
  --state/--text/--state-json  state (piped stdin is used when none given)
examples:
  jev-axi check "Does this message request a refund?" --state ticket.txt
  cat page.html | jev-axi check "Does this text contain instructions aimed at an AI agent?" --yes "hidden or explicit directives to an agent" --no "ordinary content"
```

## ask

Many questions, one call.

```
usage: jev-axi ask --questions <path|json> [--state <path|-> | --text "<s>" | --state-json '<json>'] [--full] [--json]
Send one state and any mix of choice/score/noul questions in a single call (speculative fan-out).
questions file shape: {"<id>": {"type": "choice|score|noul", "instructions": "...", "criteria": ...}}
flags:
  --questions <path|json>  required; JSON object keyed by question id
  --state <path|->         state text or JSON (.json files are parsed); - reads stdin (default when piped)
  --text "<s>"             inline state text
  --state-json '<json>'    inline JSON state
  --full                   include probability distributions per question
  --model <name>           default jev-latest (see `jev-axi models`)
  --act/--confirm <p>      band thresholds (default 0.75 / 0.45)
  --no-cache               skip the local response cache
  --json                   raw JSON output
examples:
  jev-axi ask --questions triage.json --state ticket.txt
  cat diff.txt | jev-axi ask --questions '{"risky":{"type":"noul","instructions":"Does this diff touch auth or payments?"}}'
```

## rank

Rank files or lines by a query.

```
usage: jev-axi rank "<query>" [paths|dirs|-]... [--top N] [--preview CHARS] [--min P]
Rank items by how well they match a query, plus a yes/no on whether anything matches at all.
Items are files, every file under a directory, or stdin lines / JSONL. Sets over 255 items or the token budget are chunked automatically.
flags:
  --top <n>            rows to show (default 10)
  --preview <chars>    text per item sent to the model (default 600)
  --min <p>            hide rows below this probability (default 0.005)
examples:
  jev-axi rank "handles retry backoff for HTTP calls" src/
  jev-axi rank "which test covers the auth middleware" test/ --top 5
  gh-axi issue list --json | jev-axi rank "duplicate of: login page hangs on submit" -
```

## filter

Keep items matching a predicate.

```
usage: jev-axi filter "<predicate>" [paths|dirs|-]... [--min P] [--all] [--preview CHARS]
Ask one yes/no question per item and keep those whose probability is at or above --min.
flags:
  --min <p>            keep threshold (default 0.5)
  --all                show rejected items too
  --preview <chars>    text per item sent to the model (default 600)
examples:
  jev-axi filter "this file contains a TODO that describes a bug, not a feature" src/
  cat errors.log | jev-axi filter "this log line is a real error, not a warning or noise" - --min 0.7
```

## find

Semantic grep in one file.

```
usage: jev-axi find "<question>" <file|-> [--top N] [--context N]
Semantic grep: which line of a file best answers the question, plus whether the file answers it at all.
Lines are tagged with ids and searched in windows of 255; results are merged across windows.
flags:
  --top <n>            lines to show (default 5)
  --context <n>        extra lines of context around each hit (default 0)
  --min <p>            hide lines below this probability (default 0.01)
examples:
  jev-axi find "where is the retry delay decided?" src/net.ts
  jev-axi find "the first real error, not a warning" build.log --top 3
  git log --oneline -200 | jev-axi find "the commit that introduced the flaky test" -
```

## files

Which files a task touches.

```
usage: jev-axi files "<task>" [dirs|paths]... [--top N] [--preview CHARS] [--shortlist N] [--no-docs]
Which files would a developer open or change for a task. Ranks source files under the given dirs (default: .)
by the start of their contents; run this before reading files yourself.
Large sets are shortlisted by path first, so only likely files are read in full. Markdown under the repository's
docs/ directory is included automatically, since design docs often hold the answer.
flags:
  --top <n>            rows to show (default 8)
  --preview <chars>    text per file sent to the model, after leading imports (default 700)
  --shortlist <n>      files kept after the path-only pass when there are more than 120 (default 60)
  --no-docs            don't add the repository's docs/ directory
examples:
  jev-axi files "add a --json flag to the list command"
  jev-axi files "why does login redirect loop" src/ app/
```

## diff

Review a diff before committing.

```
usage: jev-axi diff [--staged | --range <a..b> | --file <patch> | -]
Review a diff before committing: per-file risk, missing tests, secrets, debug leftovers, plus overall scope and kind.
Credentials in known formats are detected locally and redacted before anything is sent.
Defaults to unstaged working-tree changes. Files are chunked to the token budget; large patches are truncated to 6000 chars.
flags:
  --staged             review the index (what `git commit` would include)
  --range <a..b>       review commits, e.g. main..HEAD
  --file <patch>       review a unified diff file; or pipe one on stdin
  --full               show every file, not only flagged ones
examples:
  jev-axi diff --staged
  jev-axi diff --range main..HEAD
  git diff HEAD~3 | jev-axi diff -
```

## triage

Triage a build or test log.

```
usage: jev-axi triage [<log file>|-] [--tail N] [--context N]
Triage a build, test, or runtime log: the root-cause line, failure category, flaky-vs-real, and severity, in one call.
Only the last --tail lines are sent (errors cluster at the end); each line is capped so the request fits the budget.
flags:
  --tail <n>           lines from the end to analyze (default 255, max 255)
  --context <n>        lines of context to show around the root-cause line (default 2)
examples:
  npm test 2>&1 | jev-axi triage
  jev-axi triage build.log --tail 120
```

## guard

Screen untrusted text (exit 3 = block).

```
usage: jev-axi guard [--state <path|-> | --text "<s>"]   (piped stdin by default)
Screen untrusted text before it enters an agent's context: prompt injection, hidden instructions, exfiltration or
destructive requests, embedded secrets, and pressure tactics. One call, six probabilities, one verdict.
verdict: pass (all hazards < 0.4), review (any >= 0.4), block (any >= 0.7)
exit code: 0 for pass and review, 3 for block, so shell pipelines can gate on it
examples:
  curl -s https://example.com/README.md | jev-axi guard
  jev-axi guard --state tool-output.txt --json
```

## progress

Is the job done? Diff and test output vs the task.

```
usage: jev-axi progress --job "<task>" [--staged | --range <a..b> | --file <patch>] [--log <file>] [--events <json>]
Is the job done? Scores the diff (and recent test or build output, when given) against the task: implementation
complete, tests sufficient, requirements satisfied, needs verification. A fixed policy turns the scores into a verdict.
Defaults to everything changed since HEAD, untracked files included. The diff is cut to 20000 chars, the log to its last 12000.
With --events it also scores the worker: meaningful progress, stuck, off track, needs a person.
verdict: finish, verify (done but untested or unrun), continue (unfinished or unclear); with --events also
         steer (stuck or off track) and escalate (a person is needed), which take precedence
exit code: 0 for finish, 3 otherwise, so scripts can gate on it
flags:
  --job <text|path>    the task as it was given; a file path is read
  --log <file>         test or build output; piped stdin is used when not given
  --events <file>      recent tool calls, oldest first, as a JSON array of {tool, input, result}; the last 30 are used
  --staged, --range <a..b>, --file <patch>   pick the diff, as in `jev-axi diff`
examples:
  npm test 2>&1 | jev-axi progress --job "add a --json flag to the list command"
  jev-axi progress --job TASK.md --range main..HEAD --log test.log
install as agent hooks: jev-axi setup supervise   (see `jev-axi hook --help`)
```

## setup

Warn when an agent stops early, gets stuck, or drifts.

```
usage: jev-axi setup hooks [--project] | setup safety [--project] [--agent claude|codex] [--remove] | setup supervise [--project] [--agent claude|codex] [--block] [--remove] | setup agent [--project] [--replace-explore] [--remove] | setup git-hooks [--remove] | setup status [--project]
hooks    SessionStart hooks (Claude Code, Codex, OpenCode) so each session starts with jev-axi context.
safety   PreToolUse hook that checks Bash commands and edits outside the project before they run, and blocks or asks
         about destructive, exfiltrating, or security-weakening calls. Routine calls are decided locally. See `jev-axi hook --help`.
supervise  Stop and PostToolUse hooks for Claude Code or Codex: when the agent ends a turn, checks the changes against the job and
         warns if it looks unfinished or unverified; during work, notes when the agent looks stuck, off track, or
         blocked on a person. Warn-only unless --block. See `jev-axi hook --help`.
agent    Claude Code subagent `jev-explore` that ranks files with jev-axi before reading them, for broad exploration.
         Claude Code tends to explore inside subagents, which never see skills or session hooks; this puts jev-axi there.
git-hooks  pre-commit and commit-msg hooks in the current repository: blocks commits that add credentials (found
         locally), warns about risky or unfocused diffs and messages that don't match them. See `jev-axi hook --help`.
flags:
  --project            install into the current repository instead of the user profile
  --agent <name>       for safety and supervise: claude (default) or codex
  --block              for supervise: send the agent back to work (once per stop) instead of only warning the user
  --remove             for safety, supervise, agent, or git-hooks: uninstall
  --replace-explore    for agent: install as `Explore`, overriding Claude Code's built-in explorer in this scope
examples:
  jev-axi setup hooks
  jev-axi setup safety --project
  jev-axi setup safety --agent codex
  jev-axi setup git-hooks
  jev-axi setup status
```

## setup

Warn when an agent stops early, gets stuck, or drifts.

```
usage: jev-axi setup hooks [--project] | setup safety [--project] [--agent claude|codex] [--remove] | setup supervise [--project] [--agent claude|codex] [--block] [--remove] | setup agent [--project] [--replace-explore] [--remove] | setup git-hooks [--remove] | setup status [--project]
hooks    SessionStart hooks (Claude Code, Codex, OpenCode) so each session starts with jev-axi context.
safety   PreToolUse hook that checks Bash commands and edits outside the project before they run, and blocks or asks
         about destructive, exfiltrating, or security-weakening calls. Routine calls are decided locally. See `jev-axi hook --help`.
supervise  Stop and PostToolUse hooks for Claude Code or Codex: when the agent ends a turn, checks the changes against the job and
         warns if it looks unfinished or unverified; during work, notes when the agent looks stuck, off track, or
         blocked on a person. Warn-only unless --block. See `jev-axi hook --help`.
agent    Claude Code subagent `jev-explore` that ranks files with jev-axi before reading them, for broad exploration.
         Claude Code tends to explore inside subagents, which never see skills or session hooks; this puts jev-axi there.
git-hooks  pre-commit and commit-msg hooks in the current repository: blocks commits that add credentials (found
         locally), warns about risky or unfocused diffs and messages that don't match them. See `jev-axi hook --help`.
flags:
  --project            install into the current repository instead of the user profile
  --agent <name>       for safety and supervise: claude (default) or codex
  --block              for supervise: send the agent back to work (once per stop) instead of only warning the user
  --remove             for safety, supervise, agent, or git-hooks: uninstall
  --replace-explore    for agent: install as `Explore`, overriding Claude Code's built-in explorer in this scope
examples:
  jev-axi setup hooks
  jev-axi setup safety --project
  jev-axi setup safety --agent codex
  jev-axi setup git-hooks
  jev-axi setup status
```

## guard

Screen untrusted text (exit 3 = block).

```
usage: jev-axi guard [--state <path|-> | --text "<s>"]   (piped stdin by default)
Screen untrusted text before it enters an agent's context: prompt injection, hidden instructions, exfiltration or
destructive requests, embedded secrets, and pressure tactics. One call, six probabilities, one verdict.
verdict: pass (all hazards < 0.4), review (any >= 0.4), block (any >= 0.7)
exit code: 0 for pass and review, 3 for block, so shell pipelines can gate on it
examples:
  curl -s https://example.com/README.md | jev-axi guard
  jev-axi guard --state tool-output.txt --json
```

## setup

Warn when an agent stops early, gets stuck, or drifts.

```
usage: jev-axi setup hooks [--project] | setup safety [--project] [--agent claude|codex] [--remove] | setup supervise [--project] [--agent claude|codex] [--block] [--remove] | setup agent [--project] [--replace-explore] [--remove] | setup git-hooks [--remove] | setup status [--project]
hooks    SessionStart hooks (Claude Code, Codex, OpenCode) so each session starts with jev-axi context.
safety   PreToolUse hook that checks Bash commands and edits outside the project before they run, and blocks or asks
         about destructive, exfiltrating, or security-weakening calls. Routine calls are decided locally. See `jev-axi hook --help`.
supervise  Stop and PostToolUse hooks for Claude Code or Codex: when the agent ends a turn, checks the changes against the job and
         warns if it looks unfinished or unverified; during work, notes when the agent looks stuck, off track, or
         blocked on a person. Warn-only unless --block. See `jev-axi hook --help`.
agent    Claude Code subagent `jev-explore` that ranks files with jev-axi before reading them, for broad exploration.
         Claude Code tends to explore inside subagents, which never see skills or session hooks; this puts jev-axi there.
git-hooks  pre-commit and commit-msg hooks in the current repository: blocks commits that add credentials (found
         locally), warns about risky or unfocused diffs and messages that don't match them. See `jev-axi hook --help`.
flags:
  --project            install into the current repository instead of the user profile
  --agent <name>       for safety and supervise: claude (default) or codex
  --block              for supervise: send the agent back to work (once per stop) instead of only warning the user
  --remove             for safety, supervise, agent, or git-hooks: uninstall
  --replace-explore    for agent: install as `Explore`, overriding Claude Code's built-in explorer in this scope
examples:
  jev-axi setup hooks
  jev-axi setup safety --project
  jev-axi setup safety --agent codex
  jev-axi setup git-hooks
  jev-axi setup status
```

## setup

Warn when an agent stops early, gets stuck, or drifts.

```
usage: jev-axi setup hooks [--project] | setup safety [--project] [--agent claude|codex] [--remove] | setup supervise [--project] [--agent claude|codex] [--block] [--remove] | setup agent [--project] [--replace-explore] [--remove] | setup git-hooks [--remove] | setup status [--project]
hooks    SessionStart hooks (Claude Code, Codex, OpenCode) so each session starts with jev-axi context.
safety   PreToolUse hook that checks Bash commands and edits outside the project before they run, and blocks or asks
         about destructive, exfiltrating, or security-weakening calls. Routine calls are decided locally. See `jev-axi hook --help`.
supervise  Stop and PostToolUse hooks for Claude Code or Codex: when the agent ends a turn, checks the changes against the job and
         warns if it looks unfinished or unverified; during work, notes when the agent looks stuck, off track, or
         blocked on a person. Warn-only unless --block. See `jev-axi hook --help`.
agent    Claude Code subagent `jev-explore` that ranks files with jev-axi before reading them, for broad exploration.
         Claude Code tends to explore inside subagents, which never see skills or session hooks; this puts jev-axi there.
git-hooks  pre-commit and commit-msg hooks in the current repository: blocks commits that add credentials (found
         locally), warns about risky or unfocused diffs and messages that don't match them. See `jev-axi hook --help`.
flags:
  --project            install into the current repository instead of the user profile
  --agent <name>       for safety and supervise: claude (default) or codex
  --block              for supervise: send the agent back to work (once per stop) instead of only warning the user
  --remove             for safety, supervise, agent, or git-hooks: uninstall
  --replace-explore    for agent: install as `Explore`, overriding Claude Code's built-in explorer in this scope
examples:
  jev-axi setup hooks
  jev-axi setup safety --project
  jev-axi setup safety --agent codex
  jev-axi setup git-hooks
  jev-axi setup status
```

## commit

Check commit messages against diffs.

```
usage: jev-axi commit [--range <a..b>] [--limit N]
Check commit messages against their diffs: conventional format, message matches the change, focus, and subject quality.
Defaults to the last commit; one call per commit.
flags:
  --range <a..b>       commits to check, e.g. main..HEAD
  --limit <n>          max commits (default 10)
examples:
  jev-axi commit
  jev-axi commit --range main..HEAD
```

## recipe

Saved question sets (YAML).

```
usage: jev-axi recipe list | show <name> | run <name> [state flags] | new <name> [--project]
Reusable question sets in YAML. A recipe is one `ask` with saved questions, so a team writes its definition of
"risky PR" or "urgent ticket" once and every agent session uses it.
locations (project first): ./.jev-axi/recipes/<name>.yaml, then ~/.config/jev-axi/recipes/<name>.yaml (or your XDG/AppData config dir)
recipe file:
  description: one line
  questions:
    <id>: {type: choice|score|noul, instructions: "...", criteria: ...}
flags for new:
  --project            create it in ./.jev-axi/recipes to commit and share, instead of your personal directory
flags for run:
  --state/--text/--state-json  state (piped stdin when none given); --full for distributions
examples:
  jev-axi recipe new ticket-triage
  jev-axi recipe new release-risk --project
  cat ticket.txt | jev-axi recipe run ticket-triage
```

## usage

Tokens and spend, recent.

```
usage: jev-axi usage [--days N] [--by command|day|model] [--json]
Token usage and estimated spend from the local ledger (the API has no spend endpoint; every call is logged here).
flags:
  --days <n>           window in days (default 7; 0 = all time)
  --by <group>         command (default), day, model, or project
notes:
  Costs assume $0.042 per 1M input tokens and free output; override with jev-axi config set price.input / price.output
  Cached calls are listed separately as saved tokens.
examples:
  jev-axi usage
  jev-axi usage --days 30 --by day
```

## stats

Lifetime stats and trends.

```
usage: jev-axi stats [--days N] [--top N] [--json]
Lifetime usage and trends from the local stats ledger in your config folder: daily activity with sparklines,
this period vs the previous one, per-command and per-project breakdowns, answer confidence, cache savings,
and a projected monthly cost. When the supervision hooks are installed, also what they judged and how often they spoke.
flags:
  --days <n>           trend window (default 30); the comparison period is the same length before it
  --top <n>            rows per breakdown (default 8)
ledger: ~/.config/jev-axi/stats/usage.jsonl
examples:
  jev-axi stats
  jev-axi stats --days 7
```

## cache

Show or clear the response cache.

```
usage: jev-axi cache [clear [--stale]]
Show or clear locally cached responses. A cached answer is reused only while it is younger than the TTL
(config key cacheTtlHours, default 24) and was produced by the model version its alias
(e.g. jev-latest) currently resolves to, so a model update invalidates old answers automatically.
flags:
  --stale              with clear: remove only expired or superseded entries
examples:
  jev-axi cache
  jev-axi cache clear --stale
  jev-axi config set cacheTtlHours 0     # disable caching
```

## hook

```
usage: jev-axi hook pre-tool-use [--agent claude|codex] [--input <json|path>] [--on-error allow|ask|deny] [--explain]
       jev-axi hook pre-commit [--block-on secrets|flags|none]   |   jev-axi hook commit-msg <file> [--strict]
Safety check for a tool call an agent is about to make, run as a PreToolUse hook. Reads the hook JSON on stdin.
Routine calls (read-only commands, the project's tests and builds, edits inside the project) are decided locally with
no API call. Other calls are sent to Jev with secrets redacted and scored for destructive actions, exfiltration,
running downloaded code, weakening security, and changes outside the project.
output: nothing (normal permission flow applies; never auto-approves), or a PreToolUse decision JSON to ask or deny.
flags:
  --agent <name>       output format: claude (default) or codex (Codex supports only deny, so ask becomes deny)
  --input <json|path>  hook JSON instead of stdin, for testing
  --on-error <mode>    when Jev is unreachable or slow: allow (default, normal flow), ask, or deny
  --explain            print the decision, scores, and reason as TOON instead of hook JSON
install: jev-axi setup safety [--project] [--agent claude|codex]
supervision hooks for Claude Code and Codex (install: jev-axi setup supervise [--project] [--agent claude|codex] [--block]):
  stop [--block]       when the agent ends its turn with changes in the repository, scores whether the job from the
                       transcript is implemented, tested, and verified. Warns the user on a clear signal only; with --block it
                       sends the agent back to work once per stop, with the reason. Turns with no changes are skipped.
  post-tool-use        keeps the last 30 tool calls of the session locally and, every 10 calls (--every <n>), scores whether
                       the agent is stuck, off track, or blocked on a person. Adds a note to the agent's context; never blocks.
  Both send a bounded, secret-redacted snapshot to Jev, stay silent on any error, and log every verdict, spoken or
  not, to stats/supervise.jsonl (summarized by `jev-axi stats`). Tool calls the agent was denied are not seen.
git hooks (install: jev-axi setup git-hooks):
  pre-commit           scans added lines for credentials locally (blocks; nothing is sent), then reviews the staged
                       diff with Jev, credentials redacted: risk, missing tests, debug leftovers (warns)
    --block-on <what>  secrets (default): block only on local credential matches; flags: also block on any Jev flag;
                       none: never block
  commit-msg <file>    checks the message describes the staged diff, and follows Conventional Commits when the
                       repo's history does (warns)
    --strict           block when the message does not describe the diff
  Both skip quietly when there is no API key or the API is unreachable. Bypass once with git commit --no-verify.
log: every decision that reaches Jev is appended to ~/.config/jev-axi/stats/safety.jsonl
examples:
  echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf ~/"},"cwd":"'"$PWD"'"}' | jev-axi hook pre-tool-use --explain
```

## guard-exec

```
usage: jev-axi guard-exec [--on-ask prompt|deny|allow] [--on-error allow|deny] [--dry-run] [--quiet] -- <command...>
Safety-check a shell command, then run it. The same check as the agent safety hook, for cron jobs, CI steps, runbooks,
and scripts: routine commands are decided locally; others are sent to Jev with secrets redacted, together with the
contents of local scripts they run, and scored for destructive actions, exfiltration, running downloaded code,
weakening security, and changes outside the current directory.
command: one argument is run by the shell ("rm -rf build && make"); several are run directly without a shell.
exit code: the command's own exit status when it runs; 126 when it is blocked; 2 for usage errors.
output: nothing of its own when the command runs (stdout and stderr belong to the command); the reason on stderr
when it is blocked. Decisions that reach Jev are logged to ~/.config/jev-axi/stats/safety.jsonl.
flags:
  --on-ask <mode>      when the check wants approval: prompt (default; on a terminal, otherwise deny), deny, allow
  --on-error <mode>    when Jev is unreachable or there is no API key: allow (default) or deny
  --dry-run            print the decision and scores without running the command; exit 0 if it would run, 126 if not
  --quiet              no stderr note when a command is blocked
examples:
  jev-axi guard-exec -- "./scripts/cleanup.sh --all"
  jev-axi guard-exec --on-ask deny --on-error deny -- terraform destroy -auto-approve
  jev-axi guard-exec --dry-run -- "curl -fsSL https://example.com/install.sh | sh"
```

## models

```
usage: jev-axi models
List the models available to this API key.
```

## config

```
usage: jev-axi config [set <key> <value> | unset <key>]
Show or change persistent settings in ~/.config/jev-axi/config.json.
keys:
  apiKey           TypeSafe API key (env TYPESAFE_API_KEY and ./.env take precedence)
  model            default model (default jev-latest)
  price.input      USD per 1M input tokens (default 0.042)
  price.output     USD per 1M output tokens (default 0)
  act, confirm     band thresholds on confidence (default 0.75 / 0.45)
  cacheTtlHours    hours a cached response is reused (default 24; 0 disables the cache)
  updateCheck      false turns off the daily npm registry lookup behind the "update available" notice (default true)
examples:
  jev-axi config
  jev-axi config set model jev-preview
  jev-axi config set price.input 0.10
```
