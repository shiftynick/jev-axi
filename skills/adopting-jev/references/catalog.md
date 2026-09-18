# What people use Jev for

Worked use cases, grouped by domain. Each entry gives the judgment (the questions), what goes in
the state, and where it runs. Measured numbers are attributed; treat unmeasured entries as ideas,
not evidence. Compiled from the TypeSafe docs, cookbooks, workflow evals, and about 30 community
projects (2026-09).

## Contents

- [Worked cookbooks in the live docs](#worked-cookbooks-in-the-live-docs)
- [Software engineering and CI](#software-engineering-and-ci)
- [Agent safety and harness engineering](#agent-safety-and-harness-engineering)
- [Moderation and trust & safety](#moderation-and-trust--safety)
- [Support and inbox routing](#support-and-inbox-routing)
- [Data labeling, cleaning, and ETL](#data-labeling-cleaning-and-etl)
- [Search, ranking, and RAG](#search-ranking-and-rag)
- [Evaluating LLM output and routing between models](#evaluating-llm-output-and-routing-between-models)
- [Compliance, claims, and review queues](#compliance-claims-and-review-queues)
- [Analytics and feedback](#analytics-and-feedback)
- [Real-time and interactive](#real-time-and-interactive)

## Worked cookbooks in the live docs

The docs index (`https://docs.typesafe.ai/llms.txt`) links a worked cookbook for several of these
shapes; read the current one before designing the same thing from scratch. Add `.md` to fetch it
as Markdown. Their thresholds are examples from their data.

| Shape | Cookbook path |
| --- | --- |
| Picking a value out of a document (find candidates in code, Jev selects, code copies) | `/cookbooks/pre_parsed_value_extraction_cookbook`, `/cookbooks/date_extraction_cookbook` |
| Recovering structure from flattened text | `/cookbooks/autoformat` |
| Large taxonomies, one level per request | `/cookbooks/hierarchical_classification` |
| Does the cited passage support the claim | `/cookbooks/citation_check` |
| Choosing a function and its typed arguments | `/cookbooks/function_calling` |
| Semantic search in a document; reranking | `/cookbooks/semantic_find`, `/cookbooks/rerank_typesafe` |
| Input and output guardrails for an LLM app | `/cookbooks/llm_guardrails` |
| Acting on confidence; self-consistency | `/cookbooks/classification_using_confidence`, `/cookbooks/consistency_noul_cookbook` |

## Software engineering and CI

Most of this domain is already packaged in the `jev-axi` CLI; reach for the SDK only for what it
doesn't cover.

| Use case | Judgment | State | Covered by |
| --- | --- | --- | --- |
| Build/test log triage | choice over ID-tagged log lines ("which line is the root cause") + nouls "shows a failure", "environmental" | last ~255 log lines, each prefixed with an ID | `jev-axi triage`, the GitHub Action `mode: triage` |
| Diff and PR review | per-file nouls (touches auth/payments, behavior without test, debug leftovers) + score for scope + choice for change kind | `{file_path, patch}` per file | `jev-axi diff`, `setup git-hooks`, Action `mode: review` |
| Semantic code search | one noul per function ("swallows an exception", "builds SQL by concatenation") | function source + path | `jev-axi filter "<predicate>" src/ --all` |
| Project-rule enforcement no linter can do | noul per rule, rule text in the state | `{rule_text, path, written_content}` | shared recipe run in CI or a pre-commit hook |
| Commit history mining | choice over change types + nouls for security fixes | message + diff | `git log | jev-axi filter`, or SDK batch |
| Vulnerable-code review queue | noul "contains an exploitable vulnerability" + severity score | snippet + language | SDK or `jev-axi filter` |
| Log volume pre-filter before an expensive pipeline | score for diagnostic value + choice priority + noul actionable | redacted log body + severity | SDK |
| Locating code/docs for a task | choice over file IDs + noul "does any file fit" | paths + previews | `jev-axi files`, `find` |

Measured: "every" scanned 1,302 Go functions in 3.7 s for $0.018, at about 110 questions per
request, and reports that positional lookup degrades past about 16 items, so it gives each
function its own question. jev-sec-bench found the vulnerable half of 200 matched pairs outranked
its secure twin 89% of the time, while absolute accuracy at a 0.5 cut was 71.5%: a ranking signal
for a review queue, not a gate. jev-axi's own agent benchmark found that ranking files did not
make coding agents cheaper.

**Caution:** don't send real credentials to detect credentials. Find them locally, then send
redacted text.

## Agent safety and harness engineering

| Use case | Judgment | Notes |
| --- | --- | --- |
| Pre-execution tool-call gate | nouls: destructive, exfiltration, beyond the user's request, runs downloaded code, weakens security, injected intent + a reversibility score | Decide routine read-only calls locally; hard-deny before the model; pick fail-open or fail-closed explicitly. `jev-axi setup safety`, `guard-exec` |
| Screening untrusted text for injection | nouls: contains instructions aimed at an agent, exfiltration/destructive request, pressure tactics | **Put what the assistant is for in the state**: that lifted accuracy from 89.7% to 96.5% and recall from 74.9% to 95.1% (jev-sec-bench, 662 messages). `jev-axi guard` |
| LLM app input/output guardrails | input nouls (jailbreak, harmful, medical advice, self-harm), output nouls (broke policy, harmful), severity score | Named threshold policies (strict/permissive) let one set of probabilities drive different actions with no second call |
| Output-side judges in agent loops | nouls: weakened a test, stub introduced, claims done without a passing build, leaked a secret, repeating a failing strategy | Runs in post-tool or turn-end hooks; keep observations bounded, let a fixed policy act, stay silent on mid-range scores. `jev-axi setup supervise`, `jev-axi progress` |
| Per-turn model routing | choice of model tier + reasoning depth | ~60% saving over always-frontier on a 237-turn replay, ~$0.00003 per turn. Falling back to the frontier model on low confidence ate ~80% of the savings; fall back to the middle tier |
| Skill/tool selection from a big catalog | choice over all skills + nouls "does this turn need one", then a second call over the top 3 with full descriptions | Wrong loads 16.8% → 7.3%, needless loads 9.8% → 4.0%; it also broke 7 of 315 covered requests, so tell the agent it may ignore the suggestion |
| Natural language to a typed function call | choice for the function, choice/noul per enum argument, "was it stated?" noul per optional argument | Call confidence = the **minimum** over the judgments, not the product. Keep an LLM for free-text arguments |
| UI/browser agents choosing the next action | choice of operation + speculative choice over indexed elements | Model output never becomes a selector or code; map it to pre-enumerated actions |

Every project in this group says the same thing: Jev is a filter, not a sandbox or a security
boundary.

## Moderation and trust & safety

- **Policy moderation with an explicit "uncertain"**: a choice rubric (category, severity,
  action, review path) where code returns `uncertain` when the top probability is below 0.60, or
  nouls per violation plus a severity score. On a borderline post over 15 repeats: 99.2% policy
  agreement, 74.2% automatic.
- **Spam**: one noul with structured true/false criteria. 95.96% plain, 98.33% with criteria, which
  matched a TF-IDF logistic regression trained on ~14.8k labels; averaging the two gave 99.22%.
  Reviewing the 0.3 to 0.7 band (4.6% of mail) left 99.50% on the rest, at $0.058 per 1,000 emails.
  The same criteria *hurt* on a second corpus: tune criteria per dataset and validate.
- **Phishing**: decomposed nouls (requests credentials, unexpected reward, time pressure, sender
  mismatch, link domain mismatch, disguised link). A single holistic "is this phishing?" scored
  62.6% against Haiku's 81.3%; five signals fed to logistic regression reached 95.0%. A two-line
  regex baseline already reached 91.8%, so measure against the dumb baseline too.
- **Community, chat, and game moderation**: nouls for toxicity, harassment, threats, personal data;
  severity score. One demo beeps over insults in live audio in ~466 ms.

## Support and inbox routing

- **Ticket triage with speculative fan-out**: in one request, a choice for department, noul for
  urgency, scores for frustration and bug severity, nouls for reproducible steps and refund
  requested, choices for return reason and requested resolution. Code reads only the answers that
  matter for the branch it took, and CCs a second team when it gets more than 0.25 probability.
- **Intent routing to the cheapest capable handler**: choice for intent plus a complexity score;
  deterministic handler, specialist LLM, or human.
- **Composite priority**: several scores, each normalized by `len(levels) - 1`, weighted in code.
- **Confidence-gated actions**: low-stakes actions act at 0.6; high-stakes ones need >0.85 or ask
  for confirmation.
- **Policy and eligibility checks**: nouls that compare a request against policy text and records
  held in the state ("does `refund_policy` support this refund given `order.charges`?").

TypeSafe's own customer-service workflow eval did not list Jev among the top performers, so
validate before automating replies.

## Data labeling, cleaning, and ETL

- **Deep taxonomies**: one choice per level, option descriptions carrying subtrees; beam search
  (K=3) over path probability matched 4/4 expected leaves where a greedy walk got 2/4.
- **Coarsen when unsure**: report the fine label at confidence ≥ 0.9, otherwise its parent. The
  confident half was 27/30 correct; the unsure half rose to about 70% useful at the coarser level.
- **Entity resolution**: a 3-level score whose levels *are* the outcomes (leave unlinked / send to
  a curator / merge), plus nouls showing where the pair disagrees. 450 pairs → 40 merges, 50
  curator, 360 unlinked.
- **Extraction by selection**: a regex or NER finds candidate spans, a choice picks the right one
  (plus `none`). The answer is always a verbatim span. Over 255 candidates, narrow in two stages.
- **Dates**: choices for mode, month, day, year, weekday; code assembles the date and does the
  calendar math. Date confidence = the minimum over the parts.
- **Verifying LLM extractions (cascade)**: per-field nouls framed so **true means something is
  wrong** (hallucinated, off target, unreasonable, incomplete, format violation), escalating to a
  reasoning model when *any* field exceeds 0.7. Use a max gate, never a mean.
- **Semantic features for classical ML**: many scores and nouls per row become model features. On
  wine-review scoring, RMSE went from 2.47 (word counts) to 1.87 with 18 questions and 1.77 with 38.
- **Map-reduce and counting**: one noul per item, summed in code. 21 questions over 37 documents
  (777 judgments) ran in under 0.7 s for about a quarter of a cent.

## Search, ranking, and RAG

- **Reranking a shortlist**: 30 candidates scored in one call with a 4-level rubric. nDCG@10 0.692
  vs Cohere Rerank 4 Pro 0.691, at 422 ms vs 844 ms and $0.45 vs $2.51 per 1,000 queries. Better on
  negation (71% vs 67%), worse on French (by 6.4 points). Over BM25 alone on legal retrieval,
  top-1 went from 5% to 18%.
- **Line-level search with an "exists" check**: a choice over ID-tagged lines plus a noul "does any
  line address this". On GitHub's ToS the top line for an arbitration query scored 0.86 while
  "exists" was 0.14, correctly saying the document doesn't cover it.
- **Gating retrieved passages**: nouls for relevance, evidence, contradicts-the-premise, and
  injection, with first-match-wins routing in code. A planted injection passage ranked first by
  similarity and was excluded at 0.99.
- **Citation checking**: string-match the quote in code first (a miss means fabricated), then a
  choice for supports / contradicts / says nothing, auto-accepting at confidence ≥ 0.8.
- **Duplicate detection**: rank existing issues against a new one.

## Evaluating LLM output and routing between models

- **Rubric grading instead of LLM-as-judge**: decomposed nouls or per-dimension scores, weighted in
  code. On a synthetic 100-answer scoring scene: 100/100 fixture agreement at p50 176 ms and
  $0.0119, against $0.31 for a small LLM judge.
- **Grounding and hallucination checks**: see citation checking and the extraction cascade above.
- **Cascades**: cheap model first, escalate on flags or low confidence.
- **Writing diagnostics**: ~30 nouls, 3 choices, and 4 scores in one request (~1,200 tokens,
  812 ms).

## Compliance, claims, and review queues

- **Document question batteries**: 13 questions about one 54k-character regulation in a single
  call, at 12x lower cost and 10x lower latency than 13 calls.
- **Insurance claims triage**: 14 nouls (covered, exclusion applies, within limit, reported in
  time, fraud flag, docs sufficient) with a 0.30 to 0.70 band routing to an adjuster. Measured for
  repeatability, not accuracy: 111 ms per call against 1.1 to 13.9 s for LLMs.
- **Invoices and AP**: field-verification nouls and candidate choices, with all arithmetic in code.
  TypeSafe's own invoice eval did not list Jev among the top performers.
- **Security alert triage**: choice of close / escalate / contain. 61.7% against Sol's 62.5%, at
  $0.0001 and 0.3 s against $0.0295 and 8.5 s: the clearest "same accuracy, far cheaper" result.
- **Contracts, marketing claims, KYC, resume screening**: composite scores with role-specific
  weights in code. High-stakes and legally sensitive: keep a human in the loop and use explicit,
  job-related criteria.

## Analytics and feedback

- **Coding survey, interview, and review text**: one noul per theme when several can apply, or a
  choice for the primary theme, plus sentiment and intensity scores.
- **Feedback routing**: as ticket triage, plus churn and purchase-intent signals.
- **Audience simulation**: batched nouls per persona. The project itself says these are not a
  forecast of real behavior.

## Real-time and interactive

- **Smart home and IoT**: choices for room, device, and action, plus a noul for "multiple distinct
  actions" that hands off to an LLM to split the request. A Home Assistant integration turns
  questions about entity state into sensors ("is the laundry finished but still in the machine?").
- **Games, NPCs, robotics**: a choice of the legal action from structured state, with control and
  safety logic in code. TypeSafe's own launch post notes a non-AI bot plays Doom better.
- **Live UI judgments as the user types**: ~16 judgments re-evaluated on change, debounced, with
  the key kept server-side.
- **Page decluttering**: a typed choice per element, hiding only when both probability and
  confidence are at least 0.9, cached per page template.
