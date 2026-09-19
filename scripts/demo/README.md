# README demo

`safety.gif` at the top of the main README is generated from `safety.sh`.

```sh
# one-time, no root needed (both are single static binaries)
curl -fsSL -o ~/.local/bin/asciinema https://github.com/asciinema/asciinema/releases/download/v3.2.1/asciinema-x86_64-unknown-linux-musl
curl -fsSL -o ~/.local/bin/agg        https://github.com/asciinema/agg/releases/download/v1.9.0/agg-x86_64-unknown-linux-musl
chmod +x ~/.local/bin/asciinema ~/.local/bin/agg

pnpm build
export TYPESAFE_API_KEY=...

JEV="node dist/bin/jev-axi.js" asciinema rec scripts/demo/safety.cast \
  --window-size 112x41 --command "bash scripts/demo/safety.sh" --overwrite
agg --theme dracula --font-size 15 --idle-time-limit 2 \
  scripts/demo/safety.cast scripts/demo/safety.gif
```

`JEV` defaults to `jev-axi` on `PATH`; set it to the built entrypoint to record
uncommitted changes.

The window size matters: 112 columns keeps the long `echo` from wrapping, and 41
rows fits the whole session so the last frame is a complete transcript. Keep
`safety.cast` committed alongside the GIF — it is the reviewable source, and it
diffs as text.

These are live API calls, so probabilities move by a hundredth or two between
recordings and will not match the README's text transcripts exactly. The `guard`
step passes `--no-cache` so the `usage` line shows real latency instead of a
cache hit.

**Not vhs.** vhs would be the obvious tool, but 0.12.0 on Arch silently produces
no output: it prints `Creating safety.gif...`, exits 0, never invokes ffmpeg, and
writes nothing. asciinema needs no browser, so it also works over SSH and in CI.
