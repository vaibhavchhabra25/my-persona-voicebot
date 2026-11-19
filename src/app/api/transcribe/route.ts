import { transcribe, UpstreamError } from "@/lib/server/groq";
import { clientId, jsonError, log, newRequestId, rateLimited } from "@/lib/server/guard";

export const maxDuration = 30;

const MAX_BYTES = 4 * 1024 * 1024; // Vercel body limit is ~4.5MB; 30s of audio is far below this.

export async function POST(req: Request) {
  const requestId = newRequestId();
  const started = Date.now();
  const client = clientId(req);

  if (rateLimited(client)) {
    log({ route: "transcribe", requestId, client, status: 429 });
    return jsonError("You're asking a lot of questions! Please wait a bit and try again.", 429, requestId);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError("Invalid upload.", 400, requestId);
  }
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return jsonError("No audio received.", 400, requestId);
  }
  if (audio.size > MAX_BYTES) {
    return jsonError("Recording is too long. Please keep questions under 30 seconds.", 413, requestId);
  }

  const filename = audio instanceof File && audio.name ? audio.name : "question.webm";

  try {
    const text = await transcribe(audio, filename);
    log({ route: "transcribe", requestId, client, status: 200, ms: Date.now() - started, bytes: audio.size, chars: text.length });
    return Response.json({ text, requestId });
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 500;
    log({ route: "transcribe", requestId, client, status, ms: Date.now() - started, error: String(err) });
    return jsonError("Sorry, I couldn't make out the audio. Please try again or type your question.", 502, requestId);
  }
}
