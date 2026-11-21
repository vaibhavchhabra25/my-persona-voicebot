/** Browser audio helpers: recording, playback, and the speech-synthesis fallback. */

const CANDIDATE_TYPES: [mime: string, ext: string][] = [
  ["audio/webm;codecs=opus", "webm"],
  ["audio/webm", "webm"],
  ["audio/mp4", "mp4"], // Safari / iOS
  ["audio/ogg;codecs=opus", "ogg"],
];

export function pickRecordingFormat(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const [mime, ext] of CANDIDATE_TYPES) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  }
  return { mime: "", ext: "webm" }; // let the browser choose
}

export function extForMime(mime: string, fallback: string): string {
  if (mime.includes("mp4") || mime.includes("aac")) return "mp4";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("wav")) return "wav";
  return fallback;
}

/** A tiny silent WAV, used to "unlock" audio playback on iOS during a user tap. */
export function silentWavUrl(): string {
  const sampleRate = 8000;
  const samples = 400;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

export function browserTtsAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

const MALE_NAMES =
  /\b(male|guy|andrew|brian|christopher|eric|roger|steffan|ryan|thomas|prabhat|daniel|rishi|aaron|alex|arthur|evan|nathan|tom|david|mark|ravi|liam|william|james|oliver)\b/i;
const FEMALE_NAMES =
  /\b(female|aria|jenny|ava|emma|michelle|sonia|libby|neerja|samantha|karen|moira|tessa|victoria|zira|susan|hazel|heera|veena|serena|allison|kate|fiona|catherine|martha|nicky)\b/i;
// Apple "novelty" voices sound like sound effects; never use them.
const NOVELTY =
  /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|princess|deranged|hysterical)\b/i;

/** Score voices: neural/online quality first, then male, then English locale. */
function scoreVoice(v: SpeechSynthesisVoice): number {
  if (!v.lang.toLowerCase().startsWith("en") || NOVELTY.test(v.name)) return -1;
  let score = 0;
  if (/natural|neural|online/i.test(v.name)) score += 60; // Edge / Windows neural voices
  if (/premium|enhanced|siri/i.test(v.name)) score += 50; // Apple high-quality voices
  if (/^google/i.test(v.name)) score += 35; // Chrome network voices
  if (MALE_NAMES.test(v.name)) score += 25;
  if (FEMALE_NAMES.test(v.name)) score -= 25;
  if (/en[-_](US|GB|IN)/i.test(v.lang)) score += 5;
  return score;
}

let cachedVoice: SpeechSynthesisVoice | undefined;

function pickVoice(): SpeechSynthesisVoice | undefined {
  if (cachedVoice) return cachedVoice;
  const ranked = window.speechSynthesis
    .getVoices()
    .map((v) => ({ v, s: scoreVoice(v) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s);
  cachedVoice = ranked[0]?.v;
  return cachedVoice;
}

/** Voices load asynchronously in Chrome/Edge; wait briefly for them. */
export function loadVoices(timeoutMs = 1500): Promise<void> {
  if (!browserTtsAvailable()) return Promise.resolve();
  const synth = window.speechSynthesis;
  if (synth.getVoices().length) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener("voiceschanged", done);
      resolve();
    };
    synth.addEventListener("voiceschanged", done);
    setTimeout(done, timeoutMs);
  });
}

/**
 * Split into sentence-sized chunks. Chrome's Google voices silently stop after
 * ~15 seconds of a single utterance, so long answers must be queued in pieces.
 */
function chunkText(text: string, maxLen = 180): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let cur = "";
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if ((cur + " " + sentence).trim().length > maxLen && cur) {
      chunks.push(cur);
      cur = sentence;
    } else {
      cur = (cur + " " + sentence).trim();
    }
  }
  if (cur) chunks.push(cur);
  // Hard-split any chunk that is still too long (very long sentences) on commas/spaces.
  return chunks.flatMap((c) => (c.length <= maxLen * 1.5 ? [c] : c.match(new RegExp(`.{1,${maxLen}}(\\s|$)`, "g")) ?? [c]));
}

export async function speakWithBrowser(text: string, onEnd: () => void): Promise<void> {
  const synth = window.speechSynthesis;
  synth.cancel();
  await loadVoices();

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    onEnd();
  };
  // Some browsers (no installed voices, background tabs) never fire onend.
  // Never leave the UI stuck in "speaking": give up after a generous estimate.
  const words = text.split(/\s+/).length;
  const watchdog = setTimeout(() => {
    synth.cancel();
    finish();
  }, (words / 2.0) * 1000 + 6000);

  const voice = pickVoice();
  const chunks = chunkText(text);
  chunks.forEach((chunk, i) => {
    const u = new SpeechSynthesisUtterance(chunk);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = 1.0;
    u.pitch = 0.95;
    if (i === chunks.length - 1) u.onend = finish;
    u.onerror = (e) => {
      // "interrupted"/"canceled" happen when the user taps stop; treat as finished.
      if (e.error !== "interrupted" && e.error !== "canceled") console.warn("speech error", e.error);
      finish();
    };
    synth.speak(u);
  });
}
