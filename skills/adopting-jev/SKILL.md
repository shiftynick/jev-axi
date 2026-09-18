---
name: adopting-jev
description: Finds where TypeSafe's Jev model fits in a codebase and designs the integration. Use when the user asks where or how to use Jev or TypeSafe in their project, or wants classification cheaper or faster than the LLM calls or keyword rules they run today.
compatibility: Reads the user's codebase. Prototypes need a TYPESAFE_API_KEY and either the jev-axi CLI or the typesafe-sdk (Python) or @typesafe-ai/sdk (JS) package.
license: MIT
---

# Adopting Jev in a project

Jev is a "System One" model: it answers typed questions about a piece of text with calibrated
probabilities in roughly 0.1 to 0.5 seconds, for about $0.042 per million input tokens, with
output tokens free. Three question types: **noul** (probability of yes), **choice** (one of up to
255 options), **score** (a position on a 2 to 10 level scale). All questions in one request see the
same state and run in parallel, so asking thirteen instead of one cost 12x less than thirteen
calls in TypeSafe's own test.

It never generates text, explains itself, does arithmetic, or reads images. Independent write-ups
put it at roughly comparable accuracy to frontier models on snap judgments, sometimes lower:
treat it as **cheaper and faster, not smarter**. That framing decides where it belongs.

Your job with this skill: find the places in the user's project where a judgment is being made
expensively or crudely, design the Jev version, and set up an honest comparison before anything
switches over. Don't install, rewrite, or enable anything unprompted.

## The live docs are the source of truth

This skill's prices, limits, model names, and benchmark numbers were true when it was written and
go stale. Before designing an integration or quoting a number to the user:

1. Read the index at `https://docs.typesafe.ai/llms.txt`. It lists every page.
2. Fetch pages as Markdown by adding `.md` to the path
   (`https://docs.typesafe.ai/primitives/score.md`). It is smaller and cleaner than the HTML.
3. Before writing integration code, read the current API reference (`/api.md`), the SDK page for
   the project's language (`/sdk/python.md`, `/sdk/javascript.md`) and its changelog, and
   `/models.md` for current model names and limits. If the project already calls an older API or
   SDK version, look in the index and the changelog for migration notes before changing calls.
4. If the docs can't be reached, read the installed SDK's own types (`node_modules/@typesafe-ai/sdk`,
   or the Python package in site-packages) rather than guessing signatures, and tell the user
   that the numbers you quote are from this skill and unverified.

When the docs and this skill disagree, the docs win; say so in your report. Thresholds in
cookbooks, and in these references, are examples from someone else's data, never defaults:
[references/validating.md](references/validating.md) is how the user gets their own.

## Workflow

### 1. Understand the project and what hurts

Read the README, the dependency manifest, and the entry points. Ask the user which of these they
feel, since it decides what's worth proposing:

- An LLM bill or latency budget that classification dominates.
- Rules over user text that keep needing new keywords.
- A queue people work through by hand (moderation, support, claims, review).
- An eval or guardrail harness that calls a big model to judge.

If they just want to explore, scan anyway and bring back the ranked list.

### 2. Scan for candidates

Use the grep patterns in [references/signals.md](references/signals.md) for the project's
languages. You're looking for a decision with a small set of outcomes being made by something
expensive (an LLM), something brittle (keyword lists), or someone's time (a manual queue).

Record each candidate as file:line, what decides today, and what the outcome space is.

### 3. Qualify each candidate

Check it against [references/fit-and-limits.md](references/fit-and-limits.md). A candidate fits
when the outcome is one of a fixed set, a yes/no, or a position on a scale; the input is text
that fits in about 32k tokens after filtering; and being wrong sometimes is survivable or
reviewable.

Rule out, and say why, when the site needs generated text, multi-step reasoning, exact
extraction with no candidate list, arithmetic or dates, non-text input, or acts as a security
boundary on its own. Keep regexes and parsers that already decide exactly: in one public
benchmark a two-line rule beat Jev's best single question.

### 4. Design the judgment

Follow [references/question-design.md](references/question-design.md). The short version:

- **Decompose.** Several narrow questions beat one broad verdict, by a lot: 62.6% for a single
  "is this phishing?" against 95% for a model over five specific signals.
- Pick the type per question: noul for a fact, score for a degree (never a noul: 0.5 means
  "unsure", not "medium"), choice for one of a list, plus `none` or an "exists" noul.
- Put the whole question in `instructions`; question IDs are never sent to the model.
- Write what the state contains, including the context the judgment needs (a guardrail that
  doesn't know what the assistant is for is guessing: adding that context moved injection recall
  from 75% to 95% in one benchmark).
- Check **candidate coverage**: the model can only pick what is in the list, so code has to find
  the candidates first.
- Decide the bands: act, review, escalate, with the review band absorbing run-to-run wobble
  around a threshold. Keep questions and thresholds in one file so humans can review them.

### 5. Choose where it runs

[references/integration.md](references/integration.md) covers both paths:

- **Developer workflow** (CI, hooks, commit checks, log triage, file ranking): the `jev-axi` CLI
  and its recipes already do this. Don't write code for something a command covers.
- **Product code** (request path, batch job, queue worker): the Python or JS SDK, with batching,
  bounded concurrency, a pinned model version, caching, and a deliberate failure policy.

### 6. Plan the validation before switching anything

[references/validating.md](references/validating.md). The pattern that keeps people out of
trouble: run it in shadow mode, logging decisions without acting; collect a few hundred labeled
examples from real traffic; compare against both the current implementation and an LLM asked the
*same* decomposed questions; then set thresholds from that data.

### 7. Report

Give the user a table, most promising first, and offer to prototype the top one:

| Site | Decides today | Jev version | Why it's better | Risk | Effort |
| --- | --- | --- | --- | --- | --- |
| `api/tickets.py:88` | GPT call returning one of 6 labels | 1 choice + urgency score, batched | ~100x cheaper, ~1s to ~0.2s | Misroutes rare labels | Half a day + labeled sample |

Then, for the one they pick: the exact questions, where they'd live, the integration snippet, the
validation plan, and an estimated cost per 1000 items (input tokens ÷ 1M × $0.042).

For worked examples by domain, including what goes in the state and which signals to look for,
read [references/catalog.md](references/catalog.md).

## Ground rules

- **Their data, their call.** Everything sent to Jev leaves the machine. Flag any candidate whose
  input carries secrets, PII, or regulated data, and say so before proposing it.
- **Don't oversell.** Quote measured numbers from the references, mark your own estimates as
  estimates, and name the cases where Jev lost.
- **Prototype small.** One question set, one file, run against real examples the user provides,
  before touching any production path.
