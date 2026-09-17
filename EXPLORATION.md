# jev-axi: an AXI that lets agents offload snap judgments to Jev

Working notes, 2026-09-16. Sources: docs.typesafe.ai (introduction, primitives,
confidence, patterns, cookbooks, HTTP API, JS SDK), the axi repo (10 principles,
`axi-sdk-js`), and the `gh-axi` reference implementation.

## 1. What Jev actually is (the one-paragraph version)

Jev is not an LLM. It never generates text. You POST a `state` (string or JSON)
plus a map of typed `questions`, and get back one typed, calibrated answer per
question, all evaluated in parallel against the same state, in roughly 100 ms.

| Primitive | Ask                       | Returns                                                |
| --------- | ------------------------- | ------------------------------------------------------ |
| Choice    | which one of these N?     | `choice`, `probabilities` over options, `confidence`   |
| Score     | where on this rubric?     | `score` (float between levels), `probabilities`, `confidence` |
| Noul      | is this true?             | `noul` in 0..1 (probability of yes)                    |

Hard facts that shape the CLI design:

- One request: one state, any number of questions, any mix of types.
- Budget: ~32k tokens shared by state and questions (~150k chars of English).
- Choice: up to 255 options. Option descriptions can be `null` when the state
  already carries the meaning (this is how "pick a line" search works).
- Questions are independent. No question sees another's answer. Adding
  questions barely changes latency and costs only the question tokens.
- Question IDs are never sent to the model. The full meaning must live in
  `instructions`.
- `instructions` and `criteria` accept JSON structure (objects, arrays), and
  you point at parts of a JSON state with backticked paths like
  `` `ticket.messages[0].text` ``.
- Confidence is derived from the probability distribution (Choice and Score
  only). Noul carries no separate confidence; the value near 0.5 is the signal.
- Errors: 401, 422 (validation, names the bad field), 429, 529. Retry with
  backoff on the last two.
- Endpoint: `POST https://api.typesafe.ai/v1/systemone`, bearer auth via
  `TYPESAFE_API_KEY`. Models: `jev-latest` (default), pinned like `jev-1.12`.
- JS SDK: `@typesafe-ai/sdk` 0.6.0, Node 20+. Python: `typesafe-sdk`.
- Pricing is not in the docs. The cookbooks describe it as far cheaper than
  small LLMs (one shows 1200 calls with 1.5M input tokens for well under a
  dollar). Worth confirming in the console.

## 2. Why an agent wants this

I (the agent) am expensive per token and slow per turn. Most of my
"judgment" moments are actually snap decisions that I currently make by
reading everything into context:

- Which of these 40 files is relevant to the bug? (I read them all.)
- Is this test failure a flake or real? (I reread the log.)
- Which of 180 skills applies to this request?
- Does this PR description match the diff?
- Which of these 300 log lines is the first real error?
- Is this commit message conventional? Is this doc stale? Is this comment
  a nit or a blocker?

Every one of those is a Choice, Score, or Noul over state I already have on
disk. If a CLI can take that state from a file or stdin, ask the questions in
one ~100 ms request, and hand back a 3-field TOON answer, then I save the
tokens of reading the state and the turns of reasoning about it. The docs'
parallel-questions cookbook measured batching as roughly 12x cheaper and 10x
faster than one-question-per-call, and the AXI benchmarks show the CLI form
factor beats MCP on cost and turns. Stack the two and the agent gets a cheap,
fast "gut" it can call from bash.

The two design ideas that make this an AXI rather than a curl wrapper:

1. **Speculative fan-out is the default, not the exception.** Every
   high-level command asks every question it might need in one request and
   lets the CLI decide what to print. The agent never pays a second round trip.
2. **Confidence becomes exit codes and routing, not prose.** The CLI prints
   `act` / `confirm` / `escalate` bands so the agent can branch on the output
   without doing the math.

## 3. CLI shape

Name: `jev-axi` (follows the `gh-axi` convention; `askjev` works as a friendlier
alias). One binary, command-first: `jev-axi <command> [args] [flags]`.

### Layer 0: raw primitives

Thin, composable, and the escape hatch for everything else.

```
jev-axi ask   --state <file|-> --questions <file|json>      # full request, any mix
jev-axi pick  <question> --option a --option b ... [--state]  # single Choice
jev-axi rate  <question> --level "..." --level "..." [--state] # single Score
jev-axi check <statement> [--yes "..." --no "..."] [--state] # single Noul
```

State comes from `--state <path>`, `--state -` (stdin), or `--state-json`.
Output (TOON):

```
answers[3]{id,type,answer,confidence,band}:
  department,choice,technical,0.60,confirm
  frustration,score,1.04,0.84,act
  is_urgent,noul,0.999,-,act
usage: 312 in / 48 out
help[1]: Run `jev-axi ask ... --full` for probability distributions
```

`--full` adds the probability tables. `--json` gives the raw API response for
programmatic callers.

### Layer 1: the workhorse batch verbs

These are where the real savings live. Each takes a list of items, tags them
with short IDs, packs as many as fit into a request, and prints ranked TOON.

```
jev-axi rank   <query> <paths|-> [--top N]     # Choice over item IDs + a Noul "does any match?"
jev-axi filter <predicate> <paths|-> [--min P] # one Noul per item, keep those above P
jev-axi label  <paths|-> --labels a,b,c [--multi]  # Choice per item (or Nouls for multi-label)
jev-axi score  <rubric.yaml> <paths|->         # composite scores, weights in the rubric file
jev-axi find   <question> <file>               # line-level semantic grep (Choice over line IDs)
jev-axi dedupe <paths|->                       # pairwise "same thing?" Score (merge / unsure / distinct)
```

Item sources: file globs, a directory, stdin lines, stdin JSONL, or
`--from git:diff`, `--from git:log`, `--from gh:issues` style adapters later.

Batching rules the CLI owns so the agent never thinks about them:

- Auto-chunk to the 32k token budget; 255 options per Choice; merge
  distributions across chunks with a two-pass "pick a window, then pick within
  it" when a set overflows.
- Truncate each item to a preview (head plus the matching region) with a
  size hint, per AXI principle 3.
- Always pair a ranking Choice with an existence Noul so "nothing matches"
  is a definitive answer, per principle 5.

### Layer 2: opinionated developer workflows

Recipes built from layers 0 and 1 with tuned questions and thresholds baked
in. These are the commands an agent reaches for by name.

```
jev-axi triage <log|-> ...                  # first real error, severity, flake-vs-real, which subsystem
jev-axi diff review [--staged]              # per-hunk: risk score, needs-test noul, scope creep noul, touches-secrets noul
jev-axi commit check [--range]              # conventional format, message matches diff, PR is focused
jev-axi files relevant "<task>" [--in src]  # rank repo files by relevance to a task, before reading any
jev-axi tests pick "<change summary>"       # which test files to run for this change
jev-axi docs stale <doc> --against <code>   # does the doc still describe the code
jev-axi issue triage <text|-> ...           # category, severity, repro present, duplicate of <ids>
jev-axi guard <text|->                      # prompt injection / hidden instruction / secret leak nouls
jev-axi extract <schema.json> <text|->      # regex candidates in code, Jev selects the right span
jev-axi route "<request>" --handlers h.yaml  # intent routing with confidence bands
```

Every recipe is just a questions file plus a small piece of code that
interprets the answers, so they live in a `recipes/` directory and are
inspectable. The TypeSafe agent-skill page specifically asks for questions
and thresholds in one reviewable place; that becomes a design constraint.

### Layer 3: user-defined recipes

```
jev-axi recipe list
jev-axi recipe run <name> [--state ...]
jev-axi recipe new <name>           # scaffolds ~/.config/jev-axi/recipes/<name>.yaml
```

A recipe is YAML: state adapters, a questions map, thresholds, and an output
mapping. This is how a team encodes "our definition of a risky PR" once and
lets every agent session use it.

### Agent plumbing (AXI principles 7 to 10)

- No-arg home view: bin path, description, key status, recipe count, last
  usage, a handful of next-step commands.
- `setup hooks` installs Claude Code, Codex, and OpenCode session-start hooks
  via `installSessionStartHooks()`.
- `SKILL.md` generated from the home view text, with a `--check` CI step.
- `--version` fast path, structured errors on stdout, exit 0 / 1 / 2, unknown
  flags rejected by name with the valid list inline.
- Idempotent everything: this tool has no mutations, so every command is
  safe to rerun and cache. Cache responses keyed on (model, state hash,
  questions hash) so reruns in the same session are free.

## 4. Cool things this opens up

Ordered roughly by how soon I would actually use them.

**Read less, decide more.** `jev-axi files relevant "fix the retry loop"`
over 400 file previews costs one request. Today I grep, open ten files, and
burn thousands of tokens on eight that did not matter. Same for
`tests pick`, `triage`, and `find`. The agent starts every task with a
ranked shortlist.

**Semantic grep.** `jev-axi find "where do we decide the retry delay?" src/net.ts`
tags each line with an ID and asks a Choice over 255 lines at a time, plus a
Noul for "does this file answer it at all". This is the cookbook's
line-by-line search, applied to code. It works on logs, transcripts, and
docs the same way.

**Cheap guardrails in the loop.** Pipe every tool result, web page, or
fetched README through `jev-axi guard` before it enters my context. Prompt
injection, hidden instructions, and leaked credentials become Nouls with
thresholds, in 100 ms, before the expensive model ever sees the text.

**Confidence-gated autonomy.** An agent running unattended can use the
`band` column as a policy: `act` proceeds, `confirm` asks the user,
`escalate` stops. Thresholds scale with risk per command, so a read-only
choice can act at 0.6 while a destructive one needs 0.9. The CLI owns the
math, the agent owns the branch.

**Self-review without a second LLM pass.** `diff review` and `commit check`
give the agent a rubric-based second opinion on its own work at negligible
cost. Score levels are explicit, so "PR scope" or "needs a test" become
numbers a hook can gate on. This composes well with a pre-commit hook or a
Stop hook in Claude Code.

**Skill and tool selection.** The skill-suggestion cookbook cut wrong skill
loads by more than half by ranking 182 skills in one request. A
`jev-axi route` recipe over a harness's skill or MCP tool catalog does the
same for any agent, and a session-start hook could inject "the skill most
relevant to this repo" as ambient context.

**Verification against evidence.** Citation checks, "does the doc match the
code", "does the test name match what it tests", "is this changelog entry
supported by the diff". Each is a Noul over a state that holds both the
claim and the source. Hallucination checks become a shell one-liner.

**Bulk labeling and structure recovery.** `label` over a thousand issues,
commits, or log lines. `extract` where regex proposes candidates and Jev
picks the correct one, so values are always verbatim from the source. The
autoformat cookbook's trick of reconstructing Markdown from flattened text
is a recipe too.

**Feature generation for real ML.** `score` with a rubric turns any text
corpus into numeric columns. The autoresearch cookbook feeds those into a
tree model. An agent could run `jev-axi score rubric.yaml data/*.txt --json`
and hand a data scientist a feature table.

**Consistency and A/B on judgment.** Because answers are calibrated and
self-consistent, the CLI can run the same recipe against `jev-latest` and a
pinned model and diff the distributions. That makes the recipes
regression-testable in CI, which is not something you can say about prompts.

**Interactive UIs that are actually fast.** At 100 ms, a TUI or editor
extension can rerank, filter, or flag on every keystroke. The CLI is the
backend for that; `--json` is the contract.

## 5. Things Jev is not for (so the CLI does not pretend)

- No generation: summaries, rewrites, explanations, and code stay with the
  LLM. The CLI should refuse question shapes that smell like "analyze and
  recommend" and suggest decomposition instead.
- Multi-step reasoning: split it into atomic questions plus code, or hand
  it to the agent.
- Dependent questions: one request cannot chain. The CLI does two-pass
  patterns (shortlist then rerank) explicitly and rarely.
- Big state: 32k tokens per request. Chunking is the CLI's job, and the
  preview-plus-size-hint pattern keeps the agent informed about what was cut.

## 6. Stack and repo plan

- TypeScript on Node 22+, `axi-sdk-js` for dispatch, TOON, errors, hooks,
  and the version fast path (this is exactly how `gh-axi` is built).
- `@typesafe-ai/sdk` for the API client, retries, and typed answers.
- Single package published to npm as `jev-axi`; `npx -y jev-axi` works with
  no install. Cross-platform comes free with Node; add a `bun build --compile`
  target later if a static binary matters.
- Layout mirrors `gh-axi`: `bin/jev-axi.ts`, `src/cli.ts`,
  `src/commands/*.ts`, `src/recipes/*.yaml`, `skills/jev-axi/SKILL.md`,
  `test/` with vitest and recorded API fixtures so tests run without a key.
- Response cache in `~/.cache/jev-axi/` keyed on request hash.

## 7. Suggested first milestone

1. `ask`, `pick`, `rate`, `check` with file and stdin state, TOON and JSON
   output, confidence bands, structured errors, `--version` fast path.
2. `rank`, `filter`, `find` with automatic chunking and the existence Noul.
3. Home view, `setup hooks`, generated `SKILL.md`.
4. Two recipes that prove the value on this very repo: `files relevant` and
   `diff review`.
5. A benchmark script in the spirit of the axi repo: the same coding task
   with and without `jev-axi files relevant`, measuring tokens and turns.

Open questions for you: confirm pricing and rate limits in the console, and
decide whether the binary name is `jev-axi`, `askjev`, or both.
