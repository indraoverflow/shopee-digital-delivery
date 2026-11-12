"use client";

import { AlertTriangle, CheckCircle2, Clock, HeartPulse, Inbox, ShieldAlert } from "lucide-react";
import { useApi } from "@/lib/hooks";
import { LoadingRows, SectionCard, StatCard, TableShell, Td, Th, Tr } from "@/components/admin/kit";
import { Alert, Badge, Card, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { formatDateTime, formatNumber, relativeTime } from "@/lib/format";

interface Monitoring {
  webhooks: {
    total24h: number;
    failed24h: number;
    invalidSignature24h: number;
    duplicates24h: number;
    configured: boolean;
    recent: Array<{ id: string; code: number | null; shopId: number | null; orderSn: string | null; status: string; signatureValid: boolean; error: string | null; receivedAt: string }>;
  };
  queue: { queued: number; running: number; dead: number; succeeded24h: number };
  deadJobs: Array<{ id: string; type: string; attempts: number; lastError: string | null; completedAt: string | null }>;
  failedSyncs: Array<{ id: string; type: string; status: string; error: string | null; finishedAt: string | null; storeLabel: string }>;
  tokenHealth: Array<{ storeId: string; label: string; status: string; lastError: string | null; expiresAt: string | null; minutesLeft: number | null }>;
  unmapped: { items: number; listings: number };
  attempts: Array<{ id: string; orderSn: string | null; success: boolean; reason: string | null; ip: string | null; createdAt: string }>;
  alerts: Array<{ level: "warning" | "critical"; code: string; message: string }>;
  gatewayMode: "live" | "fixture";
}

export default function MonitoringPage() {
  const { data, loading, error, refresh } = useApi<Monitoring>("/admin/monitoring");

  return (
    <>
      <PageHeader
        title="Monitoring"
        description="Kesehatan webhook, antrean pekerjaan, token toko, dan hal-hal yang butuh tindakan."
        actions={
          <button onClick={refresh} className="text-[12.5px] font-medium text-brand-700 hover:text-brand-800">
            Muat ulang
          </button>
        }
      />

      {data?.gatewayMode === "fixture" ? (
        <div className="mb-4">
          <Alert tone="warning" title="Mode fixture">
            Webhook dan sinkronisasi berjalan terhadap data contoh. Angka di halaman ini nyata untuk basis data ini, bukan trafik Shopee.
          </Alert>
        </div>
      ) : null}

      {error ? (
        <Alert tone="danger" title="Gagal memuat monitoring">
          {error.message}
        </Alert>
      ) : null}

      {data && data.alerts.length > 0 ? (
        <div className="mb-4 space-y-2">
          {data.alerts.map((alert) => (
            <Alert key={alert.code} tone={alert.level === "critical" ? "danger" : "warning"} title={alert.message}>
              <span className="font-mono text-[11px]">{alert.code}</span>
            </Alert>
          ))}
        </div>
      ) : data ? (
        <div className="mb-4">
          <Alert tone="success" title="Tidak ada peringatan aktif">
            Semua pemeriksaan otomatis lolos pada saat halaman ini dimuat.
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {loading || !data ? (
          Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-[104px]" />)
        ) : (
          <>
            <StatCard label="Webhook 24 jam" value={formatNumber(data.webhooks.total24h)} hint={`${data.webhooks.duplicates24h} duplikat diabaikan`} tone="brand" icon={<Inbox className="h-4 w-4" />} />
            <StatCard label="Antrean" value={formatNumber(data.queue.queued + data.queue.running)} hint={`${data.queue.succeeded24h} sukses / 24 jam`} tone="info" icon={<Clock className="h-4 w-4" />} />
            <StatCard label="Dead letter" value={formatNumber(data.queue.dead)} hint={data.queue.dead > 0 ? "Perlu diperiksa" : "Bersih"} tone={data.queue.dead > 0 ? "danger" : "success"} icon={<ShieldAlert className="h-4 w-4" />} />
            <StatCard label="Item tanpa mapping" value={formatNumber(data.unmapped.items)} hint={`${data.unmapped.listings} listing belum dipetakan`} tone={data.unmapped.items > 0 ? "warning" : "neutral"} icon={<AlertTriangle className="h-4 w-4" />} />
          </>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <SectionCard title="Webhook terakhir" description={data?.webhooks.configured ? "Tanda tangan diverifikasi dengan partner key." : "SHOPEE_PUSH_URL belum diisi: tanda tangan tidak diverifikasi."}>
          <TableShell className="rounded-none shadow-none ring-0">
            <thead>
              <tr>
                <Th>Kode</Th>
                <Th>Pesanan</Th>
                <Th>Status</Th>
                <Th>Tanda tangan</Th>
                <Th className="text-right">Waktu</Th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <LoadingRows rows={5} cols={5} />
              ) : data && data.webhooks.recent.length > 0 ? (
                data.webhooks.recent.map((event) => (
                  <Tr key={event.id}>
                    <Td className="font-mono text-[12px] text-ink-600">{event.code ?? "—"}</Td>
                    <Td className="font-mono text-[11.5px] text-ink-500">{event.orderSn ?? "—"}</Td>
                    <Td>
                      <Badge tone={event.status === "FAILED" ? "danger" : event.status === "IGNORED" ? "neutral" : "success"}>{event.status}</Badge>
                    </Td>
                    <Td>{event.signatureValid ? <CheckCircle2 className="h-3.5 w-3.5 text-brand-600" /> : <AlertTriangle className="h-3.5 w-3.5 text-rose-700" />}</Td>
                    <Td className="text-right text-[11.5px] text-ink-400">{relativeTime(event.receivedAt)}</Td>
                  </Tr>
                ))
              ) : null}
            </tbody>
          </TableShell>
          {!loading && data && data.webhooks.recent.length === 0 ? (
            <div className="p-5">
              <EmptyState title="Belum ada push" description="Shopee akan mengirim push setelah aplikasi terhubung dan pesanan berubah status." icon={<HeartPulse className="h-5 w-5" />} />
            </div>
          ) : null}
        </SectionCard>

        <SectionCard title="Kesehatan token toko" description="Token diperbarui otomatis sebelum kedaluwarsa.">
          <div className="p-5">
            {loading ? (
              <Skeleton className="h-24" />
            ) : data && data.tokenHealth.length > 0 ? (
              <div className="space-y-2">
                {data.tokenHealth.map((store) => (
                  <div key={store.storeId} className="flex items-center justify-between gap-3 rounded-lg bg-canvas px-3 py-2.5 ring-1 ring-inset ring-line">
                    <div className="min-w-0">
                      <p className="truncate text-[12.5px] font-medium text-ink-900">{store.label}</p>
                      <p className="text-[11px] text-ink-400">
                        {store.expiresAt ? `berakhir ${relativeTime(store.expiresAt)}` : "belum ada token"}
                        {store.lastError ? ` · ${store.lastError}` : ""}
                      </p>
                    </div>
                    <Badge tone={store.status === "CONNECTED" ? (store.minutesLeft !== null && store.minutesLeft < 30 ? "warning" : "success") : "danger"} dot>
                      {store.status}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12.5px] text-ink-400">Belum ada toko.</p>
            )}
          </div>
        </SectionCard>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <SectionCard title="Job gagal permanen" description="Setelah semua percobaan habis, job berhenti di sini dan butuh tindakan manual.">
          <div className="p-5">
            {data?.deadJobs.length ? (
              <div className="space-y-2">
                {data.deadJobs.map((job) => (
                  <div key={job.id} className="rounded-lg bg-rose-100/50 px-3 py-2 ring-1 ring-inset ring-rose-700/20">
                    <p className="text-[12px] font-medium text-rose-700">
                      {job.type} · {job.attempts} percobaan
                    </p>
                    <p className="mt-0.5 break-all font-mono text-[11px] text-rose-700/80">{job.lastError ?? "tanpa pesan"}</p>
                    <p className="text-[10.5px] text-ink-400">{formatDateTime(job.completedAt)}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12.5px] text-ink-400">Tidak ada job yang berhenti.</p>
            )}
          </div>
        </SectionCard>

        <SectionCard title="Sinkronisasi gagal" description="Kegagalan katalog atau pesanan yang tercatat.">
          <div className="p-5">
            {data?.failedSyncs.length ? (
              <div className="space-y-2">
                {data.failedSyncs.map((job) => (
                  <div key={job.id} className="rounded-lg bg-canvas px-3 py-2 ring-1 ring-inset ring-line">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[12px] font-medium text-ink-800">
                        {job.storeLabel} · {job.type === "PRODUCTS" ? "katalog" : "pesanan"}
                      </p>
                      <Badge tone={job.status === "DEAD" ? "danger" : "warning"}>{job.status}</Badge>
                    </div>
                    <p className="mt-0.5 break-all font-mono text-[11px] text-ink-500">{job.error ?? "—"}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12.5px] text-ink-400">Semua sinkronisasi berjalan normal.</p>
            )}
          </div>
        </SectionCard>
      </div>

      <div className="mt-4">
        <SectionCard title="Percobaan verifikasi terbaru" description="Upaya yang gagal bisa berarti pembeli salah ketik, atau ada yang mencoba menebak.">
          <TableShell>
            <thead>
              <tr>
                <Th>Pesanan</Th>
                <Th>Hasil</Th>
                <Th>Alasan</Th>
                <Th>IP</Th>
                <Th className="text-right">Waktu</Th>
              </tr>
            </thead>
            <tbody>
              {data?.attempts.length ? (
                data.attempts.map((attempt) => (
                  <Tr key={attempt.id}>
                    <Td className="font-mono text-[11.5px] text-ink-600">{attempt.orderSn ?? "—"}</Td>
                    <Td>{attempt.success ? <Badge tone="success">berhasil</Badge> : <Badge tone="danger">gagal</Badge>}</Td>
                    <Td className="text-[12px] text-ink-500">{attempt.reason ?? "—"}</Td>
                    <Td className="font-mono text-[11px] text-ink-400">{attempt.ip ?? "—"}</Td>
                    <Td className="text-right text-[11.5px] text-ink-400">{formatDateTime(attempt.createdAt)}</Td>
                  </Tr>
                ))
              ) : (
                <tr>
                  <Td className="text-[12.5px] text-ink-400">Belum ada percobaan.</Td>
                  <Td /> <Td /> <Td /> <Td />
                </tr>
              )}
            </tbody>
          </TableShell>
        </SectionCard>
      </div>

      <Card className="mt-4 p-4">
        <p className="text-[12px] leading-relaxed text-ink-500">
          Pemeriksaan otomatis: tanda tangan push, dead-letter queue, token yang hampir kedaluwarsa, listing tanpa mapping, dan toko berstatus error. Halaman ini tidak melakukan
          polling otomatis agar tidak membebani database saat operator meninggalkannya terbuka.
        </p>
      </Card>
    </>
  );
}
