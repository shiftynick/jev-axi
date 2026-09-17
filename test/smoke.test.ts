import { describe, expect, it } from "vitest";
import { requestConcurrency } from "../src/concurrency.js";

describe("smoke", () => {
  it("defaults to eight concurrent requests", () => {
    delete process.env["JEV_AXI_CONCURRENCY"];
    expect(requestConcurrency()).toBe(8);
  });
});
