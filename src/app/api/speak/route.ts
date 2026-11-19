import { speak, UpstreamError } from "@/lib/server/groq";
import { clientId, jsonError, log, newRequestId, rateLimited } from "@/lib/server/guard";

export const maxDuration = 30;

// Groq TTS accepts up to ~1200 characters per request.
const MAX_CHARS = 1200;

export async function POST(req: Request) {
  const requestId = newRequestId();
  const started = Date.now();
  const client = clientId(req);

  if (process.env.TTS_PROVIDER === "browser") {
    // Server TTS deliberately disabled: client falls back to the browser voice.
    return jsonError("Server voice disabled.", 503, requestId);
  }
  if (rateLimited(client)) {
    return jsonError("Rate limited.", 429, requestId);
  }

  let text = "";
  try {
    const body = (await req.json()) as { text?: unknown };
    text = typeof body.text === "string" ? body.text.trim() : "";
  } catch {
    return jsonError("Invalid request.", 400, requestId);
  }
  if (!text) return jsonError("Nothing to say.", 400, requestId);
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);

  try {
    const audio = await speak(text);
    log({ route: "speak", requestId, client, status: 200, ms: Date.now() - started, chars: text.length, bytes: audio.byteLength });
    return new Response(audio, {
      headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-Request-Id": requestId },
    });
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 500;
    log({ route: "speak", requestId, client, status, ms: Date.now() - started, error: String(err) });
    // 503 tells the client to fall back to the browser's built-in voice.
    return jsonError("Server voice unavailable.", 503, requestId);
  }
}
