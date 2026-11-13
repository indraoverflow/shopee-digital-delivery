"use client";

import { useEffect, useState } from "react";
import { Save, ShieldCheck } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import {
  DetailRow,
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
  Field,
  Input,
  PageHeader,
  Pagination,
  Select,
  Switch,
  Tabs,
  useToast,
} from "@/components/ui";
import { formatDateTime } from "@/lib/format";

interface SettingsResponse {
  settings: {
    branding: {
      brandName: string;
      tagline: string;
      supportEmail: string;
      supportWhatsapp: string;
      claimDomain: string;
    };
    claim: {
      sessionMinutes: number;
      maxAttemptsPerHour: number;
      maxAttemptsPerOrder: number;
      downloadTtlMinutes: number;
      maxDownloadsPerFulfillment: number;
      manualRequestDays: number;
      manualApprovalHours: number;
      autoShipOnClaim: boolean;
      autoShipPrefix: string;
      autoShipTrigger: "ON_PAYMENT" | "ON_CLAIM";
    };
    sync: {
      productIntervalMinutes: number;
      orderReconcileMinutes: number;
      orderLookbackHours: number;
    };
    notify: {
      enabled: boolean;
      webhookUrl: string | null;
      secret: string | null;
      events: string[];
    };
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
  const { data, loading, error, refresh } =
    useApi<SettingsResponse>("/admin/settings");
  const [tab, setTab] = useState("general");
  const [page, setPage] = useState(1);
  const audit = useApi<{
    data: AuditRow[];
    total: number;
    page: number;
    pageSize: number;
  }>(tab === "audit" ? `/admin/audit-logs?page=${page}&pageSize=20` : null);
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
          maxDownloadsPerFulfillment: Number(
            form.claim.maxDownloadsPerFulfillment,
          ),
          manualRequestDays: Number(form.claim.manualRequestDays),
          manualApprovalHours: Number(form.claim.manualApprovalHours),
          autoShipOnClaim: form.claim.autoShipOnClaim,
          autoShipPrefix: form.claim.autoShipPrefix,
          autoShipTrigger: form.claim.autoShipTrigger,
        },
        sync: {
          productIntervalMinutes: Number(form.sync.productIntervalMinutes),
          orderReconcileMinutes: Number(form.sync.orderReconcileMinutes),
          orderLookbackHours: Number(form.sync.orderLookbackHours),
        },
        notify: {
          enabled: form.notify.enabled,
          webhookUrl: form.notify.webhookUrl?.trim()
            ? form.notify.webhookUrl.trim()
            : null,
          secret: form.notify.secret?.trim() ? form.notify.secret.trim() : null,
          events: form.notify.events,
        },
      });
      toast({ title: "Pengaturan disimpan" });
      refresh();
    } catch (caught) {
      toast({
        title: "Gagal menyimpan",
        description: caught instanceof ApiError ? caught.message : "",
        tone: "danger",
      });
    } finally {
      setBusy(false);
    }
  };

  const editable = can("settings:write");

  return (
    <>
      <PageHeader
        title="Pengaturan"
        description="Branding portal klaim, batas anti-penyalahgunaan, jadwal sinkronisasi, dan jejak audit."
      />

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
            { value: "notify", label: "Notifikasi" },
            { value: "audit", label: "Audit log" },
          ]}
        />
      </div>

      {tab === "general" ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <SectionCard
            className="lg:col-span-2"
            title="Branding portal"
            description="Dipakai halaman klaim bila toko tidak punya branding sendiri."
          >
            {loading || !form ? (
              <div className="space-y-3 p-5">
                <SkeletonRows />
              </div>
            ) : (
              <div className="space-y-4 p-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Nama merek">
                    <Input
                      value={form.branding.brandName}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          branding: {
                            ...form.branding,
                            brandName: event.target.value,
                          },
                        })
                      }
                      disabled={!editable}
                    />
                  </Field>
                  <Field label="Domain klaim">
                    <Input
                      value={form.branding.claimDomain}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          branding: {
                            ...form.branding,
                            claimDomain: event.target.value,
                          },
                        })
                      }
                      disabled={!editable}
                    />
                  </Field>
                </div>
                <Field label="Tagline">
                  <Input
                    value={form.branding.tagline}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        branding: {
                          ...form.branding,
                          tagline: event.target.value,
                        },
                      })
                    }
                    disabled={!editable}
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Email dukungan">
                    <Input
                      value={form.branding.supportEmail}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          branding: {
                            ...form.branding,
                            supportEmail: event.target.value,
                          },
                        })
                      }
                      disabled={!editable}
                    />
                  </Field>
                  <Field label="WhatsApp dukungan">
                    <Input
                      value={form.branding.supportWhatsapp}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          branding: {
                            ...form.branding,
                            supportWhatsapp: event.target.value,
                          },
                        })
                      }
                      disabled={!editable}
                    />
                  </Field>
                </div>
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Batas klaim"
            description="Bertahan lintas restart dan lintas proses."
          >
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
                        setForm({
                          ...form,
                          claim: {
                            ...form.claim,
                            [key]: Number(
                              event.target.value.replace(/\D/g, ""),
                            ),
                          },
                        })
                      }
                      disabled={!editable}
                    />
                  </Field>
                ))}

                {/* Digital orders are delivered by the portal, so Shopee has to be
                    told they were shipped; waiting for an operator is how an order
                    gets cancelled after the buyer already has the product. */}
                <div className="flex items-center justify-between rounded-lg bg-canvas px-3 py-2.5 ring-1 ring-inset ring-line">
                  <div>
                    <p className="text-[12.5px] font-medium text-ink-800">
                      Tandai dikirim otomatis
                    </p>
                    <p className="text-[11.5px] text-ink-500">
                      Begitu pembeli membuka produknya, pesanan langsung
                      ditandai dikirim di Shopee dengan nomor resi di bawah.
                    </p>
                  </div>
                  <Switch
                    checked={form.claim.autoShipOnClaim}
                    onCheckedChange={(value) =>
                      setForm({
                        ...form,
                        claim: { ...form.claim, autoShipOnClaim: value },
                      })
                    }
                    label="Aktif"
                  />
                </div>

                <Field
                  label="Kapan ditandai dikirim"
                  hint="Saat pesanan dibayar berarti status langsung Dikirim tanpa menunggu pembeli membuka produk"
                >
                  <Select
                    value={form.claim.autoShipTrigger}
                    onValueChange={(value) =>
                      setForm({
                        ...form,
                        claim: {
                          ...form.claim,
                          autoShipTrigger: value as "ON_PAYMENT" | "ON_CLAIM",
                        },
                      })
                    }
                    options={[
                      { value: "ON_PAYMENT", label: "Saat pesanan dibayar" },
                      {
                        value: "ON_CLAIM",
                        label: "Saat pembeli membuka produk",
                      },
                    ]}
                    disabled={!editable || !form.claim.autoShipOnClaim}
                  />
                </Field>

                <Field
                  label="Awalan nomor resi"
                  hint="Resi diisi awalan ini ditambah nomor pesanan"
                >
                  <Input
                    value={form.claim.autoShipPrefix}
                    maxLength={24}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        claim: {
                          ...form.claim,
                          autoShipPrefix: event.target.value,
                        },
                      })
                    }
                    disabled={!editable || !form.claim.autoShipOnClaim}
                  />
                </Field>
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
          <SectionCard
            className="lg:col-span-2"
            title="Jadwal"
            description="Worker membaca nilai ini setiap siklus perawatan."
          >
            {loading || !form ? (
              <div className="p-5">
                <SkeletonRows />
              </div>
            ) : (
              <div className="space-y-4 p-5">
                {(
                  [
                    [
                      "productIntervalMinutes",
                      "Interval sinkron katalog (menit)",
                    ],
                    [
                      "orderReconcileMinutes",
                      "Interval rekonsiliasi pesanan (menit)",
                    ],
                    ["orderLookbackHours", "Jendela lihat ke belakang (jam)"],
                  ] as const
                ).map(([key, label]) => (
                  <Field key={key} label={label}>
                    <Input
                      value={String(form.sync[key])}
                      inputMode="numeric"
                      onChange={(event) =>
                        setForm({
                          ...form,
                          sync: {
                            ...form.sync,
                            [key]: Number(
                              event.target.value.replace(/\D/g, ""),
                            ),
                          },
                        })
                      }
                      disabled={!editable}
                    />
                  </Field>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Runtime"
            description="Nilai yang tidak bisa diubah dari UI."
          >
            <div className="px-5 py-2">
              <DetailRow label="Gateway Shopee">
                <Badge
                  tone={data?.gatewayMode === "fixture" ? "warning" : "success"}
                >
                  {data?.gatewayMode ?? "—"}
                </Badge>
              </DetailRow>
              <DetailRow label="Environment">
                {data?.environment ?? "—"}
              </DetailRow>
              <DetailRow label="Enterprise">
                <span className="inline-flex items-center gap-1 text-brand-700">
                  <ShieldCheck className="h-3.5 w-3.5" /> token terenkripsi
                </span>
              </DetailRow>
              <DetailRow label="Anda masuk sebagai">
                {user?.email ?? "—"}
              </DetailRow>
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
      ) : tab === "notify" ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <SectionCard
            className="lg:col-span-2"
            title="Webhook notifikasi"
            description="Satu endpoint keluar: Slack, n8n, atau gateway WhatsApp Anda."
          >
            {loading || !form ? (
              <div className="p-5">
                <SkeletonRows />
              </div>
            ) : (
              <div className="space-y-4 p-5">
                <div className="flex items-center justify-between rounded-lg bg-canvas px-3 py-2.5 ring-1 ring-inset ring-line">
                  <div>
                    <p className="text-[12.5px] font-medium text-ink-800">
                      Kirim notifikasi
                    </p>
                    <p className="text-[11.5px] text-ink-500">
                      Nonaktif berarti tidak ada request keluar sama sekali.
                    </p>
                  </div>
                  <Switch
                    checked={form.notify.enabled}
                    onCheckedChange={(value) =>
                      setForm({
                        ...form,
                        notify: { ...form.notify, enabled: value },
                      })
                    }
                    label="Aktif"
                  />
                </div>

                <Field
                  label="URL webhook"
                  hint="Kosongkan untuk mematikan pengiriman"
                >
                  <Input
                    value={form.notify.webhookUrl ?? ""}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        notify: {
                          ...form.notify,
                          webhookUrl: event.target.value || null,
                        },
                      })
                    }
                    placeholder="https://hooks.slack.com/services/..."
                    disabled={!editable}
                  />
                </Field>

                <Field
                  label="Secret HMAC"
                  hint="Opsional. Bila diisi, setiap request membawa header x-qansa-signature."
                >
                  <Input
                    type="password"
                    value={form.notify.secret ?? ""}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        notify: {
                          ...form.notify,
                          secret: event.target.value || null,
                        },
                      })
                    }
                    placeholder="••••••••"
                    disabled={!editable}
                  />
                </Field>

                <div>
                  <p className="mb-2 text-[12.5px] font-medium text-ink-700">
                    Peristiwa
                  </p>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {[
                      ["claim.completed", "Klaim berhasil"],
                      ["claim.revoked", "Akses dicabut"],
                      ["fulfillment.out_of_stock", "Stok habis"],
                      ["sync.failed", "Sinkronisasi gagal"],
                      ["manual_request.created", "Verifikasi manual diminta"],
                    ].map(([value, label]) => (
                      <label
                        key={value}
                        className="flex items-center gap-2 text-[12.5px] text-ink-700"
                      >
                        <input
                          type="checkbox"
                          checked={form.notify.events.includes(value)}
                          onChange={(event) =>
                            setForm({
                              ...form,
                              notify: {
                                ...form.notify,
                                events: event.target.checked
                                  ? [...form.notify.events, value]
                                  : form.notify.events.filter(
                                      (entry) => entry !== value,
                                    ),
                              },
                            })
                          }
                          disabled={!editable}
                          className="h-3.5 w-3.5 rounded border-line text-brand-700"
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Format"
            description="Yang diterima endpoint Anda."
          >
            <div className="space-y-2 px-5 py-3 text-[12px] leading-relaxed text-ink-600">
              <p>POST JSON dengan field type, title, data, at, dan source.</p>
              <p>
                Tanda tangan: HMAC-SHA256 dari body mentah, hex, di header
                x-qansa-signature.
              </p>
              <p>
                Kegagalan pengiriman dicatat di log dan tidak pernah
                menggagalkan klaim.
              </p>
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
        <SectionCard
          title="Audit log"
          description="Setiap tindakan administratif dan peristiwa sistem yang penting."
        >
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
                    <Td className="font-mono text-[11.5px] text-ink-800">
                      {entry.action}
                    </Td>
                    <Td className="text-[12px] text-ink-600">
                      {entry.actorLabel ?? "sistem"}
                    </Td>
                    <Td className="text-[11.5px] text-ink-500">
                      {entry.targetType ?? "—"}
                      {entry.targetId ? (
                        <p className="font-mono text-[10px] text-ink-300">
                          {entry.targetId.slice(0, 8)}…
                        </p>
                      ) : null}
                    </Td>
                    <Td className="max-w-[280px] truncate font-mono text-[10.5px] text-ink-400">
                      {entry.metadata ? JSON.stringify(entry.metadata) : "—"}
                    </Td>
                    <Td className="font-mono text-[11px] text-ink-400">
                      {entry.ip ?? "—"}
                    </Td>
                    <Td className="text-right text-[11.5px] text-ink-400">
                      {formatDateTime(entry.createdAt)}
                    </Td>
                  </Tr>
                ))
              ) : null}
            </tbody>
          </TableShell>
          {audit.data ? (
            <Pagination
              page={audit.data.page}
              pageSize={audit.data.pageSize}
              total={audit.data.total}
              onPage={setPage}
            />
          ) : null}
        </SectionCard>
      )}
    </>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, index) => (
        <div
          key={index}
          className="h-9 animate-pulse rounded-md bg-ink-950/[0.06]"
        />
      ))}
    </div>
  );
}
