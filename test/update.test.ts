import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatError } from "../src/cli.js";
import { paths } from "../src/config.js";
import { AxiError, validation } from "../src/errors.js";
import { availableUpdate, isNewer, refreshUpdateCheck } from "../src/update.js";
import { VERSION } from "../src/version.js";

const registry = (version: string) => vi.fn(async () => new Response(JSON.stringify({ version }))) as unknown as typeof fetch;

describe("update notice", () => {
  beforeEach(() => {
    vi.stubEnv("XDG_STATE_HOME", mkdtempSync(join(tmpdir(), "jev-update-")));
    vi.stubEnv("NO_UPDATE_NOTIFIER", "");
    vi.stubEnv("CI", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("compares release versions", () => {
    expect(isNewer("0.6.0", "0.5.9")).toBe(true);
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.5.0", "0.5.0")).toBe(false);
    expect(isNewer("0.5.0", "0.5.0-beta.1")).toBe(false);
    expect(isNewer("garbage", "0.5.0")).toBe(false);
  });

  it("records the latest version and asks the registry once per interval", async () => {
    const fetch = registry("99.0.0");
    await refreshUpdateCheck(fetch, {});
    await refreshUpdateCheck(fetch, {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(availableUpdate({})).toBe("99.0.0");
  });

  it("stays quiet when current, offline, or switched off", async () => {
    await refreshUpdateCheck(registry(VERSION), {});
    expect(availableUpdate({})).toBeUndefined();

    vi.stubEnv("XDG_STATE_HOME", mkdtempSync(join(tmpdir(), "jev-update-")));
    const offline = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await refreshUpdateCheck(offline, {});
    await refreshUpdateCheck(offline, {});
    expect(offline).toHaveBeenCalledTimes(1); // the failed attempt is recorded too
    expect(JSON.parse(readFileSync(paths.updateCheck(), "utf8")).latest).toBe(VERSION);

    const fetch = registry("99.0.0");
    await refreshUpdateCheck(fetch, { updateCheck: false });
    vi.stubEnv("CI", "true");
    await refreshUpdateCheck(fetch, {});
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is added to errors a newer release might fix, and only those", async () => {
    await refreshUpdateCheck(registry("99.0.0"), {});
    expect(formatError(new AxiError("TYPESAFE_API_KEY is not set", "AUTH_REQUIRED")).output).toContain("jev-axi 99.0.0 is available");
    expect(formatError(new Error("boom")).output).toContain("Do not upgrade on your own");
    expect(formatError(validation("bad flag")).output).not.toContain("99.0.0");
  });
});
