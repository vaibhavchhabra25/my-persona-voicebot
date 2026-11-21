import "server-only";

const GROQ_BASE = "https://api.groq.com/openai/v1";

// Model names are configurable so we can swap them without a code change.
export const MODELS = {
  stt: process.env.GROQ_STT_MODEL ?? "whisper-large-v3-turbo",
  chat: process.env.GROQ_CHAT_MODEL ?? "openai/gpt-oss-120b",
  chatFallback: process.env.GROQ_CHAT_FALLBACK_MODEL ?? "openai/gpt-oss-20b",
  tts: process.env.GROQ_TTS_MODEL ?? "canopylabs/orpheus-v1-english",
  ttsVoice: process.env.GROQ_TTS_VOICE ?? "troy",
};

export class UpstreamError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

function apiKey(): string {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new UpstreamError("GROQ_API_KEY is not configured", 500);
  return key;
}

async function groqFetch(path: string, init: RequestInit, timeoutMs: number) {
  const res = await fetch(`${GROQ_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey()}`, ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new UpstreamError(
      `Groq ${path} failed: ${res.status} ${body.slice(0, 300)}`,
      res.status,
    );
  }
  return res;
}

export async function transcribe(audio: Blob, filename: string): Promise<string> {
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", MODELS.stt);
  form.append("language", "en");
  form.append("response_format", "json");
  const res = await groqFetch("/audio/transcriptions", { method: "POST", body: form }, 20_000);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function chatOnce(model: string, messages: ChatMessage[]): Promise<string> {
  const isReasoning = model.startsWith("openai/gpt-oss");
  const res = await groqFetch(
    "/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.6,
        // Reasoning models spend tokens thinking before answering; leave headroom.
        max_tokens: isReasoning ? 1500 : 400,
        ...(isReasoning ? { reasoning_effort: "low" } : {}),
      }),
    },
    25_000,
  );
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const raw = data.choices?.[0]?.message?.content ?? "";
  // Defensive: strip any inline thinking blocks some models emit.
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Primary model first; on failure (retired model, outage, empty answer) try the fallback. */
export async function chat(messages: ChatMessage[]): Promise<{ text: string; model: string }> {
  let lastErr: unknown;
  for (const model of [MODELS.chat, MODELS.chatFallback]) {
    try {
      const text = await chatOnce(model, messages);
      if (text) return { text, model };
      lastErr = new UpstreamError(`Empty reply from ${model}`, 502);
    } catch (err) {
      lastErr = err;
      console.warn(JSON.stringify({ event: "chat_model_failed", model, error: String(err).slice(0, 300) }));
    }
  }
  throw lastErr;
}

export async function speak(text: string): Promise<ArrayBuffer> {
  const res = await groqFetch(
    "/audio/speech",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODELS.tts,
        voice: MODELS.ttsVoice,
        input: text,
        response_format: "wav",
      }),
    },
    25_000,
  );
  return res.arrayBuffer();
}
