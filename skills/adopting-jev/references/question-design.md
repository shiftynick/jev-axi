# Designing the questions

The questions and thresholds are the part humans should review, and the part models are worst at
writing. Take the time here; wording moves results more than thresholds do.

## Decompose first

The docs call decomposition "probably the most important concept". One broad verdict ("is this
spam?", "is this tool call correct?", "rate this pitch") hides the reasoning and scores worse: a
single phishing verdict reached 62.6% where five narrow signals reached 95.0%.

Write the narrow facts a person would check, ask each as its own question, and combine them in
code where you can see and tune the rule.

## Choosing the type

| Type | Use for | Returns | Watch out for |
| --- | --- | --- | --- |
| **noul** | a fact that is true or false | `noul`: probability of yes. **No confidence field** | 0.5 means "unsure", not "medium". Don't use it for degree |
| **choice** | one of a written-down set, up to 255 | `choice`, `probabilities` over all options, `confidence` | Probabilities sum to 1, so something always wins: add `none`/`other`, or a separate "does any fit" noul |
| **score** | a degree, 2 to 10 ordered levels | `score` (probability-weighted mean, can land between levels), `probabilities`, `confidence` | Each level is judged alone; the model never sees level numbers or its neighbours |

## Writing instructions

- The **whole question goes in `instructions`**. Question IDs are never sent to the model, so
  `urgent: {instructions: "..."}` tells the model nothing by its name.
- **Name the narrowest fact that decides it.** A formatting cookbook changed "same paragraph" to
  "picks up mid-sentence" and the block count went from 12 (wrong) to 17 (right). One project's
  rule: "the right fix is usually to phrase the condition better, not to move the threshold".
- **Point at parts of the state** with backticked paths: "Does `ticket.messages[0].text` request a
  refund that `refund_policy` allows?"
- **Give the context the judgment needs.** A guardrail that doesn't know what the assistant is for
  is guessing at the policy: adding deployment context raised injection recall from 75% to 95%.
- **Instructions and criteria can be structured**, not just strings: `{question, focus, compare}`
  for instructions, `{what, not_for, examples}` for an option or a noul's true/false case. Field
  names are free-form. Use structure to separate confusable options.
- Keep each question about **one dimension**. Several dimensions in one level description ("punctual
  and smart and experienced") lower confidence.

## Criteria

- **Noul criteria** (`{true, false}`) are optional and pin down boundaries. Adding them took spam
  accuracy from 95.96% to 98.33%, matching a classifier trained on 14.8k labels. The same criteria
  *hurt* on a different corpus (98.6% → 97.0%), so validate criteria on the data they'll run on.
- **Framing "true = something is wrong"** is fine when the criteria say so explicitly (extraction
  verification does this deliberately). What hurts is contradiction: a `true` case that describes
  the negative.
- **Score levels describe situations**, never bare numbers: `["0", "1", "2"]` measurably fails. If
  a rare extreme needs different handling, give it its own level.
- **Each score level stands on its own.** The model judges every level separately and never sees
  the level numbers or the neighbouring levels. "Worse than the previous level" or "somewhat more
  urgent" means nothing to it. Write each level as a concrete situation someone could recognise
  with the other levels covered up: "a feature misbehaves but a workaround exists", not "medium".
- **Use structure where a sentence runs out.** Instructions and criteria accept objects and arrays
  as well as strings. Spend the fields on what separates confusable cases: a definition, a contrast
  ("not this: ..."), exclusions, and a short example or two.

  ```json
  "refund": {"what": "Asks for money back for a charge already made",
             "not_for": "Asking what the refund policy is, or cancelling a future renewal",
             "examples": ["you charged me twice, I want one back"]}
  ```
- **Examples** in criteria only help when they resemble real inputs.

## Candidate coverage

Jev can only choose among the options you list. It cannot return a value that is not there, and
because choice probabilities sum to 1, a list missing the right answer still produces a winner.
So extraction and normalisation are a three-step job, and the model does only the middle step:

1. **Code finds the candidates.** A regex, parser, or lookup produces every plausible value: all
   the dates in the document, every amount, the known product names, the rows of a lookup table.
   Favour recall; a spurious candidate costs little, a missing one cannot be chosen.
2. **Jev selects.** One choice question over the candidates ("Which of these is the invoice due
   date?"), with a `none` option or a separate "is it present at all" noul.
3. **Code copies or normalises** the selected candidate. The value comes from your parser, never
   from the model.

Before shipping, measure coverage on real inputs: how often is the right value in the candidate
list at all? That number caps the accuracy of everything after it. The pre-parsed value extraction,
date extraction, and structure recovery (autoformat) cookbooks in the docs are worked versions.
The same shape covers function calling (choice over the functions, then a choice or noul per typed
argument over candidate values), citation checks (a noul per claim and cited passage pair), and
hierarchical classification (a choice per level of the taxonomy, next).

## Batching and fan-out

- Put every question about the same state in **one request**. Coding agents habitually make one
  call per question; that cost 12x more and ran 10x slower in TypeSafe's own test.
- **Speculative fan-out**: ask the questions for every branch at once and let code ignore the ones
  that don't apply. Cheaper than a second round trip.
- **State each speculative premise in the question.** A fan-out question is asked before you know
  its branch applies, so write the premise in: "Assuming this ticket is a billing issue, is the
  customer asking for a refund?" Without it, the model answers a question about a situation that
  may not exist, and the number means nothing even when you do use it.
- Use a **second request** only when an earlier answer is needed to build it: to fetch evidence you
  don't have yet, to construct new state, or to decide the next option list (the next level of a
  taxonomy, a narrower set of candidates). If the second request could have been written before
  the first answer came back, it belongs in the first request.
- **One question per item** beats one positional list when each item needs its own judgment;
  positional lookup degrades past roughly 16 items.

## What confidence means

`confidence` on a choice or score says how concentrated the probability distribution is. It does
not say the answer is right, that the workflow is correct, or that you may act. (Nouls have no
confidence field; distance from 0.5 plays that role.) Three consequences:

- **Several acceptable options spread the probability.** If two options would both be fine ("which
  of these three greetings suits the customer?"), low confidence is the correct output, not a
  failure. Take the argmax and move on. Reserve confidence gates for choices where the options
  lead to different consequences.
- **Ignore uncertainty on branches you don't use.** In a fan-out, the questions for branches that
  did not apply will often come back uncertain. They were never part of the decision; don't let
  them trigger review or lower a combined score.
- **Low confidence often means an option-list problem.** Overlapping options split the mass. Fix
  the list (merge, or sharpen with `not_for`) before moving a threshold.

Gate actions on what a mistake costs, using thresholds measured on the user's own data.

## Turning answers into decisions

- **Bands, not one cutoff.** Probabilities wobble by about 0.01 between runs, and borderline cases
  flip. Use act / review / escalate bands with a middle band that goes to a human, and set the
  thresholds per action according to what a mistake costs.
- **For "pick the best", take the argmax**; confidence matters for acting automatically, not for
  ranking.
- **Combine with max, not mean.** In extraction verification, escalating when *any* field exceeds
  0.7 is the point; averaging flags away a single confident red flag.
- **For composite calls, use the minimum** over the judgments involved, not a product.
- **Normalize scores** by `len(levels) - 1` before weighting several together.
- **Don't interpolate exact magnitudes** from a score's expected value, and don't compare absolute
  probabilities across differently worded questions.
- Keep the questions and thresholds **in one file**. That file is what a human reviews.

## Keep raw judgments, change policy in code

- **Store the raw answers** (every noul, the full choice and score distributions) next to the item,
  with the question-set version and model. Weights, filters, thresholds, and ranking formulas are
  then code over stored numbers: changing them needs no new API call, and you can replay a policy
  change over last month's traffic before shipping it.
- **Never put the policy in the question.** "Considering that security matters twice as much as
  style, how good is this PR?" bakes the weights into a number you can't take apart. Ask for
  security and style separately and weight them in code.
- **"Any serious violation" is not a weighted sum.** A sum lets four clean signals average away one
  confident red flag. Write a veto as separate conditions: `if any(p[k] >= limit[k] for k in serious)`,
  each with its own limit, and only then a weighted score for whatever is left.

## When the state changes

A judgment is about the state it was given, at the moment it was given.

- **Keep inferred state apart from observed facts.** An answer from Jev ("probably a billing
  issue", "likely the same entity") is an inference. Store it as one, with its probability and
  what it was inferred from, in a different field from facts the system observed. Feeding an
  inference back in as a fact in a later state makes the next answer confident about a guess.
- **Check freshness before applying a result.** Between asking and acting, the ticket gets a reply,
  the file is edited, the order ships. Record what the judgment read (a version, hash, or
  timestamp) and compare before acting; if it moved, ask again. This matters most for queued work,
  cached answers, and anything a person approves later.
- A response cache must be keyed on the full state, the questions, and the model.

## When a result is wrong, find which part failed

Before changing a question or a threshold, sort the failure. Each kind has a different fix, and
treating them all as "the model was wrong" leads to threshold churn.

| Cause | Looks like | Fix |
| --- | --- | --- |
| **Missing evidence** | The state never held what was needed; the right candidate was not in the list | Fetch more, fix candidate coverage, add context |
| **Model error** | The evidence was there and clear, and the answer was still wrong or unsure | Reword, add criteria, decompose further; keep the case in the eval set |
| **Code error** | The answers were fine; thresholds, combination, or parsing mishandled them | Fix the policy code; stored raw judgments let you replay it |
| **Service failure** | Timeout, rate limit, 5xx, partial response | The failure policy in [integration.md](integration.md), not a question change |

Log enough to tell these apart afterwards: the state sent, the raw answers, the decision taken,
and any error.

## A worked shape

```python
# questions.py: the reviewable part
TICKET_QUESTIONS = {
    "department": {"type": "choice", "instructions": "Which team should handle this ticket?",
                   "criteria": {"billing": "Charges, invoices, refunds",
                                "technical": "The product is broken or erroring",
                                "sales": "Pre-purchase questions, quotes",
                                "other": "None of the above"}},
    "urgent": {"type": "noul",
               "instructions": "Is the customer blocked right now, with no workaround?",
               "criteria": {"true": "Production is down, money is stuck, or a deadline is today",
                            "false": "Annoying but they can keep working"}},
    "frustration": {"type": "score",
                    "instructions": "How upset does the customer sound?",
                    "criteria": ["Neutral or friendly",
                                 "Mildly annoyed but civil",
                                 "Angry, threatening to leave or escalate"]},
}
THRESHOLDS = {"urgent_act": 0.75, "urgent_review": 0.45, "department_min_confidence": 0.60}
```

Code reads `department` only when its confidence clears the threshold, pages someone when
`urgent` is above `urgent_act`, and routes the middle band to a person.
