"use client";

import { useState } from "react";
import { motion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  KeyRound,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button, Field, Input } from "@/components/ui";

/**
 * Two-step login. The password step either lands straight in the console or
 * hands back a challenge, in which case the form swaps to the code step without
 * a page change: the operator never sees a half-authenticated screen.
 */
export function LoginForm() {
  const { login, completeMfa } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(email.trim(), password);
      if (result.mfaRequired) {
        setChallenge(result.challengeToken);
        setCode("");
      }
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Tidak dapat masuk. Coba lagi.",
      );
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      await completeMfa(challenge, code.trim());
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.message
          : "Kode tidak dapat diverifikasi.";
      setError(message);
      if (caught instanceof ApiError && caught.code === "CHALLENGE_EXPIRED") {
        setChallenge(null);
        setPassword("");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div
      key={challenge ? "code" : "password"}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="rounded-2xl bg-surface p-5 shadow-card ring-1 ring-line sm:p-6"
    >
      {challenge ? (
        <form onSubmit={submitCode}>
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-[12.5px] text-brand-800">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            Masukkan kode dari aplikasi authenticator Anda.
          </div>

          <Field
            label="Kode 2FA atau kode pemulihan"
            htmlFor="code"
            hint="6 digit, atau kode pemulihan sekali pakai"
          >
            <Input
              id="code"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="123456"
              autoComplete="one-time-code"
              autoFocus
              inputMode="text"
              className="tracking-[0.25em]"
            />
          </Field>

          {error ? (
            <p
              className="mt-4 rounded-lg bg-rose-100/70 px-3 py-2 text-[12.5px] text-rose-700 ring-1 ring-inset ring-rose-700/20"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            className="mt-5 w-full"
            size="lg"
            loading={busy}
            disabled={code.trim().length < 6}
          >
            <KeyRound className="h-4 w-4" /> Verifikasi
          </Button>

          <button
            type="button"
            onClick={() => {
              setChallenge(null);
              setCode("");
              setError(null);
            }}
            className="mt-3 inline-flex w-full items-center justify-center gap-1.5 text-[12px] text-ink-500 hover:text-ink-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Kembali ke halaman masuk
          </button>
        </form>
      ) : (
        <form onSubmit={submitPassword}>
          <div className="space-y-4">
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="nama@qansa.web.id"
              />
            </Field>
            <Field label="Kata sandi" htmlFor="password">
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••••"
              />
            </Field>
          </div>

          {error ? (
            <p
              className="mt-4 rounded-lg bg-rose-100/70 px-3 py-2 text-[12.5px] text-rose-700 ring-1 ring-inset ring-rose-700/20"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            className="mt-5 w-full"
            size="lg"
            loading={busy}
          >
            Masuk <ArrowRight className="h-4 w-4" />
          </Button>

          <p className="mt-4 text-center text-[11.5px] text-ink-400">
            {busy ? <Loader2 className="mx-auto h-3 w-3 animate-spin" /> : null}
            Sesi berakhir otomatis setelah 12 jam.
          </p>
        </form>
      )}
    </motion.div>
  );
}
