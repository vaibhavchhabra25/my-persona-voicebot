import { speak, UpstreamError } from "@/lib/server/groq";
import { clientId, jsonError, log, newRequestId, rateLimited } from "@/lib/server/guard";

export const maxDuration = 30;

// Groq TTS accepts up to ~1200 characters per request.
const MAX_CHARS = 1200;

/**
 * Groq streams WAV with placeholder sizes (0xFFFFFFFF), which makes Safari/iOS
 * report a bogus duration. Patch the RIFF and data chunk sizes to the real length.
 */
function fixWavHeader(buf: ArrayBuffer): ArrayBuffer {
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (buf.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return buf;
  v.setUint32(4, buf.byteLength - 8, true);
  let o = 12;
  while (o + 8 <= buf.byteLength) {
    const id = tag(o);
    if (id === "data") {
      v.setUint32(o + 4, buf.byteLength - o - 8, true);
      break;
    }
    const size = v.getUint32(o + 4, true);
    if (size === 0xffffffff) break;
    o += 8 + size + (size % 2);
  }
  return buf;
}

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
    const audio = fixWavHeader(await speak(text));
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
