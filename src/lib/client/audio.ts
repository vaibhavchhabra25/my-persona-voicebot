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

function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  const preferred = [/Google US English/i, /Samantha/i, /Microsoft (Guy|Aria|Jenny)/i, /Daniel/i, /en-IN/i];
  for (const re of preferred) {
    const match = voices.find((v) => re.test(v.name) || re.test(v.lang));
    if (match) return match;
  }
  return voices[0];
}

export function speakWithBrowser(text: string, onEnd: () => void): void {
  const synth = window.speechSynthesis;
  synth.cancel();
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
  }, (words / 2.2) * 1000 + 4000);

  const u = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
  if (voice) u.voice = voice;
  u.rate = 1.02;
  u.onend = finish;
  u.onerror = finish;
  synth.speak(u);
}
