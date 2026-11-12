"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RotateCcw, ShieldOff, Undo2 } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { DetailRow, KeyValue, SectionCard, StatusBadge, TableShell, Td, Th, Tr } from "@/components/admin/kit";
import { Alert, Badge, Button, ConfirmDialog, Field, PageHeader, Skeleton, Textarea, useToast } from "@/components/ui";
import { CLAIM_STATUS, DELIVERY_KIND, FULFILLMENT_STATUS, ORDER_STATE, formatDateTime, formatRupiah, relativeTime } from "@/lib/format";

interface OrderDetail {
  order: {
    id: string;
    orderSn: string;
    buyerUsername: string | null;
    buyerPhoneMasked: string | null;
    shopeeStatus: string | null;
    state: string;
    totalAmount: string | null;
    paymentMethod: string | null;
    createTime: string | null;
    syncedAt: string;
    claimedAt: string | null;
    ineligibleReason: string | null;
    messageToSeller: string | null;
  };
  store: { id: string; label: string; shopId: number; environment: string; verificationPolicy: string };
  items: Array<{ id: string; itemName: string; variationName: string | null; quantity: number; amount: string | null; mappingStatus: string; unmappedReason: string | null }>;
  fulfillments: Array<{ id: string; productName: string; deliveryKind: string; quantity: number; status: string; claimDeadline: string | null; claimedAt: string | null; failureReason: string | null }>;
  claims: Array<{ id: string; status: string; verificationMethod: string; deliveriesUsed: number; completedAt: string | null; revokedAt: string | null; revokeReason: string | null; ip: string | null; createdAt: string }>;
  events: Array<{ id: string; type: string; fromState: string | null; toState: string | null; createdAt: string; payload: Record<string, unknown> | null }>;
  deliveries: Array<{ log: { id: string; kind: string; reference: string | null; createdAt: string; ip: string | null }; productName: string }>;
}

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useAuth();
  const { toast } = useToast();
  const detail = useApi<OrderDetail>(`/admin/orders/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<string | null>(null);
  const [reissue, setReissue] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const run = async (path: string, body: unknown, label: string) => {
    setBusy(path);
    try {
      await api.post(path, body);
      toast({ title: label });
      detail.refresh();
      setRevoke(null);
      setReissue(null);
      setReason("");
    } catch (caught) {
      toast({ title: "Tindakan gagal", description: caught instanceof ApiError ? caught.message : "", tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const order = detail.data?.order;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Pesanan", href: "/admin/orders" }, { label: order?.orderSn ?? "Detail" }]}
        title={order?.orderSn ?? "Detail pesanan"}
        description={detail.data ? `${detail.data.store.label} · shop ${detail.data.store.shopId} · ${detail.data.store.environment.toLowerCase()}` : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Link href="/admin/orders" className="inline-flex items-center gap-1 text-[12.5px] text-ink-500 hover:text-ink-900">
              <ArrowLeft className="h-3.5 w-3.5" /> Kembali
            </Link>
            {order ? <StatusBadge map={ORDER_STATE} value={order.state} /> : null}
            {order && can("order:read") ? (
              <Button size="sm" variant="secondary" loading={busy === `/admin/orders/${id}/resync`} onClick={() => void run(`/admin/orders/${id}/resync`, {}, "Pemrosesan ulang diantrikan")}>
                <RotateCcw className="h-3.5 w-3.5" /> Proses ulang
              </Button>
            ) : null}
          </div>
        }
      />

      {detail.error ? (
        <Alert tone="danger" title="Pesanan tidak ditemukan">
          {detail.error.message}
        </Alert>
      ) : null}

      {order?.ineligibleReason ? (
        <div className="mb-4">
          <Alert tone="warning" title={`Tidak memenuhi syarat: ${order.ineligibleReason}`}>
            Produk digital tidak akan diserahkan sampai status Shopee berubah menjadi lunas/valid. Status dapat berubah kapan saja setelah pembayaran.
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard className="lg:col-span-2" title="Item pesanan" description="Setiap baris harus punya mapping agar bisa dipenuhi.">
          <TableShell className="rounded-none ring-0 shadow-none">
            <thead>
              <tr>
                <Th>Produk Shopee</Th>
                <Th>Variasi</Th>
                <Th>Qty</Th>
                <Th>Nilai</Th>
                <Th>Mapping</Th>
              </tr>
            </thead>
            <tbody>
              {detail.loading ? (
                <tr>
                  <Td colSpan={5}>
                    <Skeleton className="h-10" />
                  </Td>
                </tr>
              ) : (
                detail.data?.items.map((item) => (
                  <Tr key={item.id}>
                    <Td className="max-w-[240px] truncate text-[12.5px] text-ink-800">{item.itemName}</Td>
                    <Td className="text-[12px] text-ink-500">{item.variationName ?? "—"}</Td>
                    <Td className="tabular-nums text-ink-700">{item.quantity}</Td>
                    <Td className="tabular-nums text-ink-700">{formatRupiah(item.amount)}</Td>
                    <Td>
                      {item.mappingStatus === "MAPPED" ? (
                        <Badge tone="success" dot>terpetakan</Badge>
                      ) : item.mappingStatus === "AMBIGUOUS" ? (
                        <Badge tone="danger" dot>ambigu</Badge>
                      ) : (
                        <Badge tone="warning" dot>
                          {item.unmappedReason ?? "belum"}
                        </Badge>
                      )}
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </TableShell>

          <div className="border-t border-line px-5 py-4">
            <h3 className="mb-2 text-[13px] font-semibold text-ink-950">Pemenuhan</h3>
            {detail.data?.fulfillments.length ? (
              <div className="space-y-2">
                {detail.data.fulfillments.map((fulfillment) => (
                  <div key={fulfillment.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-canvas px-3 py-2.5 ring-1 ring-inset ring-line">
                    <div className="min-w-0">
                      <p className="truncate text-[12.5px] font-medium text-ink-900">{fulfillment.productName}</p>
                      <p className="text-[11px] text-ink-400">
                        {DELIVERY_KIND[fulfillment.deliveryKind]} · {fulfillment.quantity} unit · batas {fulfillment.claimDeadline ? formatDateTime(fulfillment.claimDeadline) : "—"}
                      </p>
                      {fulfillment.failureReason ? <p className="text-[11px] text-amber-600">{fulfillment.failureReason}</p> : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge map={FULFILLMENT_STATUS} value={fulfillment.status} />
                      {can("claim:write") && fulfillment.status !== "CLAIMED" ? (
                        <Button size="sm" variant="secondary" onClick={() => setReissue(fulfillment.id)}>
                          <Undo2 className="h-3.5 w-3.5" /> Terbitkan ulang
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12.5px] text-ink-400">Belum ada fulfillment. Petakan item lalu proses ulang pesanan.</p>
            )}
          </div>
        </SectionCard>

        <SectionCard title="Ringkasan" description="Data dari Shopee Order API.">
          <div className="px-5 py-2">
            <DetailRow label="Status Shopee">{order?.shopeeStatus ?? "—"}</DetailRow>
            <DetailRow label="Pembeli">{order?.buyerUsername ?? "—"}</DetailRow>
            <DetailRow label="Nomor HP">{order?.buyerPhoneMasked ?? "—"}</DetailRow>
            <DetailRow label="Total">{formatRupiah(order?.totalAmount)}</DetailRow>
            <DetailRow label="Pembayaran">{order?.paymentMethod ?? "—"}</DetailRow>
            <DetailRow label="Dibuat">{formatDateTime(order?.createTime)}</DetailRow>
            <DetailRow label="Sinkron">{relativeTime(order?.syncedAt)}</DetailRow>
            <DetailRow label="Diklaim">{order?.claimedAt ? formatDateTime(order.claimedAt) : "—"}</DetailRow>
            <div className="grid grid-cols-2 gap-2 py-3">
              <KeyValue label="Verifikasi" value={detail.data?.store.verificationPolicy ?? "—"} />
              <KeyValue label="Item" value={detail.data?.items.length ?? 0} />
            </div>
            {order?.messageToSeller ? (
              <div className="mb-3 rounded-lg bg-amber-100/60 px-3 py-2 text-[12px] text-amber-600 ring-1 ring-inset ring-amber-600/20">
                Catatan pembeli: {order.messageToSeller}
              </div>
            ) : null}
          </div>
        </SectionCard>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <SectionCard title="Klaim" description="Setiap penyerahan produk tercatat dengan verifikasi dan IP.">
          <div className="space-y-2 p-5">
            {detail.data?.claims.length ? (
              detail.data.claims.map((claim) => (
                <div key={claim.id} className="rounded-lg bg-canvas px-3 py-2.5 ring-1 ring-inset ring-line">
                  <div className="flex items-center justify-between gap-2">
                    <StatusBadge map={CLAIM_STATUS} value={claim.status} />
                    <span className="text-[11px] text-ink-400">{formatDateTime(claim.createdAt)}</span>
                  </div>
                  <p className="mt-1 text-[11.5px] text-ink-500">
                    {claim.verificationMethod} · {claim.deliveriesUsed}× diambil · IP {claim.ip ?? "—"}
                  </p>
                  {claim.revokeReason ? <p className="text-[11px] text-rose-700">dicabut: {claim.revokeReason}</p> : null}
                  {can("claim:write") && claim.status === "COMPLETED" ? (
                    <div className="mt-2 flex justify-end">
                      <Button size="sm" variant="secondary" onClick={() => setRevoke(claim.id)}>
                        <ShieldOff className="h-3.5 w-3.5" /> Cabut akses
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))
            ) : (
              <p className="text-[12.5px] text-ink-400">Belum ada klaim dari pembeli.</p>
            )}
          </div>
        </SectionCard>

        <SectionCard title="Timeline" description="Perubahan status dan peristiwa pipeline.">
          <div className="max-h-[360px] overflow-y-auto px-5 py-3">
            <ol className="relative border-l border-line pl-4">
              {detail.data?.events.map((event) => (
                <li key={event.id} className="mb-3 last:mb-0">
                  <span className="absolute -left-[5px] mt-1.5 h-2 w-2 rounded-full bg-brand-600" />
                  <p className="text-[12px] font-medium text-ink-800">
                    {event.type === "STATE_CHANGED" ? `${event.fromState} → ${event.toState}` : event.type}
                  </p>
                  <p className="text-[11px] text-ink-400">{formatDateTime(event.createdAt)}</p>
                  {event.payload ? <p className="mt-0.5 break-all font-mono text-[10.5px] text-ink-400">{JSON.stringify(event.payload)}</p> : null}
                </li>
              ))}
              {detail.data && detail.data.events.length === 0 ? <p className="text-[12.5px] text-ink-400">Belum ada peristiwa.</p> : null}
            </ol>
          </div>
        </SectionCard>
      </div>

      <div className="mt-4">
        <SectionCard title="Riwayat pengiriman" description="Pembukaan produk dan unduhan berkas.">
          <TableShell>
            <thead>
              <tr>
                <Th>Produk</Th>
                <Th>Jenis</Th>
                <Th>Referensi</Th>
                <Th>IP</Th>
                <Th className="text-right">Waktu</Th>
              </tr>
            </thead>
            <tbody>
              {detail.data?.deliveries.length ? (
                detail.data.deliveries.map((entry) => (
                  <Tr key={entry.log.id}>
                    <Td className="text-[12.5px] text-ink-700">{entry.productName}</Td>
                    <Td className="text-[12px] text-ink-500">{entry.log.kind}</Td>
                    <Td className="font-mono text-[11px] text-ink-400">{entry.log.reference ?? "—"}</Td>
                    <Td className="font-mono text-[11px] text-ink-400">{entry.log.ip ?? "—"}</Td>
                    <Td className="text-right text-[12px] text-ink-400">{formatDateTime(entry.log.createdAt)}</Td>
                  </Tr>
                ))
              ) : (
                <tr>
                  <Td className="text-[12.5px] text-ink-400">Belum ada pengiriman.</Td>
                  <Td /> <Td /> <Td /> <Td />
                </tr>
              )}
            </tbody>
          </TableShell>
        </SectionCard>
      </div>

      <ConfirmDialog
        open={revoke !== null}
        onOpenChange={(open) => !open && setRevoke(null)}
        title="Cabut akses klaim ini?"
        description="Tautan unduhan yang sudah beredar akan berhenti bekerja. Kode yang sudah terkirim tidak bisa ditarik kembali."
        confirmLabel="Cabut akses"
        destructive
        loading={busy?.startsWith("/admin/claims/") ?? false}
        onConfirm={() => revoke && void run(`/admin/claims/${revoke}/revoke`, { reason: reason || "dicabut oleh admin" }, "Akses dicabut")}
      >
        <Field label="Alasan" hint="tercatat di audit log">
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Contoh: indikasi penyalahgunaan pesanan" />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={reissue !== null}
        onOpenChange={(open) => !open && setReissue(null)}
        title="Terbitkan ulang akses?"
        description="Fulfillment kembali ke status siap klaim, dan pembeli bisa mengambil produk sekali lagi."
        confirmLabel="Terbitkan ulang"
        loading={busy?.startsWith("/admin/fulfillments/") ?? false}
        onConfirm={() => reissue && void run(`/admin/fulfillments/${reissue}/reissue`, { reason: reason || "penerbitan ulang oleh admin", extendDays: 7 }, "Akses diterbitkan ulang")}
      >
        <Field label="Alasan">
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Contoh: berkas lama rusak" />
        </Field>
      </ConfirmDialog>
    </>
  );
}
