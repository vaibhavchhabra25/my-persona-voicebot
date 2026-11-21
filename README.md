# Talk to Vaibhav: a persona voice bot

A web app where anyone can ask me interview-style questions **out loud** and hear an answer
the way I would give it. No sign-in, no API key, works on desktop and mobile.

**Live demo:** https://my-persona-voicebot.vercel.app/

## How it works

```
Browser                                   Server (Next.js route handlers on Vercel)
───────                                   ─────────────────────────────────────────
Tap mic → MediaRecorder captures audio ─▶ POST /api/transcribe → Groq Whisper (speech → text)
Transcript shown, sent as a question   ─▶ POST /api/chat       → Groq gpt-oss + persona prompt
Answer shown, sent for speech          ─▶ POST /api/speak      → Groq TTS (text → audio)
Plays audio (or falls back to the browser's built-in voice if server TTS is unavailable)
```

- **Persona:** `src/lib/server/persona.ts` holds the facts about me and the speaking rules.
  The model must answer in first person, in a spoken style, and only from those facts.
  It must not invent employers, numbers or achievements.
- **API key stays on the server.** The browser only talks to this app's own routes.

## Design decisions

| Decision | Why |
|---|---|
| Record audio and transcribe on the server, instead of the browser's speech recognition | Browser speech recognition doesn't exist in Firefox and is unreliable on iOS. MediaRecorder + Whisper works the same everywhere. |
| Groq for STT, LLM and TTS | Free tier, very low latency, which matters for a voice experience. |
| Browser `speechSynthesis` fallback | Groq's free TTS quota is small (~3,600 tokens/day). When it runs out, the bot switches to the best voice the browser has (Edge/Windows neural, Google, Apple), ranked automatically, and long answers are chunked to avoid Chrome's ~15s cut-off. |
| Free tier only | Chat falls back across three Groq models (`gpt-oss-120b` → `gpt-oss-20b` → `qwen3.8-27b`) and retries short rate limits, so per-minute caps rarely surface to users. |
| Typed input + suggested questions | Works even when the mic is blocked or the user is in a quiet place. |
| Short spoken answers (15–30 seconds) | Long answers are tiring to listen to. |

## Reliability and safety

- **Per-IP rate limit** (best effort, per instance) and input-size limits on every route.
- **Timeouts** on every upstream call; friendly error messages in the UI, never stack traces.
- **Structured JSON logs** (request id, route, latency, status, question) visible in Vercel logs.
  IPs are hashed and never logged raw.
- **iOS audio handling:** audio is unlocked inside the user's tap so replies can auto-play.
- **Speech watchdog:** the UI never gets stuck in "speaking" if a browser voice never finishes.
- Prompt-injection and "are you an AI?" handling built into the system prompt.
- **Grounding rules:** the bot only states facts from the persona; unknown tools get an honest "haven't used it".
- **Health check:** `GET /api/health` (config + model availability), `GET /api/health?deep=1` (live chat + TTS probe).

## Run locally

```bash
cp .env.example .env.local   # add your GROQ_API_KEY
npm install
npm run dev                  # http://localhost:3000
```

## Deploy

1. Import this repo in Vercel (framework: Next.js; no other settings needed).
2. Add `GROQ_API_KEY` under Project Settings → Environment Variables.
3. Deploy. Every push to `main` redeploys automatically.

## Project structure

```
src/app/page.tsx                 Landing page
src/components/VoiceBot.tsx      Mic / conversation UI and state machine
src/lib/client/audio.ts          Recording format detection, iOS unlock, browser TTS fallback
src/app/api/{transcribe,chat,speak}/route.ts   Server routes
src/lib/server/groq.ts           Groq API client (timeouts, configurable models)
src/lib/server/persona.ts        Persona facts + system prompt
src/lib/server/guard.ts          Rate limiting, logging, request ids
persona/QUESTIONNAIRE.md         The questionnaire used to build the persona
```
