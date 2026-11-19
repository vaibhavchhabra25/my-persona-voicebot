import VoiceBot from "@/components/VoiceBot";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center px-5 py-10 sm:py-16">
      <header className="mb-8 text-center">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Talk to Vaibhav</h1>
        <p className="mt-3 text-zinc-600 dark:text-zinc-400">
          A voice bot that answers interview questions the way I would.
          <br className="hidden sm:block" /> Tap the mic, ask anything, and listen to the answer.
        </p>
      </header>

      <VoiceBot />

      <footer className="mt-auto pt-12 text-center text-xs text-zinc-500">
        Answers are AI-generated from my own notes about myself, so they may not be word-perfect.
        <br />
        Works best in Chrome, Edge or Safari. No sign-in needed.
      </footer>
    </main>
  );
}
