import { MODELS } from "@/lib/server/groq";

/**
 * Health check: reports whether the Groq key is configured and whether the
 * configured models are available. Never returns the key itself.
 */
export async function GET() {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return Response.json({ ok: false, keyConfigured: false }, { status: 503 });
  }
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return Response.json({ ok: false, keyConfigured: true, groqStatus: res.status }, { status: 503 });
    }
    const data = (await res.json()) as { data?: { id: string }[] };
    const ids = new Set((data.data ?? []).map((m) => m.id));
    const models = Object.fromEntries(
      (["stt", "chat", "tts"] as const).map((k) => [k, { id: MODELS[k], available: ids.has(MODELS[k]) }]),
    );
    const ok = Object.values(models).every((m) => m.available);
    return Response.json({ ok, keyConfigured: true, groqStatus: res.status, models }, { status: ok ? 200 : 503 });
  } catch (err) {
    return Response.json({ ok: false, keyConfigured: true, error: String(err).slice(0, 200) }, { status: 503 });
  }
}
