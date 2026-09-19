# Roadmap

Where jev-axi is headed, and why. Items are grouped by theme and ordered roughly by
priority within each theme. Nothing here is a commitment or a date; open an issue or a
discussion if one of these matters to you, or if something is missing.

## Guiding idea

Jev answers a narrow question about text (yes/no, a score, a pick) in about half a second,
for a fraction of a cent, and its answers are calibrated probabilities. That makes it a good
fit for judgments that run often, in the background, over many items: places where a
general-purpose model is too slow or too expensive to run on everything, and where a regex
is too dumb.

jev-axi started as a tool for coding agents. The [agent benchmark](bench/agent/README.md)
showed that its value there is in judgments (triage, screening untrusted text, safety
checks), not in saving tokens on exploration. The roadmap follows that: more places to make
a judgment, and more use of the probabilities Jev returns.

## Status key

- 🟢 shipped
- 🟡 in progress or next up
- ⚪ planned
- 💭 idea, not yet committed to

## 1. Judgments in CI and git

Run the same checks with nobody asking.

- 🟢 **GitHub Action**: `diff` review on every pull request, posted as a
  check with the risk score; `triage` on failed jobs, posted as a comment with the likely
  cause and the exact log lines.
- 🟢 **Git hooks** (`jev-axi setup git-hooks`): pre-commit blocks credentials found locally and
  warns on risky diffs, debug leftovers, and missing tests; commit-msg warns when the message
  does not describe the diff.
- 🟢 **Agent supervision** (`jev-axi setup supervise`, `jev-axi progress`): a Stop hook that checks
  the changes against the job, and a PostToolUse hook that notices a stuck, drifting, or blocked
  agent, for Claude Code and Codex. Warn-only by default.
- ⚪ **Calibrated supervision thresholds**, learned from `stats/supervise.jsonl`.
- 🟢 **pre-push hook** (`jev-axi hook pre-push`, installed by `setup git-hooks`): judges the pushed
  range for migrations without a rollback note, auth/permission/crypto changes, hand-edited
  generated files, and leftovers, reporting each range once.
- 💭 **Pull request routing**: pick reviewers and labels from the diff, a Choice over
  CODEOWNERS entries.
- 💭 **Flaky-test ledger**: classify each failure as environmental or real over time, per
  test.

## 2. Streams and pipelines

Make jev-axi a Unix filter you describe in English.

- ⚪ **Streaming filter** (`jev-axi filter --stream`): line-at-a-time over `tail -f`,
  journald, `kubectl logs`; batches lines and flushes on a short interval.
- ⚪ **Watch mode** (`jev-axi watch <file|command>`): score severity as lines arrive, dedupe
  similar lines, notify a webhook above a threshold.
- ⚪ **Labeling** (`jev-axi label data.csv --column text "<question>"`): parallel,
  resumable, writes a probability column. For dataset cleaning, dedup, and bootstrapping
  training labels.

## 3. Inbox and queue triage

The "many items" strength, pointed at things that pile up.

- ⚪ **Issue triage**: rank new issues for duplicates, actionability, and presence of a
  repro; runs on a schedule and applies labels.
- 💭 **Sources as plugins**: RSS, mbox, Linear, Slack and Notion exports, so `rank` and
  `filter` can read from them directly.
- 💭 **Dependency bump screening**: for each changelog, "does this mention a breaking change
  or a security fix?"

## 4. Editors and the shell

- ⚪ **Shell plugin** (zsh, fish): after a command fails, offer `triage` on the captured
  output.
- 💭 **Editor extensions** (VS Code, Neovim): rank workspace files by relevance to the
  selection, review the current diff, triage the error under the cursor. Thin wrappers
  over `--json`.
- 💭 **Interactive pick**: a TUI where the ranked list refreshes as you type the question.

## 5. Programmatic surfaces

jev-axi stays a CLI, following the [AXI](https://github.com/kunchenguid/axi) principles:
agents and scripts call it directly, with no MCP server in between.

- ⚪ **Library API**: `import { check, rank } from "jev-axi"` with the same cache, ledger,
  and recipes.
- 💭 **HTTP sidecar** (`jev-axi serve`): for callers in other languages and for sharing one
  cache across a team.

## 6. Shared recipes

- ⚪ **Recipe registry**: recipes as YAML in git repos or an npm scope,
  `jev-axi recipe add gh:user/repo`. Community-tuned questions for specific stacks (Django
  logs, Rust compiler errors, Terraform plans, Kubernetes events).
- ⚪ **Recipe testing** (`jev-axi recipe test`): the 0–1 scoring from `bench/eval.ts`,
  available to recipe authors.

## 7. Calibration as a feature

Jev returns probabilities; most tools throw them away.

- ⚪ **`jev-axi calibrate`**: given a labeled file, print a reliability summary and the
  threshold that hits a target precision, so recipe thresholds are chosen from data.
- ⚪ **Escalation** (`--escalate-to <command>`): send items in the "confirm" band to a
  larger model or a human queue automatically. The safety hook's "ask" is one instance of
  this.
- 💭 **Drift alerts**: flag when a recipe's confidence distribution shifts, for example
  after a model version change.

## 8. Safety beyond coding agents

- 🟢 **PreToolUse safety hook** for Claude Code and Codex (`jev-axi setup safety`).
- 🟢 **Generic pre-exec gate** (`jev-axi guard-exec -- <command>`): the same hazard scoring
  for cron jobs, CI scripts, and runbooks.
- 💭 **Bot middleware**: score inbound messages for injection, abuse, and spam before a bot
  acts on them; the `guard` recipe packaged for that.

## Shipped

- 🟢 0.1: check, score, pick, rank, filter, find, batch; usage and spend ledger.
- 🟢 0.2: recipes (triage, guard, diff, files, commit); stats and trends; response cache;
  Agent Skills package; recipe evals with a baseline.
- 🟢 0.3: safety hook; explorer subagent; concurrent chunk requests; docs-aware `files`;
  agent benchmark.
- 🟢 0.4: `guard-exec`; git hooks; GitHub Action for pull request review and CI triage;
  credentials redacted before `diff` and `triage` send anything.

## Suggested order

1. Streaming filter and labeling: from agent accessory to general tool.
2. Calibrate and escalation: what a wrapper around a general model can't offer as honestly.
3. Recipe registry, once there are external recipe authors.
