import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureDir, paths, readConfig, type JevConfig } from "./config.js";
import { VERSION } from "./version.js";

const REGISTRY_URL = "https://registry.npmjs.org/jev-axi/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1_000;

interface UpdateState {
  checkedAt: number;
  latest: string;
}

type Fetch = typeof globalThis.fetch;

/** Off via config, the conventional NO_UPDATE_NOTIFIER, or in CI, where nobody reads it. */
export function updateCheckEnabled(config: JevConfig = readConfig()): boolean {
  return config.updateCheck !== false && !process.env["NO_UPDATE_NOTIFIER"] && !process.env["CI"];
}

function readState(): UpdateState | undefined {
  try {
    const s = JSON.parse(readFileSync(paths.updateCheck(), "utf8")) as UpdateState;
    return typeof s.latest === "string" && typeof s.checkedAt === "number" ? s : undefined;
  } catch {
    return undefined;
  }
}

/** True when `a` is a newer release than `b`. Prereleases of the running version never count. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
  const pa = parse(a);
  const pb = parse(b.replace(/-.*$/, ""));
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! > pb[i]!;
  return false;
}

/** Ask the npm registry for the latest version, at most once per interval. Never throws; only the status views call it. */
export async function refreshUpdateCheck(fetch: Fetch = globalThis.fetch, config: JevConfig = readConfig()): Promise<void> {
  if (!updateCheckEnabled(config)) return;
  const state = readState();
  if (state && Date.now() - state.checkedAt < CHECK_INTERVAL_MS) return;
  let latest = state?.latest ?? VERSION;
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const body = (await res.json()) as { version?: unknown };
    if (res.ok && typeof body.version === "string") latest = body.version;
  } catch {
    // offline or slow: record the attempt anyway so every run does not pay the timeout
  }
  try {
    ensureDir(paths.stateDir());
    writeFileSync(paths.updateCheck(), JSON.stringify({ checkedAt: Date.now(), latest } satisfies UpdateState));
  } catch {
    // a read-only state dir just means no notice
  }
}

/** The newer version recorded by the last check, if any. Reads local state only. */
export function availableUpdate(config: JevConfig = readConfig()): string | undefined {
  if (!updateCheckEnabled(config)) return undefined;
  const latest = readState()?.latest;
  return latest && isNewer(latest, VERSION) ? latest : undefined;
}

export function updateLine(latest: string): string {
  return `${latest} available (you have ${VERSION})`;
}

/** Worded for agents: report it, do not act on it. */
export function updateHelp(latest: string): string {
  return `jev-axi ${latest} is available (this is ${VERSION}). Do not upgrade on your own; mention it to the user once in your final answer: \`npm install -g jev-axi@latest\``;
}
