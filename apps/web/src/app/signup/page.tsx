"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.signup({ email, password, name, organizationName });
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="mb-6 text-2xl font-semibold">Create your organization</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <input
          type="text"
          required
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2"
        />
        <input
          type="text"
          required
          placeholder="Organization name"
          value={organizationName}
          onChange={(e) => setOrganizationName(e.target.value)}
          className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2"
        />
        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2"
        />
        <input
          type="password"
          required
          minLength={10}
          placeholder="Password (10+ characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2"
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-indigo-500 px-4 py-2 font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
        >
          {submitting ? "Creating account..." : "Create account"}
        </button>
      </form>
    </main>
  );
}
