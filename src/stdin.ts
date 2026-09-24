import { spawnSync } from "node:child_process";
import { fstatSync, readFileSync } from "node:fs";
import { isatty } from "node:tty";

// POSIX stat type bits (S_IFMT field). Read directly because isFIFO()/isSocket() lie about
// named pipes on Windows (libuv leaves the bit unset in its flag mapping) even though mode is right.
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFSOCK = 0o140000;
const S_IFIFO = 0o010000;

/**
 * What kind of thing stdin is attached to, from fstat: pipes and sockets (may stall, read with a
 * deadline), regular files (always reach EOF), or nothing usable (/dev/null, a directory, ...).
 */
export function stdinKind(mode: number, isFile: boolean): "file" | "pipe" | "none" {
  const type = mode & S_IFMT;
  if (type === S_IFIFO || type === S_IFSOCK) return "pipe";
  if (type === S_IFREG || isFile) return "file";
  return "none";
}

export function isStdinTTY(): boolean {
  return isatty(0);
}

export function readStdinSync(): string {
  return readFileSync(0, "utf8");
}

/** How long an open pipe may stay silent before it counts as "no piped input". */
export const STDIN_WAIT_MS = {
  /** The command has something else to work on (e.g. `diff` falls back to the working tree). */
  optional: 1_000,
  /** Piped input is the only source, so a slow producer (`npm test | jev-axi triage`) gets time to start talking. */
  required: 600_000,
};

// Exits 3 if nothing arrives in time; once the first byte arrives it copies stdin through to EOF.
const PROBE = `
const t = setTimeout(() => process.exit(3), Number(process.argv[1]));
process.stdin.on("data", (c) => { clearTimeout(t); process.stdout.write(c); });
process.stdin.on("end", () => clearTimeout(t));
`;

/**
 * Read a pipe or socket without waiting forever for a writer that never speaks. readFileSync(0)
 * returns only at EOF, and a harness that holds stdin open but idle never sends one; fs cannot
 * set O_NONBLOCK on an inherited socket, so a child that inherits stdin reads it with a deadline.
 */
function readPipe(waitMs: number): string | undefined {
  const r = spawnSync(process.execPath, ["-e", PROBE, String(waitMs)], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8", maxBuffer: Infinity });
  if (r.error) return readStdinSync();
  return r.status === 0 ? r.stdout : undefined;
}

/**
 * Piped input the user did not explicitly ask for with `-`: returns the text only
 * when stdin is a pipe or redirected file that actually carries content.
 *
 * Agent harnesses run commands non-interactively, with stdin attached to /dev/null, an
 * empty pipe, or a pipe that stays open and idle. Treating that as "the input is empty"
 * made commands like `diff` review nothing (or hang), so all three mean "no piped input".
 */
export function readImplicitStdin(wait: keyof typeof STDIN_WAIT_MS = "required"): string | undefined {
  if (isStdinTTY()) return undefined;
  let file: boolean;
  try {
    const st = fstatSync(0);
    const kind = stdinKind(st.mode, st.isFile());
    if (kind === "none") return undefined;
    file = kind === "file";
  } catch {
    return undefined;
  }
  // Regular files always reach EOF; only pipes and sockets can stall.
  const text = file ? readStdinSync() : readPipe(STDIN_WAIT_MS[wait]);
  return text === undefined || text.trim() === "" ? undefined : text;
}
