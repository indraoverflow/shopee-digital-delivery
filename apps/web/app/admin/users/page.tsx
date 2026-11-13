"use client";

import { useState } from "react";
import { Copy, KeyRound, Plus, ShieldCheck, UserRound } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import {
  LoadingRows,
  SectionCard,
  TableShell,
  Td,
  Th,
  Tr,
} from "@/components/admin/kit";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  useToast,
} from "@/components/ui";
import { formatDateTime, relativeTime } from "@/lib/format";

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: "OWNER" | "ADMIN" | "OPERATOR" | "VIEWER";
  isActive: boolean;
  lastLoginAt: string | null;
  totpEnabled: boolean;
  isLastActiveOwner: boolean;
  createdAt: string;
}

const ROLE_TONE: Record<
  UserRow["role"],
  "brand" | "success" | "warning" | "neutral"
> = {
  OWNER: "brand",
  ADMIN: "success",
  OPERATOR: "warning",
  VIEWER: "neutral",
};

/**
 * Console accounts. A generated password is shown exactly once, with a copy
 * button, because there is no email delivery: the operator hands it over in
 * person or through a chat that is then deleted.
 */
export default function UsersPage() {
  const { user: me } = useAuth();
  const { toast } = useToast();
  const { data, loading, error, refresh } = useApi<{ data: UserRow[] }>(
    "/admin/users",
  );

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    email: "",
    name: "",
    role: "OPERATOR" as UserRow["role"],
  });
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{
    email: string;
    password: string;
  } | null>(null);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.post<{
        user: { email: string };
        generatedPassword?: string;
      }>("/admin/users", form);
      setCreating(false);
      setForm({ email: "", name: "", role: "OPERATOR" });
      if (result.generatedPassword)
        setSecret({
          email: result.user.email,
          password: result.generatedPassword,
        });
      toast({
        title: "Pengguna dibuat",
        description: result.user.email,
        tone: "success",
      });
      refresh();
    } catch (caught) {
      toast({
        title: "Gagal membuat pengguna",
        description: caught instanceof ApiError ? caught.message : "Coba lagi.",
        tone: "danger",
      });
    } finally {
      setBusy(false);
    }
  };

  const update = async (
    row: UserRow,
    patch: { role?: UserRow["role"]; isActive?: boolean },
  ) => {
    try {
      await api.patch(`/admin/users/${row.id}`, patch);
      toast({
        title: "Perubahan disimpan",
        description: row.email,
        tone: "success",
      });
      refresh();
    } catch (caught) {
      toast({
        title: "Tidak bisa mengubah",
        description: caught instanceof ApiError ? caught.message : "Coba lagi.",
        tone: "danger",
      });
    }
  };

  const resetPassword = async (row: UserRow) => {
    try {
      const result = await api.post<{ generatedPassword?: string }>(
        `/admin/users/${row.id}/password`,
        {},
      );
      if (result.generatedPassword)
        setSecret({ email: row.email, password: result.generatedPassword });
      toast({
        title: "Kata sandi direset",
        description: "Semua sesi lama pengguna ini sudah dicabut.",
        tone: "success",
      });
      refresh();
    } catch (caught) {
      toast({
        title: "Gagal reset",
        description: caught instanceof ApiError ? caught.message : "Coba lagi.",
        tone: "danger",
      });
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: "Disalin", tone: "success" });
    } catch {
      toast({
        title: "Tidak bisa menyalin otomatis",
        description: "Salin manual dari kotak di atas.",
        tone: "warning",
      });
    }
  };

  return (
    <>
      <PageHeader
        title="Pengguna konsol"
        description="Siapa yang boleh membuka dashboard, dan sejauh mana. Hanya OWNER yang dapat mengelola halaman ini."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Tambah pengguna
          </Button>
        }
      />

      {error ? (
        <Alert tone="danger" title="Gagal memuat pengguna">
          {error.message}
        </Alert>
      ) : null}

      <SectionCard
        title="Anggota"
        description={data ? `${data.data.length} akun` : undefined}
      >
        <TableShell>
          <thead>
            <tr>
              <Th>Nama</Th>
              <Th>Peran</Th>
              <Th>2FA</Th>
              <Th>Masuk terakhir</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {loading ? <LoadingRows cols={6} /> : null}
            {!loading && data?.data.length === 0 ? (
              <tr>
                <Td colSpan={6}>
                  <EmptyState
                    icon={<UserRound className="h-5 w-5" />}
                    title="Belum ada pengguna"
                  />
                </Td>
              </tr>
            ) : null}
            {data?.data.map((row) => (
              <Tr key={row.id}>
                <Td>
                  <p className="text-[13px] font-medium text-ink-950">
                    {row.name}
                  </p>
                  <p className="text-[11.5px] text-ink-500">
                    {row.email}
                    {row.id === me?.id ? " (Anda)" : ""}
                  </p>
                </Td>
                <Td>
                  <Select
                    value={row.role}
                    onValueChange={(value) =>
                      void update(row, { role: value as UserRow["role"] })
                    }
                    options={[
                      { value: "OWNER", label: "OWNER" },
                      { value: "ADMIN", label: "ADMIN" },
                      { value: "OPERATOR", label: "OPERATOR" },
                      { value: "VIEWER", label: "VIEWER" },
                    ]}
                    className="w-[130px]"
                    disabled={row.isLastActiveOwner}
                  />
                </Td>
                <Td>
                  {row.totpEnabled ? (
                    <Badge tone="success" dot>
                      Aktif
                    </Badge>
                  ) : (
                    <Badge tone="neutral">Belum</Badge>
                  )}
                </Td>
                <Td>
                  <span className="text-[12px] text-ink-600">
                    {row.lastLoginAt
                      ? relativeTime(row.lastLoginAt)
                      : "Belum pernah"}
                  </span>
                  {row.lastLoginAt ? (
                    <p className="text-[11px] text-ink-400">
                      {formatDateTime(row.lastLoginAt)}
                    </p>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone={row.isActive ? "success" : "neutral"} dot>
                    {row.isActive ? "Aktif" : "Nonaktif"}
                  </Badge>
                </Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-1.5">
                    <button
                      onClick={() => void resetPassword(row)}
                      title="Reset kata sandi"
                      className="rounded-md p-1.5 text-ink-500 hover:bg-canvas hover:text-ink-900"
                    >
                      <KeyRound className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() =>
                        void update(row, { isActive: !row.isActive })
                      }
                      disabled={row.isLastActiveOwner && row.isActive}
                      className="rounded-md px-2 py-1 text-[11.5px] font-medium text-ink-600 ring-1 ring-inset ring-line hover:bg-canvas disabled:opacity-40"
                    >
                      {row.isActive ? "Nonaktifkan" : "Aktifkan"}
                    </button>
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </TableShell>
      </SectionCard>

      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="Tambah pengguna"
        description="Kata sandi dibuat otomatis dan ditampilkan sekali."
      >
        <form onSubmit={create} className="space-y-3">
          <Field label="Email" htmlFor="new-email">
            <Input
              id="new-email"
              type="email"
              required
              value={form.email}
              onChange={(event) =>
                setForm({ ...form, email: event.target.value })
              }
              placeholder="nama@qansa.web.id"
            />
          </Field>
          <Field label="Nama" htmlFor="new-name">
            <Input
              id="new-name"
              required
              value={form.name}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
              placeholder="Nama lengkap"
            />
          </Field>
          <Field
            label="Peran"
            htmlFor="new-role"
            hint="OPERATOR cukup untuk operasional harian."
          >
            <Select
              value={form.role}
              onValueChange={(value) =>
                setForm({ ...form, role: value as UserRow["role"] })
              }
              options={[
                { value: "OWNER", label: "OWNER" },
                { value: "ADMIN", label: "ADMIN" },
                { value: "OPERATOR", label: "OPERATOR" },
                { value: "VIEWER", label: "VIEWER" },
              ]}
            />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCreating(false)}
            >
              Batal
            </Button>
            <Button type="submit" loading={busy}>
              Buat pengguna
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={Boolean(secret)}
        onOpenChange={(open) => !open && setSecret(null)}
        title="Simpan kata sandi ini"
        description="Hanya ditampilkan sekali. Sampaikan ke pemilik akun lewat kanal yang aman."
      >
        {secret ? (
          <div className="space-y-3">
            <div className="rounded-lg bg-canvas p-3 ring-1 ring-inset ring-line">
              <p className="text-[11px] uppercase tracking-wide text-ink-400">
                Akun
              </p>
              <p className="text-[13px] text-ink-900">{secret.email}</p>
              <p className="mt-2 text-[11px] uppercase tracking-wide text-ink-400">
                Kata sandi
              </p>
              <p className="break-all font-mono text-[13px] text-ink-950">
                {secret.password}
              </p>
            </div>
            <Button
              className="w-full"
              onClick={() => void copy(secret.password)}
            >
              <Copy className="h-4 w-4" /> Salin kata sandi
            </Button>
            <p className="text-[11.5px] text-ink-500">
              <ShieldCheck className="mr-1 inline h-3.5 w-3.5 text-brand-600" />
              Minta pemilik akun mengaktifkan 2FA setelah masuk pertama kali.
            </p>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
