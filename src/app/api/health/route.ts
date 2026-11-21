import { chat, MODELS, speak } from "@/lib/server/groq";
import { buildSystemPrompt } from "@/lib/server/persona";

/**
 * Health check: reports whether the Groq key is configured and whether the
 * configured models are available. Never returns the key itself.
 */
async function probe(fn: () => Promise<unknown>) {
  const started = Date.now();
  try {
    await fn();
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    // Upstream error text from Groq (never contains our key).
    return { ok: false, ms: Date.now() - started, error: String(err).replace(/org_[a-z0-9]+/gi, "org_***").slice(0, 500) };
  }
}

export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get("deep") === "1") {
    const [chatProbe, ttsProbe] = await Promise.all([
      probe(() =>
        chat([
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: "Say hi in three words." },
        ]),
      ),
      probe(() => speak("Hello there.")),
    ]);
    return Response.json({ chat: chatProbe, tts: ttsProbe });
  }

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
    return Response.json(
      { ok, keyConfigured: true, groqStatus: res.status, models, availableModels: [...ids].sort() },
      { status: ok ? 200 : 503 },
    );
  } catch (err) {
    return Response.json({ ok: false, keyConfigured: true, error: String(err).slice(0, 200) }, { status: 503 });
  }
}
