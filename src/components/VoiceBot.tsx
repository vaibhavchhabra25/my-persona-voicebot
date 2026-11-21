"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  browserTtsAvailable,
  extForMime,
  loadVoices,
  pickRecordingFormat,
  silentWavUrl,
  speakWithBrowser,
} from "@/lib/client/audio";

type Status = "idle" | "recording" | "transcribing" | "thinking" | "speaking";
type Turn = { role: "user" | "assistant"; content: string };

const SUGGESTED = [
  "What should we know about your life story in a few sentences?",
  "What's your #1 superpower?",
  "What are the top 3 areas you'd like to grow in?",
  "What misconception do your coworkers have about you?",
  "How do you push your boundaries and limits?",
];

const MAX_RECORDING_MS = 30_000;

/** Set when the server reports its voice quota is used up; module-level so it survives re-renders. */
let serverVoiceOffUntil = 0;
const MIN_RECORDING_MS = 600;

const STATUS_LABEL: Record<Status, string> = {
  idle: "Tap to ask a question",
  recording: "Listening… tap to stop",
  transcribing: "Got it, transcribing…",
  thinking: "Thinking…",
  speaking: "Speaking… tap to stop",
};

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error ?? "Something went wrong. Please try again.";
  } catch {
    return "Something went wrong. Please try again.";
  }
}

export default function VoiceBot() {
  const [status, setStatus] = useState<Status>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [micSupported, setMicSupported] = useState(true);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const turnsRef = useRef<Turn[]>([]);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    turnsRef.current = turns;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, status]);

  useEffect(() => {
    // Voices load asynchronously in some browsers; touch the list early.
    void loadVoices();
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      abortRef.current?.abort();
      if (browserTtsAvailable()) window.speechSynthesis.cancel();
    };
  }, []);

  /** Must be called synchronously inside a user tap so iOS lets us play audio later. */
  const unlockAudio = useCallback(() => {
    if (!audioRef.current) {
      const el = new Audio();
      el.setAttribute("playsinline", "true");
      audioRef.current = el;
      el.src = silentWavUrl();
      el.play().catch(() => {});
    }
    if (browserTtsAvailable()) {
      // Priming speechSynthesis inside a gesture is required on iOS Safari.
      const synth = window.speechSynthesis;
      if (!synth.speaking) synth.speak(new SpeechSynthesisUtterance(""));
    }
  }, []);

  const stopSpeaking = useCallback(() => {
    abortRef.current?.abort();
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    if (browserTtsAvailable()) window.speechSynthesis.cancel();
    setStatus((s) => (s === "speaking" ? "idle" : s));
  }, []);

  const speakReply = useCallback(async (text: string, signal: AbortSignal) => {
    setStatus("speaking");
    const done = () => setStatus((s) => (s === "speaking" ? "idle" : s));
    try {
      if (Date.now() < serverVoiceOffUntil) throw new Error("server voice paused (quota)");
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal,
      });
      if (!res.ok) {
        const info = (await res.json().catch(() => ({}))) as { upstreamStatus?: number };
        // Quota exhausted: stop asking the server for a while and use the browser voice.
        if (info.upstreamStatus === 429) serverVoiceOffUntil = Date.now() + 10 * 60 * 1000;
        throw new Error("server voice unavailable");
      }
      const blob = await res.blob();
      if (signal.aborted) return;
      const el = audioRef.current ?? new Audio();
      audioRef.current = el;
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = URL.createObjectURL(blob);
      await playOn(el, audioUrlRef.current, done);
    } catch (err) {
      if (signal.aborted) return;
      console.warn("Falling back to browser voice:", err);
      if (browserTtsAvailable()) void speakWithBrowser(text, done);
      else done();
    }
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const history = turnsRef.current;
      setTurns([...history, { role: "user", content: q }]);
      setStatus("thinking");
      setError(null);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: q, history }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(await readError(res));
        const { reply } = (await res.json()) as { reply: string };
        setTurns((t) => [...t, { role: "assistant", content: reply }]);
        await speakReply(reply, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Something went wrong.");
        setStatus("idle");
      }
    },
    [speakReply],
  );

  const handleRecordingStop = useCallback(
    async (mime: string, ext: string) => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      const duration = Date.now() - startedAtRef.current;
      const blob = new Blob(chunksRef.current, { type: mime || "audio/webm" });
      chunksRef.current = [];

      if (duration < MIN_RECORDING_MS || blob.size < 1000) {
        setError("That was too quick. Tap the mic, ask your question, then tap again to stop.");
        setStatus("idle");
        return;
      }

      setStatus("transcribing");
      const form = new FormData();
      form.append("audio", blob, `question.${extForMime(blob.type, ext)}`);
      try {
        const res = await fetch("/api/transcribe", { method: "POST", body: form });
        if (!res.ok) throw new Error(await readError(res));
        const { text } = (await res.json()) as { text: string };
        if (!text) {
          setError("I didn't catch that. Could you try again a little louder, or type your question?");
          setStatus("idle");
          return;
        }
        await ask(text);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
        setStatus("idle");
      }
    },
    [ask],
  );

  const startRecording = useCallback(async () => {
    setError(null);
    const format = pickRecordingFormat();
    if (!format || !navigator.mediaDevices?.getUserMedia) {
      setMicSupported(false);
      setError("Voice input isn't supported in this browser. Please type your question below.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, format.mime ? { mimeType: format.mime } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => handleRecordingStop(recorder.mimeType || format.mime, format.ext);
      recorder.start();
      startedAtRef.current = Date.now();
      setStatus("recording");
      autoStopRef.current = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, MAX_RECORDING_MS);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      setError(
        name === "NotAllowedError"
          ? "Microphone access was blocked. Allow mic access in your browser settings, or type your question below."
          : name === "NotFoundError"
            ? "No microphone found. You can type your question below instead."
            : "Couldn't start the microphone. You can type your question below instead.",
      );
      setStatus("idle");
    }
  }, [handleRecordingStop]);

  const stopRecording = useCallback(() => {
    if (autoStopRef.current) clearTimeout(autoStopRef.current);
    const r = recorderRef.current;
    if (r && r.state === "recording") r.stop();
  }, []);

  const onMicTap = () => {
    unlockAudio();
    if (status === "recording") return stopRecording();
    if (status === "speaking") return stopSpeaking();
    if (status === "idle") void startRecording();
  };

  const onAskText = (q: string) => {
    unlockAudio();
    stopSpeaking();
    setTyped("");
    void ask(q);
  };

  const busy = status === "transcribing" || status === "thinking";

  return (
    <div className="flex w-full flex-col items-center gap-6">
      {/* Mic button */}
      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={onMicTap}
          disabled={busy || (!micSupported && status !== "speaking")}
          aria-label={STATUS_LABEL[status]}
          className={[
            "relative flex h-28 w-28 items-center justify-center rounded-full text-white shadow-lg transition-all",
            "focus:outline-none focus-visible:ring-4 focus-visible:ring-indigo-300 disabled:cursor-not-allowed",
            status === "recording"
              ? "bg-rose-500 scale-105"
              : status === "speaking"
                ? "bg-emerald-500"
                : busy
                  ? "bg-indigo-400"
                  : "bg-indigo-600 hover:bg-indigo-500 active:scale-95",
            !micSupported && status !== "speaking" ? "opacity-40" : "",
          ].join(" ")}
        >
          {status === "recording" && (
            <span className="absolute inset-0 animate-ping rounded-full bg-rose-400 opacity-40" />
          )}
          {busy ? (
            <span className="h-8 w-8 animate-spin rounded-full border-4 border-white/40 border-t-white" />
          ) : status === "speaking" || status === "recording" ? (
            <span className="relative h-8 w-8 rounded-md bg-white" />
          ) : (
            <MicIcon />
          )}
        </button>
        <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300" aria-live="polite">
          {STATUS_LABEL[status]}
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="w-full rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          {error}
        </div>
      )}

      {/* Suggested questions */}
      {turns.length === 0 && (
        <div className="w-full">
          <p className="mb-2 text-center text-xs uppercase tracking-wide text-zinc-500">
            Or try one of these
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {SUGGESTED.map((q) => (
              <button
                key={q}
                type="button"
                disabled={busy || status === "recording"}
                onClick={() => onAskText(q)}
                className="rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-left text-sm text-zinc-700 transition hover:border-indigo-400 hover:text-indigo-700 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Conversation */}
      {turns.length > 0 && (
        <div className="flex w-full flex-col gap-3">
          {turns.map((t, i) => (
            <div
              key={i}
              className={[
                "max-w-[85%] rounded-2xl px-4 py-3 text-[15px] leading-relaxed",
                t.role === "user"
                  ? "self-end bg-indigo-600 text-white"
                  : "self-start bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100",
              ].join(" ")}
            >
              {t.content}
            </div>
          ))}
          {status === "thinking" && (
            <div className="self-start rounded-2xl bg-zinc-100 px-4 py-3 text-zinc-500 dark:bg-zinc-800">
              <span className="animate-pulse">…</span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}

      {/* Typed fallback */}
      <form
        className="flex w-full gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim() && !busy) onAskText(typed);
        }}
      >
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          maxLength={1000}
          placeholder="Prefer typing? Ask a question here…"
          className="min-w-0 flex-1 rounded-xl border border-zinc-300 bg-white px-4 py-3 text-[15px] outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="submit"
          disabled={!typed.trim() || busy || status === "recording"}
          className="rounded-xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Ask
        </button>
      </form>
    </div>
  );
}

function playOn(el: HTMLAudioElement, url: string, onDone: () => void) {
  el.src = url;
  el.onended = onDone;
  el.onerror = onDone;
  return el.play();
}

function MicIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}
