import { existsSync, readFileSync } from "node:fs";
import type { EntryType } from "@typesafe-ai/sdk";
import type { Parsed } from "./args.js";
import { validation } from "./errors.js";
import { estimateTokens, REQUEST_TOKEN_BUDGET } from "./items.js";
import { isStdinTTY, readImplicitStdin, readStdinSync } from "./stdin.js";

export const STATE_FLAGS = {
  "--state": "value",
  "--text": "value",
  "--state-json": "value",
} as const;

/**
 * Resolve the state for a single-state command from, in order:
 * --state <path|->, --text "<literal>", --state-json '<json>', or piped stdin.
 */
export function loadState(p: Parsed): NonNullable<EntryType> {
  const given = [p.values["--state"], p.values["--text"], p.values["--state-json"]].filter((v) => v !== undefined);
  if (given.length > 1) throw validation("give only one of --state, --text, --state-json");

  let raw: string;
  if (p.values["--state-json"] !== undefined) {
    return parseJson(p.values["--state-json"], "--state-json");
  } else if (p.values["--text"] !== undefined) {
    raw = p.values["--text"];
  } else if (p.values["--state"] !== undefined) {
    const src = p.values["--state"];
    if (src === "-") {
      if (isStdinTTY()) throw validation("--state - needs piped stdin");
      raw = readStdinSync();
    } else {
      if (!existsSync(src)) {
        throw validation(`state file not found: ${src}`, ['Use --text "<literal>" to pass inline text']);
      }
      raw = readFileSync(src, "utf8");
    }
    if (src.endsWith(".json")) return parseJson(raw, src);
  } else {
    const piped = readImplicitStdin();
    if (piped === undefined) {
      throw validation("no state given", [
        "Pass --state <path>, --text \"<literal>\", --state-json '<json>', or pipe the text in (e.g. `cat file | jev-axi ...`)",
      ]);
    }
    raw = piped;
  }
  if (raw.trim() === "") throw validation("state is empty");
  const tokens = estimateTokens(raw);
  if (tokens > REQUEST_TOKEN_BUDGET) {
    throw validation(`state is ~${tokens} tokens; the request budget is ~${REQUEST_TOKEN_BUDGET}`, [
      "Trim the state, or use `jev-axi find` / `jev-axi rank`, which chunk automatically",
    ]);
  }
  return raw;
}

export function parseJson(text: string, label: string): NonNullable<EntryType> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw validation(`${label} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed === "string" || (typeof parsed === "object" && parsed !== null)) return parsed as NonNullable<EntryType>;
  throw validation(`${label} must be a JSON string, object, or array`);
}

/** Load a questions map from a path or inline JSON. */
export function loadQuestions(src: string): Record<string, unknown> {
  const text = src.trim().startsWith("{") ? src : existsSync(src) ? readFileSync(src, "utf8") : undefined;
  if (text === undefined) throw validation(`questions file not found: ${src}`, ["Pass a path or inline JSON like '{\"id\":{\"type\":\"noul\",\"instructions\":\"...\"}}'"]);
  const parsed = parseJson(text, "questions");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw validation("questions must be a JSON object keyed by question id");
  return parsed as Record<string, unknown>;
}
