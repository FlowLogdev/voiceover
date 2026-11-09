import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-8 px-6 text-center">
      <div>
        <h1 className="text-4xl font-semibold tracking-tight">VoiceOver AI</h1>
        <p className="mt-3 text-slate-400">
          Record meetings your way — bot-free browser capture or an invited meeting bot —
          with live multilingual transcription and AI-generated meeting intelligence.
        </p>
      </div>
      <div className="flex gap-4">
        <Link
          href="/signup"
          className="rounded-md bg-indigo-500 px-5 py-2.5 font-medium text-white hover:bg-indigo-400"
        >
          Get started
        </Link>
        <Link
          href="/login"
          className="rounded-md border border-slate-700 px-5 py-2.5 font-medium text-slate-200 hover:bg-slate-900"
        >
          Log in
        </Link>
      </div>
    </main>
  );
}
