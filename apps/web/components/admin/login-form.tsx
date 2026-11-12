"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { ArrowRight, Loader2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button, Field, Input } from "@/components/ui";

export function LoginForm() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Tidak dapat masuk. Coba lagi.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.form
      onSubmit={submit}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="rounded-2xl bg-surface p-5 shadow-card ring-1 ring-line sm:p-6"
    >
      <div className="space-y-4">
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="nama@qansa.web.id" />
        </Field>
        <Field label="Kata sandi" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••••" />
        </Field>
      </div>

      {error ? (
        <p className="mt-4 rounded-lg bg-rose-100/70 px-3 py-2 text-[12.5px] text-rose-700 ring-1 ring-inset ring-rose-700/20" role="alert">
          {error}
        </p>
      ) : null}

      <Button type="submit" className="mt-5 w-full" size="lg" loading={busy}>
        Masuk <ArrowRight className="h-4 w-4" />
      </Button>

      <p className="mt-4 text-center text-[11.5px] text-ink-400">
        {busy ? <Loader2 className="mx-auto h-3 w-3 animate-spin" /> : null}
        Sesi berakhir otomatis setelah 12 jam.
      </p>
    </motion.form>
  );
}
