# Writing questions for Jev

## Contents
- How Jev answers
- Principles
- Reading confidence
- Choosing the question type
- Examples: check, pick, rate
- Many questions in one call with `ask`
- Saved recipes

## How Jev answers

Each call sends one piece of text (the state) and one or more typed questions. Jev returns a
probability for every option you defined. It cannot answer outside those options and does not see
your reasoning, the question id, or other questions in the same call. Everything it needs has to
be in the state or in the question's own wording.

## Principles

- **One judgment per question.** "Does this diff touch authentication?" gets a confident answer.
  "Is this diff good?" does not. Split broad judgments into several narrow questions and combine
  the answers yourself.
- **Say what yes and no mean** when the boundary is fuzzy. `check` accepts `--yes` and `--no`
  descriptions; they often move an answer from 0.5 to a clear yes or no.
- **Name options by meaning and add a short description.** `--option bugfix="corrects wrong behavior"`
  beats a bare `bugfix`.
- **Include a "none" option** when nothing might fit, or the probabilities will be forced onto a
  wrong option.
- **Describe score levels concretely,** lowest first. Each level should describe a situation, not
  just "low", "medium", "high". Jev judges each level on its own and never sees the level numbers
  or the other levels, so every level has to make sense with the rest covered up: "worse than the
  previous one" tells it nothing.
- **List every value that could be right.** Jev cannot pick something that is not an option. To
  pull a value out of text, find the candidates yourself first (grep, a parser), offer them as
  options with a `none`, and copy the winner from your own list.
- **Point at parts of structured state.** With JSON state, refer to fields by path in backticks,
  for example `` `ticket.body` `` or `` `messages[2].text` ``.

## Reading confidence

`confidence` on `pick` and `rate` measures how concentrated the probabilities are, not whether the
answer is right. For `check`, which has no confidence, the band comes from the distance from 0.5.

- If two options would both be acceptable, the probability splits between them and confidence
  drops. That is a correct answer to a loose question: take the top pick. Treat low confidence as
  a warning only when the options lead to different actions.
- When you ask several questions at once and end up using only some, ignore the bands on the ones
  you didn't use.
- Low confidence with overlapping options usually means the options need sharper descriptions,
  not that the text is ambiguous.

## Choosing the question type

| You want | Use | Returns |
| --- | --- | --- |
| Whether something is true | `check` (noul) | `p_yes` from 0 to 1 |
| One option from a set | `pick` (choice) | the pick plus a probability per option |
| A position on an ordered scale | `rate` (score) | a score between levels plus a probability per level |
| Several of these about the same text | `ask` | one row per question |

## Examples

Yes/no with the boundary spelled out:

```bash
jev-axi check "Does this error message indicate a problem in our code rather than the environment?" \
  --yes "a bug in the project's own source, such as a wrong value or an unhandled case" \
  --no "network, permissions, missing services, rate limits, or other infrastructure" \
  --state error.txt
```

One option from a set, with a way out:

```bash
jev-axi pick "Which part of the system is this issue about?" \
  --option api="HTTP handlers and request validation" \
  --option billing="invoices, charges, refunds" \
  --option ui="rendering, layout, styling" \
  --option none="none of these areas" \
  --state issue.md
```

A scale with concrete levels:

```bash
jev-axi rate "How much user impact does this bug report describe?" \
  --level "cosmetic: no effect on what users can do" \
  --level "degraded: a feature misbehaves but a workaround exists" \
  --level "blocking: users cannot complete a core task" \
  --state report.md
```

## Many questions in one call with `ask`

Write the questions to a JSON file keyed by id. Ids are for you; put the full meaning in
`instructions`.

```json
{
  "area": {
    "type": "choice",
    "instructions": "Which part of the system does this issue concern?",
    "criteria": { "api": "HTTP handlers", "billing": "invoices and charges", "none": "none of these" }
  },
  "has_repro": {
    "type": "noul",
    "instructions": "Does the issue include concrete steps to reproduce the problem?"
  },
  "severity": {
    "type": "score",
    "instructions": "How severe is the problem for users?",
    "criteria": ["cosmetic", "degraded with a workaround", "blocks a core task"]
  }
}
```

```bash
jev-axi ask --questions questions.json --state issue.md
```

Add `--full` to see the probability of every option.

In an `ask` file, `instructions` and criteria may be objects or arrays instead of strings. Use that
to separate options that get confused: `{"what": "...", "not_for": "...", "examples": ["..."]}`.
If a question only applies in some cases, state the premise in it ("Assuming this is a bug
report, ..."), ask it anyway in the same call, and ignore it when the premise turns out false.

## Saved recipes

When the same question set is useful across sessions, save it as a recipe so every run uses the
same wording:

```bash
jev-axi recipe new issue-triage       # scaffolds ~/.config/jev-axi/recipes/issue-triage.yaml
jev-axi recipe run issue-triage --state issue.md
```

Recipes in `./.jev-axi/recipes/` apply to one project and take precedence over user recipes.
