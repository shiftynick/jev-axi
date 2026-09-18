# Proving it works before trusting it

Jev is cheap enough that the temptation is to switch first and measure later. Every project that
reported trouble skipped this part.

## 1. Shadow mode first

Run the questions next to the existing implementation without acting on them. Log state, question
version, every probability, the current system's decision, and what Jev would have done. A day or
two of real traffic gives you a labeled set and a disagreement list for free.

Annotate-only mode is the same idea for agent hooks and CI: report what it would have blocked.

## 2. Build a labeled set from real traffic

- A few hundred examples, drawn from production rather than invented, including the rare classes.
- Label them from the outcome where you can (what the human actually did, whether the ticket was
  reopened, whether the commit was reverted).
- Hold out a test split you don't look at while tuning wording or thresholds.
- Beware label noise: in one security benchmark at least 38% of the apparent false positives were
  wrong labels, not wrong answers. Check disagreements by hand before believing them.
- Public corpora may be in the training data, so prefer your own.

## 3. Compare against three baselines, not one

1. **What runs today** (the LLM call, the regex, the human queue).
2. **The dumb baseline**: a keyword list or a two-line rule. In the phishing benchmark this scored
   91.8% and beat Jev's best single question. If it wins, ship it and stop.
3. **An LLM asked the same decomposed questions.** Twice now, that matched Jev's accuracy at
   roughly 27x the cost. This is the comparison that tells you whether you're buying accuracy or
   price, and it keeps you honest about which one you needed.

TypeSafe publishes `system-one-adapter` (Python), a drop-in client backed by OpenAI or Anthropic,
so the same questions can run against an LLM for the A/B.

## 4. Measure all four axes

| Axis | How |
| --- | --- |
| Accuracy | Per class, not just overall. Confusion matrix; recall on the class that matters |
| Cost | Input tokens × $0.042 per 1M, per 1,000 items, against the current bill |
| Latency | p50 and p95 at your real payload size, from where your code runs |
| Coverage | What fraction can be decided automatically at your thresholds, and how much goes to review |

A result like "same accuracy, 1/300th the cost, 0.3 s instead of 8.5 s" is the shape of a good
outcome. "Slightly better accuracy" usually isn't real.

## 5. Set thresholds from the data

Every threshold in the TypeSafe cookbooks, in jev-axi's recipes, and in these references (0.7,
0.35, 0.75 / 0.45) came from someone else's documents and someone else's cost of being wrong. Use
them to get a prototype running, never as the shipped value.

- Sweep the threshold over the labeled set and pick it from the precision or recall you need, per
  action, not per question.
- Keep a review band around the boundary: probabilities move by about 0.01 between runs, and
  borderline labels do flip. In the spam eval, sending the 0.3 to 0.7 band (4.6% of mail) to a
  human left 99.50% accuracy on the rest.
- Set the band by what a mistake costs: a wrong auto-block needs a wider review band than a wrong
  routing hint.
- Re-check after any wording change. Higher confidence is not evidence of better wording; only the
  held-out set is.

## 6. Roll out in stages

1. Shadow, acting on nothing.
2. Act only in the confident band; everything else keeps the old path.
3. Widen the band once the logs show the confident band is right.
4. Keep the old path behind a flag, and alert on rate: a silent drift in the "review" share is the
   first sign something changed.

Pin the model version before stage 2, or a model update will move your thresholds under you.

## 7. Keep the eval

Save the labeled set and a script that runs it. It costs cents to re-run, catches regressions when
someone edits a question, and tells you whether the next model version is better or worse for
your data. jev-axi's own eval loop does exactly this: YAML cases, a pass/fail plus a 0 to 1 score,
and a saved baseline to compare against.
