# Your Claude Code skill will not get used

I spent $36.85 of Claude credits and 20 cents of Jev credits running 56 headless
Claude Code sessions against a real 390k-line repo, to find out whether my own
tool helps coding agents. The headline result is not the one I wanted, and it is
not about cost.

It is this: **across 22 benchmark runs where the agent was free to choose, it
loaded my skill zero times.** Not rarely. Zero.

## The setup

I wrote [jev-axi](../README.md), a CLI wrapping
[TypeSafe's Jev](https://docs.typesafe.ai/introduction) — a model that never
generates text and only answers typed questions with calibrated probabilities,
in about 400ms for a few thousandths of a cent. One of its commands, `files`,
ranks every source file in a repo by how likely you need to open it for a given
task. The obvious pitch: an agent that ranks first should read less, so it
should cost less.

To find out, I ran real headless `claude -p` sessions against a pinned 390k-line
TypeScript repo. Narrow "where is X" questions are solved by one `grep`, so the
tasks that matter are the broad ones, where the answer is genuinely spread across
the tree:

> Trace how terminal output gets from the shell process on the server to what the
> user sees in the web app's terminal. List the main files at each hop, and tell me
> what limits how much output is kept on the server and in the client.

Answers were graded against six regexes that must all appear: two filenames, the
terminal emulator in use, and the three limits (`5000 lines`, `8 MiB`,
`512 KiB`). Conditions varied only in how hard I pushed jev-axi at the agent:

| condition | how jev-axi was offered |
| --- | --- |
| `baseline` | not installed |
| `jev-axi` | skill in `.claude/skills`, binary on `PATH` |
| `jev-axi-hook` | plus a SessionStart hook announcing it |
| `jev-axi-agent` | plus a `jev-explore` subagent |
| `jev-axi-explore` | that subagent installed *as* `Explore`, overriding the built-in |
| `jev-axi-forced` | the prompt tells the agent to use it |

Crucially, the prompts never mention jev-axi except in `jev-axi-forced`. I wanted
to know whether it would get used on its own.

## Finding 1: availability is not adoption

Here is the `skill loaded` column across every run where the agent had a choice:

| condition | runs | loaded the skill | ran the binary | actually asked Jev anything |
| --- | ---: | ---: | ---: | ---: |
| `jev-axi` | 10 | 0 | 0 | 0 |
| `jev-axi-hook` | 4 | 0 | 0 | 0 |
| `jev-axi-agent` | 1 | 0 | 0 | 0 |
| `jev-axi-explore` | 7 | 0 | 7 | 3 |
| `jev-axi-forced` | 12 | 12 | 12 | 12 |

A skill sitting in `.claude/skills` with the binary on `PATH` was never loaded.
Adding a SessionStart hook that announces the tool at the top of every session
changed nothing. Registering a custom `jev-explore` subagent changed nothing
either, because Claude Code reaches for its own built-in `Explore` instead.

The only thing that got jev-axi into the exploration path was *overwriting*
`Explore` with mine — and look at the last two columns of that row. The binary was
invoked in all 7 runs, but 4 of them made zero API calls: the subagent ran
`jev-axi`, then went back to grepping without ever asking it a question. It had
spotted a promising identifier, which is exactly what its system prompt tells it
to do.

This is the part I would want to know before writing an agent skill. A good
description and a discoverable install are not enough. The agent already has a
cheap, reliable habit — `grep` — and a new tool has to beat that habit at the
moment of choice, not merely exist.

## Finding 2: when I forced it, the numbers were noise

Fine: force it, and measure the ceiling. Two broad tasks, three repeats each,
Sonnet. I ran that twice, a few hours apart, same tasks, same pinned commit.

**Session A**

| condition | correct | mean cost | median cost | median file reads |
| --- | ---: | ---: | ---: | ---: |
| `baseline` | 6/6 | $0.869 | $0.901 | 16 |
| `jev-axi-forced` | 5/6 | $0.891 (**+2%**) | $0.858 (**-5%**) | 12 (**-25%**) |

**Session B**

| condition | correct | mean cost | median cost | median file reads |
| --- | ---: | ---: | ---: | ---: |
| `baseline` | 6/6 | $0.715 | $0.705 | 14 |
| `jev-axi-explore` | 5/6 | $0.694 (**-3%**) | $0.723 | 12 |
| `jev-axi-forced` | 5/6 | $0.826 (**+15%**) | $0.881 | 18 (**+29%**) |

Same tool, same tasks, same model, same commit. Read the median columns and
forcing the tool went from a 5% saving and a quarter fewer file reads in session
A to a 25% penalty and a quarter *more* in session B. The effect flips sign.

It is worse than that. Within session A, the mean says forcing the tool cost 2%
*more* while the median says it cost 5% *less*. Six runs are few enough that the
choice of summary statistic decides the direction of your result.

So the honest reading is that there is no effect I can detect at this sample
size: 6 runs per condition, on 2 tasks. Not "a small effect" — an undetectable
one.

I had written the favourable number in my README: "agents told to use `files`
read 25% fewer files but cost the same." That is session A's median, quoted
without session B next to it, and attributed to the wrong condition besides. It
was wrong of me and it is now corrected in the repo. If you take one
methodological thing from this post: an agent benchmark with single-digit n
produces confident-looking percentages in either direction, and "we measured a
25% reduction" is a sentence you can write from noise without ever noticing you
did.

Jev's own spend, for what it is worth, is a rounding error: 20 cents across all
56 runs, at most $0.039 in any single run, against $36.85 of Claude. The cost of
an agent session is the agent, and a sub-cent judgment model cannot move that
number by being cheap. It has to change what the agent does.

## Finding 3: the tool was aimed at the wrong problem

Why doesn't ranking help? Because knowing *which* files matter is not the
expensive part. The task above wants the scrollback limit, the server-side byte
cap, and the client-side one — three specific numbers, each buried in a different
file. A perfect oracle that names all three files instantly saves you the search,
and you still have to read all three to find the constants. Exploration was never
the bottleneck; comprehension was, and a model that only emits probabilities
cannot do comprehension for you.

What the same model is genuinely good at is the judgment an agent cannot make
cheaply by reading, because the answer is not in the code:

- **Is this command about to do something irreversible?** On 44 labeled tool
  calls — 24 that must be blocked or escalated, including base64-obfuscated deletes
  and destructive logic hidden inside innocuous-looking local scripts — a
  `PreToolUse` gate scores 44/44. Routine commands are classified
  locally and never leave the machine, so the common case is free.
- **Is this fetched page trying to instruct my agent?** Screening a web page,
  issue, or vendored doc for prompt injection costs about $0.00004 and 375ms.
  There is no cheaper way to do that, and the agent reading the page itself is
  precisely the thing you cannot trust to judge it.
- **Is this build failure the real error or the flaky one?** A 10k-line log is
  expensive for an agent to read and trivial to score.

These have something in common that file ranking does not: the fast model is not
competing with `grep`. It is answering a question the agent had no cheap way to
answer at all.

## What I would tell my past self

1. **Benchmark the thing you believe before you put it in the README.** I built
   file ranking first because it was the most obvious pitch. It is the one feature
   the benchmark does not support.
2. **Measure adoption separately from effect.** I nearly missed the zero-loads
   result because I was staring at the cost column. "Does it help when used?" and
   "does it get used?" are different questions, and the second one was the more
   interesting failure.
3. **Run enough repeats to see the sign flip.** If I had only run session A, I
   would have shipped a 25% improvement claim and believed it.

The benchmark harness, task definitions, and raw per-run JSON are in
[`bench/agent`](../bench/agent).
The numbers above are reproducible with `bench.py`, though they will cost you
real credits and will not come out identical, which is rather the point.
