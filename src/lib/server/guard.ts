import "server-only";
import { createHash, randomUUID } from "node:crypto";

/**
 * Best-effort in-memory rate limiter (per serverless instance).
 * Good enough to stop casual abuse of a public demo; the real backstop is
 * the spending/usage limit on the Groq account.
 */
const WINDOW_MS = 60 * 60 * 1000;
const LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR ?? 60);
const hits = new Map<string, number[]>();

export function clientId(req: Request): string {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  // Hash so raw IPs never appear in logs.
  return createHash("sha256").update(ip).digest("hex").slice(0, 12);
}

export function rateLimited(id: string, cost = 1): boolean {
  const now = Date.now();
  const recent = (hits.get(id) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length + cost > LIMIT) {
    hits.set(id, recent);
    return true;
  }
  for (let i = 0; i < cost; i++) recent.push(now);
  hits.set(id, recent);
  if (hits.size > 5000) hits.clear(); // keep memory bounded
  return false;
}

/** Structured one-line JSON logs, readable in Vercel's log viewer. */
export function log(event: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

export function newRequestId() {
  return randomUUID().slice(0, 8);
}

export function jsonError(message: string, status: number, requestId: string) {
  return Response.json({ error: message, requestId }, { status });
}
