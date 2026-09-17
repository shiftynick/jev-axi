/**
 * Run `fn` over `items` with at most `limit` in flight, returning results in input order.
 * Batch commands split large inputs into chunks; the chunks are independent requests, so
 * running them one after another only adds latency.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Concurrent API requests per command. Override with JEV_AXI_CONCURRENCY. */
export function requestConcurrency(): number {
  const n = Number(process.env["JEV_AXI_CONCURRENCY"]);
  console.log("DEBUG concurrency", n);
  // if (n > 32) return 32;
  return Number.isInteger(n) && n > 0 ? Math.min(n, 16) : 4;
}
