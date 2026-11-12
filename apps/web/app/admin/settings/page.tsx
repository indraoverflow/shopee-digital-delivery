"use client";

import { useEffect, useState } from "react";
import { Save, ShieldCheck } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { DetailRow, LoadingRows, SectionCard, TableShell, Td, Th, Tr } from "@/components/admin/kit";
import { Alert, Badge, Button, Field, Input, PageHeader, Pagination, Tabs, useToast } from "@/components/ui";
import { formatDateTime } from "@/lib/format";

interface SettingsResponse {
  settings: {
    branding: { brandName: string; tagline: string; supportEmail: string; supportWhatsapp: string; claimDomain: string };
    claim: { sessionMinutes: number; maxAttemptsPerHour: number; maxAttemptsPerOrder: number; downloadTtlMinutes: number; maxDownloadsPerFulfillment: number };
    sync: { productIntervalMinutes: number; orderReconcileMinutes: number; orderLookbackHours: number };
  };
  gatewayMode: "live" | "fixture";
  environment: string;
}

interface AuditRow {
  id: string;
  action: string;
  actorLabel: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export default function SettingsPage() {
  const { can, user } = useAuth();
  const { toast } = useToast();
  const { data, loading, error, refresh } = useApi<SettingsResponse>("/admin/settings");
  const [tab, setTab] = useState("general");
  const [page, setPage] = useState(1);
  const audit = useApi<{ data: AuditRow[]; total: number; page: number; pageSize: number }>(tab === "audit" ? `/admin/audit-logs?page=${page}&pageSize=20` : null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<SettingsResponse["settings"] | null>(null);

  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);

  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      await api.patch("/admin/settings", {
        branding: form.branding,
        claim: {
          sessionMinutes: Number(form.claim.sessionMinutes),
          maxAttemptsPerHour: Number(form.claim.maxAttemptsPerHour),
          maxAttemptsPerOrder: Number(form.claim.maxAttemptsPerOrder),
          downloadTtlMinutes: Number(form.claim.downloadTtlMinutes),
          maxDownloadsPerFulfillment: Number(form.claim.maxDownloadsPerFulfillment),
        },
        sync: {
          productIntervalMinutes: Number(form.sync.productIntervalMinutes),
          orderReconcileMinutes: Number(form.sync.orderReconcileMinutes),
          orderLookbackHours: Number(form.sync.orderLookbackHours),
        },
      });
      toast({ title: "Pengaturan disimpan" });
      refresh();
    } catch (caught) {
      toast({ title: "Gagal menyimpan", description: caught instanceof ApiError ? caught.message : "", tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const editable = can("settings:write");

  return (
    <>
      <PageHeader title="Pengaturan" description="Branding portal klaim, batas anti-penyalahgunaan, jadwal sinkronisasi, dan jejak audit." />

      {error ? (
        <Alert tone="danger" title="Gagal memuat pengaturan">
          {error.message}
        </Alert>
      ) : null}

      <div className="mb-4">
        <Tabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: "general", label: "Umum & klaim" },
            { value: "sync", label: "Sinkronisasi" },
            { value: "audit", label: "Audit log" },
          ]}
        />
      </div>

      {tab === "general" ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <SectionCard className="lg:col-span-2" title="Branding portal" description="Dipakai halaman klaim bila toko tidak punya branding sendiri.">
            {loading || !form ? (
              <div className="space-y-3 p-5">
                <SkeletonRows />
              </div>
            ) : (
              <div className="space-y-4 p-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Nama merek">
                    <Input value={form.branding.brandName} onChange={(event) => setForm({ ...form, branding: { ...form.branding, brandName: event.target.value } })} disabled={!editable} />
                  </Field>
                  <Field label="Domain klaim">
                    <Input value={form.branding.claimDomain} onChange={(event) => setForm({ ...form, branding: { ...form.branding, claimDomain: event.target.value } })} disabled={!editable} />
                  </Field>
                </div>
                <Field label="Tagline">
                  <Input value={form.branding.tagline} onChange={(event) => setForm({ ...form, branding: { ...form.branding, tagline: event.target.value } })} disabled={!editable} />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Email dukungan">
                    <Input value={form.branding.supportEmail} onChange={(event) => setForm({ ...form, branding: { ...form.branding, supportEmail: event.target.value } })} disabled={!editable} />
                  </Field>
                  <Field label="WhatsApp dukungan">
                    <Input value={form.branding.supportWhatsapp} onChange={(event) => setForm({ ...form, branding: { ...form.branding, supportWhatsapp: event.target.value } })} disabled={!editable} />
                  </Field>
                </div>
              </div>
            )}
          </SectionCard>

          <SectionCard title="Batas klaim" description="Bertahan lintas restart dan lintas proses.">
            {loading || !form ? (
              <div className="p-5">
                <SkeletonRows />
              </div>
            ) : (
              <div className="space-y-4 p-5">
                {(
                  [
                    ["sessionMinutes", "Durasi sesi (menit)"],
                    ["maxAttemptsPerHour", "Percobaan gagal / IP / jam"],
                    ["maxAttemptsPerOrder", "Percobaan gagal / pesanan / jam"],
                    ["downloadTtlMinutes", "Masa tautan unduhan (menit)"],
                    ["maxDownloadsPerFulfillment", "Batas unduhan / klaim"],
                  ] as const
                ).map(([key, label]) => (
                  <Field key={key} label={label}>
                    <Input
                      value={String(form.claim[key])}
                      inputMode="numeric"
                      onChange={(event) =>
                        setForm({ ...form, claim: { ...form.claim, [key]: Number(event.target.value.replace(/\D/g, "")) } })
                      }
                      disabled={!editable}
                    />
                  </Field>
                ))}
              </div>
            )}
          </SectionCard>

          {editable ? (
            <div className="lg:col-span-3 flex justify-end">
              <Button onClick={() => void save()} loading={busy}>
                <Save className="h-4 w-4" /> Simpan pengaturan
              </Button>
            </div>
          ) : null}
        </div>
      ) : tab === "sync" ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <SectionCard className="lg:col-span-2" title="Jadwal" description="Worker membaca nilai ini setiap siklus perawatan.">
            {loading || !form ? (
              <div className="p-5">
                <SkeletonRows />
              </div>
            ) : (
              <div className="space-y-4 p-5">
                {(
                  [
                    ["productIntervalMinutes", "Interval sinkron katalog (menit)"],
                    ["orderReconcileMinutes", "Interval rekonsiliasi pesanan (menit)"],
                    ["orderLookbackHours", "Jendela lihat ke belakang (jam)"],
                  ] as const
                ).map(([key, label]) => (
                  <Field key={key} label={label}>
                    <Input
                      value={String(form.sync[key])}
                      inputMode="numeric"
                      onChange={(event) => setForm({ ...form, sync: { ...form.sync, [key]: Number(event.target.value.replace(/\D/g, "")) } })}
                      disabled={!editable}
                    />
                  </Field>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Runtime" description="Nilai yang tidak bisa diubah dari UI.">
            <div className="px-5 py-2">
              <DetailRow label="Gateway Shopee">
                <Badge tone={data?.gatewayMode === "fixture" ? "warning" : "success"}>{data?.gatewayMode ?? "—"}</Badge>
              </DetailRow>
              <DetailRow label="Environment">{data?.environment ?? "—"}</DetailRow>
              <DetailRow label="Enterprise">
                <span className="inline-flex items-center gap-1 text-brand-700">
                  <ShieldCheck className="h-3.5 w-3.5" /> token terenkripsi
                </span>
              </DetailRow>
              <DetailRow label="Anda masuk sebagai">{user?.email ?? "—"}</DetailRow>
            </div>
          </SectionCard>

          {editable ? (
            <div className="lg:col-span-3 flex justify-end">
              <Button onClick={() => void save()} loading={busy}>
                <Save className="h-4 w-4" /> Simpan pengaturan
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <SectionCard title="Audit log" description="Setiap tindakan administratif dan peristiwa sistem yang penting.">
          <TableShell>
            <thead>
              <tr>
                <Th>Aksi</Th>
                <Th>Aktor</Th>
                <Th>Target</Th>
                <Th>Metadata</Th>
                <Th>IP</Th>
                <Th className="text-right">Waktu</Th>
              </tr>
            </thead>
            <tbody>
              {audit.loading ? (
                <LoadingRows rows={8} cols={6} />
              ) : audit.data && audit.data.data.length > 0 ? (
                audit.data.data.map((entry) => (
                  <Tr key={entry.id}>
                    <Td className="font-mono text-[11.5px] text-ink-800">{entry.action}</Td>
                    <Td className="text-[12px] text-ink-600">{entry.actorLabel ?? "sistem"}</Td>
                    <Td className="text-[11.5px] text-ink-500">
                      {entry.targetType ?? "—"}
                      {entry.targetId ? <p className="font-mono text-[10px] text-ink-300">{entry.targetId.slice(0, 8)}…</p> : null}
                    </Td>
                    <Td className="max-w-[280px] truncate font-mono text-[10.5px] text-ink-400">{entry.metadata ? JSON.stringify(entry.metadata) : "—"}</Td>
                    <Td className="font-mono text-[11px] text-ink-400">{entry.ip ?? "—"}</Td>
                    <Td className="text-right text-[11.5px] text-ink-400">{formatDateTime(entry.createdAt)}</Td>
                  </Tr>
                ))
              ) : null}
            </tbody>
          </TableShell>
          {audit.data ? <Pagination page={audit.data.page} pageSize={audit.data.pageSize} total={audit.data.total} onPage={setPage} /> : null}
        </SectionCard>
      )}
    </>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="h-9 animate-pulse rounded-md bg-ink-950/[0.06]" />
      ))}
    </div>
  );
}
