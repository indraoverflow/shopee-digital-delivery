"use client";

import { useMemo, useState } from "react";
import { Check, ShieldQuestion, X } from "lucide-react";
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
  EmptyState,
  Field,
  Input,
  PageHeader,
  Pagination,
  Tabs,
  Textarea,
  useToast,
} from "@/components/ui";
import { formatDateTime, relativeTime } from "@/lib/format";

interface RequestRow {
  id: string;
  orderSn: string;
  orderState: string;
  shopeeStatus: string;
  buyerUsername: string | null;
  storeLabel: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  contact: string;
  note: string | null;
  ip: string | null;
  reviewer: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  approvedUntil: string | null;
  createdAt: string;
}

const STATUS_TONE: Record<
  RequestRow["status"],
  "warning" | "success" | "danger" | "neutral"
> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  EXPIRED: "neutral",
};

export default function VerificationsPage() {
  const { can } = useAuth();
  const { toast } = useToast();
  const [status, setStatus] = useState<
    "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED"
  >("PENDING");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<RequestRow | null>(null);
  const [note, setNote] = useState("");
  const [hours, setHours] = useState("24");
  const [busy, setBusy] = useState<"APPROVED" | "REJECTED" | null>(null);

  const query = useMemo(
    () =>
      new URLSearchParams({
        status,
        page: String(page),
        pageSize: "20",
      }).toString(),
    [status, page],
  );
  const { data, loading, error, refresh } = useApi<{
    data: RequestRow[];
    total: number;
    page: number;
    pageSize: number;
  }>(`/admin/claim-requests?${query}`);

  const decide = async (decision: "APPROVED" | "REJECTED") => {
    if (!selected) return;
    setBusy(decision);
    try {
      await api.post(`/admin/claim-requests/${selected.id}/review`, {
        decision,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(decision === "APPROVED" ? { hours: Number(hours) || 24 } : {}),
      });
      toast({
        title:
          decision === "APPROVED"
            ? "Verifikasi disetujui"
            : "Permintaan ditolak",
        description:
          decision === "APPROVED"
            ? `Pembeli bisa klaim dengan username selama ${hours} jam ke depan.`
            : "Pembeli tetap harus memenuhi verifikasi otomatis.",
        tone: decision === "APPROVED" ? "success" : "neutral",
      });
      setSelected(null);
      setNote("");
      refresh();
    } catch (caught) {
      toast({
        title: "Gagal menyimpan",
        description: caught instanceof ApiError ? caught.message : "Coba lagi.",
        tone: "danger",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Verifikasi manual"
        description="Pembeli yang tidak bisa memenuhi verifikasi otomatis dapat meminta pemeriksaan. Setujui hanya setelah Anda yakin orang itu pemilik pesanan."
      />

      <Tabs
        value={status}
        onValueChange={(value) => {
          setStatus(value as typeof status);
          setPage(1);
        }}
        tabs={[
          { value: "PENDING", label: "Menunggu" },
          { value: "APPROVED", label: "Disetujui" },
          { value: "REJECTED", label: "Ditolak" },
          { value: "EXPIRED", label: "Kedaluwarsa" },
        ]}
      />

      {error ? (
        <Alert tone="danger" title="Gagal memuat permintaan">
          {error.message}
        </Alert>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <SectionCard
          title={status === "PENDING" ? "Antrean" : "Riwayat"}
          description={data ? `${data.total} permintaan` : undefined}
        >
          <TableShell
            footer={
              data && data.total > data.pageSize ? (
                <Pagination
                  page={page}
                  pageSize={data.pageSize}
                  total={data.total}
                  onPage={setPage}
                />
              ) : undefined
            }
          >
            <thead>
              <tr>
                <Th>Pesanan</Th>
                <Th>Pembeli</Th>
                <Th>Kontak</Th>
                <Th>Diajukan</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {loading ? <LoadingRows cols={5} /> : null}
              {!loading && data?.data.length === 0 ? (
                <tr>
                  <Td colSpan={5}>
                    <EmptyState
                      icon={<ShieldQuestion className="h-5 w-5" />}
                      title="Tidak ada permintaan"
                      description={
                        status === "PENDING"
                          ? "Antrean bersih. Pembeli yang gagal verifikasi otomatis akan muncul di sini."
                          : "Belum ada riwayat pada status ini."
                      }
                    />
                  </Td>
                </tr>
              ) : null}
              {data?.data.map((row) => (
                <Tr
                  key={row.id}
                  onClick={() => setSelected(row)}
                  className={
                    selected?.id === row.id ? "bg-brand-50/60" : undefined
                  }
                >
                  <Td>
                    <span className="font-mono text-[12px] text-ink-900">
                      {row.orderSn}
                    </span>
                    <p className="mt-0.5 text-[11px] text-ink-400">
                      {row.storeLabel}
                    </p>
                  </Td>
                  <Td>
                    <span className="text-[12.5px] text-ink-800">
                      {row.buyerUsername ?? "-"}
                    </span>
                    <p className="text-[11px] text-ink-400">{row.orderState}</p>
                  </Td>
                  <Td>
                    <span className="text-[12.5px] text-ink-700">
                      {row.contact}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-[12px] text-ink-600">
                      {formatDateTime(row.createdAt)}
                    </span>
                    <p className="text-[11px] text-ink-400">
                      {relativeTime(row.createdAt)}
                    </p>
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[row.status]} dot>
                      {row.status}
                    </Badge>
                    {row.approvedUntil && row.status === "APPROVED" ? (
                      <p className="mt-1 text-[11px] text-ink-400">
                        s/d {formatDateTime(row.approvedUntil)}
                      </p>
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableShell>
        </SectionCard>

        <SectionCard
          title="Keputusan"
          description={selected ? selected.orderSn : "Pilih satu permintaan"}
        >
          {!selected ? (
            <p className="text-[12.5px] leading-relaxed text-ink-500">
              Pilih baris di kiri untuk melihat detail kontak dan memberi
              keputusan. Setiap keputusan tercatat di audit log.
            </p>
          ) : (
            <div className="space-y-3">
              <dl className="space-y-1.5 text-[12.5px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-500">Pesanan</dt>
                  <dd className="font-mono text-ink-900">{selected.orderSn}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-500">Pembeli</dt>
                  <dd className="text-ink-900">
                    {selected.buyerUsername ?? "-"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-500">Status Shopee</dt>
                  <dd className="text-ink-900">{selected.shopeeStatus}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-500">IP</dt>
                  <dd className="font-mono text-ink-700">
                    {selected.ip ?? "-"}
                  </dd>
                </div>
              </dl>

              {selected.note ? (
                <div className="rounded-lg bg-canvas p-3 text-[12.5px] leading-relaxed text-ink-700 ring-1 ring-inset ring-line">
                  {selected.note}
                </div>
              ) : null}

              {selected.status === "PENDING" && can("claim:write") ? (
                <>
                  <Field
                    label="Berlaku (jam)"
                    htmlFor="hours"
                    hint="Jendela klaim setelah disetujui"
                  >
                    <Input
                      id="hours"
                      type="number"
                      min={1}
                      max={168}
                      value={hours}
                      onChange={(event) => setHours(event.target.value)}
                    />
                  </Field>
                  <Field
                    label="Catatan pemeriksaan"
                    htmlFor="review-note"
                    hint="Apa yang Anda cek, misalnya chat Shopee"
                  >
                    <Textarea
                      id="review-note"
                      rows={3}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="Sudah cocok dengan chat pembeli di Shopee"
                    />
                  </Field>
                  <div className="flex gap-2">
                    <Button
                      className="flex-1"
                      loading={busy === "APPROVED"}
                      onClick={() => void decide("APPROVED")}
                    >
                      <Check className="h-4 w-4" /> Setujui
                    </Button>
                    <Button
                      variant="secondary"
                      className="flex-1"
                      loading={busy === "REJECTED"}
                      onClick={() => void decide("REJECTED")}
                    >
                      <X className="h-4 w-4" /> Tolak
                    </Button>
                  </div>
                </>
              ) : (
                <div className="rounded-lg bg-canvas p-3 text-[12px] text-ink-600 ring-1 ring-inset ring-line">
                  {selected.status === "PENDING"
                    ? "Role Anda hanya bisa melihat permintaan."
                    : `Diputuskan oleh ${selected.reviewer ?? "sistem"} pada ${selected.reviewedAt ? formatDateTime(selected.reviewedAt) : "-"}${
                        selected.reviewNote ? `: ${selected.reviewNote}` : ""
                      }`}
                </div>
              )}
            </div>
          )}
        </SectionCard>
      </div>
    </>
  );
}
