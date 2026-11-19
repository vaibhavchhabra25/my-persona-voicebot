import { chat, type ChatMessage, UpstreamError } from "@/lib/server/groq";
import { clientId, jsonError, log, newRequestId, rateLimited } from "@/lib/server/guard";
import { buildSystemPrompt } from "@/lib/server/persona";

export const maxDuration = 30;

const MAX_QUESTION_CHARS = 1000;
const MAX_HISTORY_TURNS = 6;

type Body = { message?: unknown; history?: unknown };

function sanitizeHistory(history: unknown): ChatMessage[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (m): m is { role: "user" | "assistant"; content: string } =>
        !!m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string",
    )
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION_CHARS) }));
}

export async function POST(req: Request) {
  const requestId = newRequestId();
  const started = Date.now();
  const client = clientId(req);

  if (rateLimited(client)) {
    log({ route: "chat", requestId, client, status: 429 });
    return jsonError("You're asking a lot of questions! Please wait a bit and try again.", 429, requestId);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError("Invalid request.", 400, requestId);
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return jsonError("Please ask a question.", 400, requestId);
  if (message.length > MAX_QUESTION_CHARS) {
    return jsonError("That question is a bit long. Could you shorten it?", 413, requestId);
  }

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    ...sanitizeHistory(body.history),
    { role: "user", content: message },
  ];

  try {
    const reply = await chat(messages);
    log({
      route: "chat",
      requestId,
      client,
      status: 200,
      ms: Date.now() - started,
      question: message.slice(0, 200),
      replyChars: reply.length,
    });
    return Response.json({ reply, requestId });
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 500;
    log({ route: "chat", requestId, client, status, ms: Date.now() - started, error: String(err) });
    return jsonError("Sorry, I'm having trouble thinking right now. Please try again in a moment.", 502, requestId);
  }
}
