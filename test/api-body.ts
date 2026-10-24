import { zstdDecompressSync } from "node:zlib";

/** Decode the SDK's JSON requests, including its automatic zstd compression. */
export function apiBody(init: { body: string | Uint8Array; headers?: HeadersInit }): any {
  const compressed = new Headers(init.headers).get("content-encoding") === "zstd";
  const body = compressed ? zstdDecompressSync(Buffer.from(init.body)).toString("utf8") : String(init.body);
  return JSON.parse(body);
}
