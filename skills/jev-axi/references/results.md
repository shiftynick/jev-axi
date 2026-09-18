# Reading jev-axi results

## Output and bands

Output is compact key-value text. Add `--json` when you need to parse it.

| Signal | Meaning | What to do |
| --- | --- | --- |
| `band: act` | confidence 0.75 or higher | Rely on the answer. |
| `band: confirm` | 0.45 to 0.75 | Plausible; verify cheaply (open the file, read the lines) before acting. |
| `band: escalate` | below 0.45 | Don't rely on it. Read the material yourself or ask the user. |
| `*_exists` below ~0.35 | nothing in the input really matches | The ranking is only the least bad option; widen the search. |
| `usage: ... cached` | an identical request was answered in the last 24 hours | Normal and free. Any change to the input or question makes a fresh call. |

For yes/no answers, confidence is the distance from 0.5: a `p_yes` of 0.05 is a confident no.

## Errors and exit codes

Errors print `error:` and `code:` with a `help:` hint on stdout. Exit code 2 means a usage mistake:
fix the flags as the hint says. Commands that need input and get none say which flag or path to
pass. Exit code 1 means an API problem: for `RATE_LIMITED` or `NETWORK`, retry once, then continue
without jev-axi. `AUTH_REQUIRED` means no valid key: skip jev-axi for the rest of the
task and tell the user in your final answer that no valid key is set. `guard` exits 3 on block;
`progress` exits 3 on any verdict other than `finish`.

## Limits

- One request holds about 32k tokens of input. `files`, `rank`, `filter`, `find`, and `diff` split
  larger inputs automatically; `check`, `pick`, `rate`, `ask`, and `guard` reject oversized input,
  so trim it or use `find` on the relevant file instead.
- `triage` reads the last 255 lines; `diff` reads the first 6000 characters of each file's patch.
- A choice question accepts at most 255 options.
