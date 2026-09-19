# Agent benchmark

Writeup of what these runs showed, and what they did not:
[docs/skills-do-not-get-used.md](../../docs/skills-do-not-get-used.md).

Measures whether Claude Code gets real work done cheaper, faster, or more correctly when
jev-axi is available. Each task runs as a headless `claude -p` session in a fresh copy of a
pinned repository (`tasks.yaml` names the repo and commit), under these conditions:

| condition | skill | jev-axi on PATH | SessionStart hook |
| --- | --- | --- | --- |
| `baseline` | no | no | no |
| `jev-axi` | in `.claude/skills` | yes | no |
| `jev-axi-hook` | in `.claude/skills` | yes | yes, as `jev-axi setup hooks --project` installs |
| `jev-axi-agent` | in `.claude/skills` | yes | no; adds the `jev-explore` subagent (`jev-axi setup agent --project`) |
| `jev-axi-explore` | in `.claude/skills` | yes | no; the same subagent installed as `Explore` (`--replace-explore`) |
| `jev-axi-forced` | in `.claude/skills` | yes | no; the prompt tells the agent to use jev-axi (upper bound) |

Prompts never mention jev-axi (except in `jev-axi-forced`), so the benchmark measures whether it gets used on its own and
whether that pays off.

```sh
pnpm build
python3 bench/agent/bench.py --repo ~/Work/t3code --only theme-size-limits --repeats 1   # smoke test
python3 bench/agent/bench.py --repo ~/Work/t3code --repeats 3 --parallel 4 --model sonnet
python3 bench/agent/bench.py --repo x --rescore bench/agent/results/<stamp>              # regrade after editing tasks.yaml
```

Per run it records, in `results/<stamp>/runs.jsonl` (gitignored):

- Claude's `total_cost_usd`, turns, duration, and token usage from `--output-format json`
- Jev's token spend from an isolated jev-axi ledger, priced at $0.042 per million input tokens
- from the session transcript and its subagent transcripts: file reads, searches, subagents
  spawned, jev-axi commands run, and whether the skill was loaded
- whether the final answer matched the task's `expect` patterns (all required) or
  `expect_min` (at least `min` of `patterns`)

This spends real Claude and TypeSafe credits: a narrow task costs about $0.15 per run with
Sonnet, a broad multi-file task $0.25 to $1. Run-to-run variance is large, so compare medians
over several repeats before drawing conclusions.

Task design notes:

- Narrow "where is X" questions are solved by `grep` in a few turns; they are sanity checks.
- The expensive pattern in real transcripts is broad exploration across many files (see
  `bench/transcripts/mine.py`), so the tasks that matter are the broad ones.
- Claude Code often explores inside subagents, which is why subagent transcripts are counted.

## Results so far (Sonnet, t3code @ 6299503dd9)

Broad tasks only, 3 repeats per task and condition, 2026-09-17:

| condition | correct | mean cost | median duration | median file reads | runs that ranked files with jev-axi |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 6/6 | $0.715 | 147 s | 14 | - |
| jev-axi-explore | 5/6 | $0.694 | 133 s | 12 | 2/6 |
| jev-axi-forced | 5/6 | $0.826 | 210 s | 18 | 6/6 |

- Jev spend is negligible (20 cents across all 56 runs recorded here, at most $0.039
  in any one run, against $36.85 of Claude); the cost is all Claude.
- The differences are within run-to-run noise. On this repo, Claude Code's grep-based
  exploration is already efficient, and file ranking does not make it cheaper. Forcing
  jev-axi adds turns.
- Claude Code picks its built-in `Explore` over a custom `jev-explore` subagent, so only the
  override reaches exploration at all. Even then it usually sees an obvious identifier and
  greps, as instructed: the override ran the binary in 7 of 7 runs, but 4 of those made zero
  API calls.
- Across all 22 runs where the agent had a choice (`jev-axi`, `jev-axi-hook`, `jev-axi-agent`,
  `jev-axi-explore`), the skill was loaded 0 times. Neither the skill alone nor a SessionStart
  hook announcing it led to jev-axi being used unprompted.
- Mean and median disagree in sign at this sample size. In the 2026-09-17T083821 session,
  `jev-axi-forced` cost 2% more than baseline by mean and 5% less by median; in
  2026-09-17T091348 it cost 15% more by mean and 25% more by median. Six runs per condition is
  not enough to call a direction, let alone a magnitude.

jev-axi's case rests on judgments an agent can't make cheaply by reading (log triage,
untrusted-text screening, safety checks) rather than on reducing exploration tokens.
