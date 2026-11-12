"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Search, ShieldOff } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { LoadingRows, SectionCard, StatusBadge, TableShell, Td, Th, Tr } from "@/components/admin/kit";
import { Alert, Badge, Button, ConfirmDialog, Field, Input, PageHeader, Pagination, Select, Tabs, Textarea, useDebounced, useToast } from "@/components/ui";
import { CLAIM_STATUS, DELIVERY_KIND, formatDateTime } from "@/lib/format";

interface ClaimRow {
  id: string;
  orderId: string;
  orderSn: string;
  buyerUsername: string | null;
  productName: string;
  deliveryKind: string;
  storeLabel: string;
  status: string;
  fulfillmentStatus: string;
  fulfillmentId: string;
  verificationMethod: string;
  deliveriesUsed: number;
  completedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  createdAt: string;
  ip: string | null;
}

interface AttemptRow {
  id: string;
  orderSn: string | null;
  method: string;
  success: boolean;
  reason: string | null;
  ip: string | null;
  createdAt: string;
}

export default function ClaimsPage() {
  const { can } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState("claims");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search);
  const [revoke, setRevoke] = useState<ClaimRow | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (status !== "all") params.set("status", status);
    if (debounced.trim()) params.set("query", debounced.trim());
    return params.toString();
  }, [page, status, debounced]);

  const claims = useApi<{ data: ClaimRow[]; total: number; page: number; pageSize: number }>(tab === "claims" ? `/admin/claims?${query}` : null);
  const attempts = useApi<{ data: AttemptRow[]; total: number; page: number; pageSize: number }>(tab === "attempts" ? `/admin/claim-attempts?${query}` : null);

  useEffect(() => {
    setPage(1);
  }, [status, debounced, tab]);

  const doRevoke = async () => {
    if (!revoke) return;
    setBusy(true);
    try {
      await api.post(`/admin/claims/${revoke.id}/revoke`, { reason: reason || "dicabut oleh admin" });
      toast({ title: "Klaim dicabut", description: revoke.orderSn });
      setRevoke(null);
      setReason("");
      claims.refresh();
    } catch (caught) {
      toast({ title: "Gagal mencabut", description: caught instanceof ApiError ? caught.message : "", tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const active = tab === "claims" ? claims : attempts;

  return (
    <>
      <PageHeader
        title="Klaim & Pengiriman"
        description="Semua penyerahan produk digital tercatat. Cabut akses bila ada penyalahgunaan; terbitkan ulang bila pembeli butuh kirim ulang."
      />

      <div className="mb-4">
        <Tabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: "claims", label: "Klaim", count: claims.data?.total },
            { value: "attempts", label: "Percobaan verifikasi", count: attempts.data?.total },
          ]}
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cari nomor pesanan" className="h-9 pl-9 text-[13px]" />
        </div>
        {tab === "claims" ? (
          <Select
            value={status}
            onValueChange={setStatus}
            options={[{ value: "all", label: "Semua status" }, ...Object.entries(CLAIM_STATUS).map(([value, meta]) => ({ value, label: meta.label }))]}
            className="min-w-40"
          />
        ) : null}
      </div>

      {active.error ? (
        <Alert tone="danger" title="Gagal memuat data">
          {active.error.message}
        </Alert>
      ) : null}

      {tab === "claims" ? (
        <SectionCard title="Riwayat klaim" description="Kode dan tautan tidak pernah ditampilkan di sini.">
          <TableShell>
            <thead>
              <tr>
                <Th>Pesanan</Th>
                <Th>Pembeli</Th>
                <Th>Produk</Th>
                <Th>Status</Th>
                <Th>Verifikasi</Th>
                <Th>Pengambilan</Th>
                <Th className="text-right">Waktu</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {claims.loading ? (
                <LoadingRows rows={6} cols={8} />
              ) : claims.data && claims.data.data.length > 0 ? (
                claims.data.data.map((claim) => (
                  <Tr key={claim.id}>
                    <Td>
                      <Link href={`/admin/orders/${claim.orderId}`} className="font-mono text-[12.5px] text-ink-900 hover:text-brand-700">
                        {claim.orderSn}
                      </Link>
                      <p className="text-[10.5px] text-ink-400">{claim.storeLabel}</p>
                    </Td>
                    <Td className="text-[12px] text-ink-600">{claim.buyerUsername ?? "—"}</Td>
                    <Td className="max-w-[180px] truncate text-[12.5px] text-ink-700">
                      {claim.productName}
                      <p className="text-[10.5px] text-ink-400">{DELIVERY_KIND[claim.deliveryKind]}</p>
                    </Td>
                    <Td>
                      <StatusBadge map={CLAIM_STATUS} value={claim.status} />
                      {claim.revokeReason ? <p className="mt-0.5 max-w-[160px] truncate text-[10.5px] text-rose-700">{claim.revokeReason}</p> : null}
                    </Td>
                    <Td className="text-[11.5px] text-ink-500">
                      {claim.verificationMethod}
                      <p className="text-[10.5px] text-ink-400">IP {claim.ip ?? "—"}</p>
                    </Td>
                    <Td className="tabular-nums text-[12px] text-ink-600">{claim.deliveriesUsed}×</Td>
                    <Td className="text-right text-[12px] text-ink-400">{formatDateTime(claim.createdAt)}</Td>
                    <Td className="text-right">
                      {can("claim:write") && claim.status === "COMPLETED" ? (
                        <Button size="sm" variant="ghost" onClick={() => setRevoke(claim)} aria-label="Cabut akses">
                          <ShieldOff className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                    </Td>
                  </Tr>
                ))
              ) : null}
            </tbody>
          </TableShell>
          {claims.data ? <Pagination page={claims.data.page} pageSize={claims.data.pageSize} total={claims.data.total} onPage={setPage} /> : null}
        </SectionCard>
      ) : (
        <SectionCard title="Percobaan verifikasi" description="Setiap percobaan dicatat, berhasil maupun gagal, untuk mendeteksi penyalahgunaan.">
          <TableShell>
            <thead>
              <tr>
                <Th>Pesanan</Th>
                <Th>Metode</Th>
                <Th>Hasil</Th>
                <Th>Alasan</Th>
                <Th>IP</Th>
                <Th className="text-right">Waktu</Th>
              </tr>
            </thead>
            <tbody>
              {attempts.loading ? (
                <LoadingRows rows={6} cols={6} />
              ) : attempts.data && attempts.data.data.length > 0 ? (
                attempts.data.data.map((attempt) => (
                  <Tr key={attempt.id}>
                    <Td className="font-mono text-[12px] text-ink-700">{attempt.orderSn ?? "—"}</Td>
                    <Td className="text-[12px] text-ink-500">{attempt.method}</Td>
                    <Td>{attempt.success ? <Badge tone="success">berhasil</Badge> : <Badge tone="danger">gagal</Badge>}</Td>
                    <Td className="text-[12px] text-ink-500">{attempt.reason ?? "—"}</Td>
                    <Td className="font-mono text-[11px] text-ink-400">{attempt.ip ?? "—"}</Td>
                    <Td className="text-right text-[12px] text-ink-400">{formatDateTime(attempt.createdAt)}</Td>
                  </Tr>
                ))
              ) : null}
            </tbody>
          </TableShell>
          {attempts.data ? <Pagination page={attempts.data.page} pageSize={attempts.data.pageSize} total={attempts.data.total} onPage={setPage} /> : null}
        </SectionCard>
      )}

      <ConfirmDialog
        open={revoke !== null}
        onOpenChange={(open) => !open && setRevoke(null)}
        title="Cabut akses klaim?"
        description="Semua tautan unduhan dari klaim ini berhenti bekerja seketika."
        confirmLabel="Cabut akses"
        destructive
        loading={busy}
        onConfirm={() => void doRevoke()}
      >
        <div className="space-y-3">
          {revoke ? (
            <p className="rounded-lg bg-canvas px-3 py-2 text-[12.5px] text-ink-600 ring-1 ring-inset ring-line">
              {revoke.orderSn} · {revoke.productName}
            </p>
          ) : null}
          <Field label="Alasan" hint="tercatat di audit log">
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Contoh: pesanan dilaporkan dibatalkan" />
          </Field>
        </div>
      </ConfirmDialog>
    </>
  );
}
