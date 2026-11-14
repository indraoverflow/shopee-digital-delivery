/** Formatting and vocabulary shared by the console and the portal. */

export const formatRupiah = (
  value: string | number | null | undefined,
): string => {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric)) return "—";
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(numeric);
};

export const formatNumber = (value: number | null | undefined): string =>
  value === null || value === undefined
    ? "—"
    : new Intl.NumberFormat("id-ID").format(value);

export const formatDateTime = (
  value: string | Date | null | undefined,
): string => {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

export const formatDate = (value: string | Date | null | undefined): string => {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium" }).format(date);
};

export const relativeTime = (
  value: string | Date | null | undefined,
): string => {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  const diff = date.getTime() - Date.now();
  const minutes = Math.round(diff / 60_000);
  const formatter = new Intl.RelativeTimeFormat("id-ID", { numeric: "auto" });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
};

export const fileSize = (bytes: number | null | undefined): string => {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export type Tone =
  "neutral" | "success" | "warning" | "danger" | "info" | "brand";

export interface StateMeta {
  label: string;
  tone: Tone;
  description: string;
}

export const ORDER_STATE: Record<string, StateMeta> = {
  RECEIVED: {
    label: "Diterima",
    tone: "neutral",
    description: "Pesanan tersimpan, menunggu validasi",
  },
  VALIDATED: {
    label: "Dibayar",
    tone: "info",
    description: "Lunas, menunggu produk dipetakan",
  },
  FULFILLED: {
    label: "Siap klaim",
    tone: "success",
    description: "Produk digital bisa diambil pembeli",
  },
  CLAIMED: {
    label: "Diklaim",
    tone: "brand",
    description: "Pembeli sudah membuka produk",
  },
  COMPLETED: {
    label: "Selesai",
    tone: "success",
    description: "Semua item sudah diserahkan",
  },
  INELIGIBLE: {
    label: "Belum lunas",
    tone: "warning",
    description: "Pesanan belum memenuhi syarat",
  },
  CANCELLED: {
    label: "Dibatalkan",
    tone: "danger",
    description: "Dibatalkan atau dikembalikan",
  },
  EXPIRED: {
    label: "Kedaluwarsa",
    tone: "warning",
    description: "Masa klaim berakhir",
  },
  FAILED: { label: "Gagal", tone: "danger", description: "Pemrosesan gagal" },
};

export const FULFILLMENT_STATUS: Record<string, StateMeta> = {
  PENDING: {
    label: "Menunggu",
    tone: "neutral",
    description: "Belum siap diserahkan",
  },
  CLAIMABLE: {
    label: "Siap klaim",
    tone: "success",
    description: "Menunggu pembeli",
  },
  CLAIMED: {
    label: "Sudah diambil",
    tone: "brand",
    description: "Sudah diserahkan",
  },
  REVOKED: { label: "Dicabut", tone: "danger", description: "Akses dicabut" },
  EXPIRED: {
    label: "Kedaluwarsa",
    tone: "warning",
    description: "Lewat batas klaim",
  },
  FAILED: { label: "Gagal", tone: "danger", description: "Penyerahan gagal" },
};

export const CLAIM_STATUS: Record<string, StateMeta> = {
  ISSUED: { label: "Terbit", tone: "info", description: "Sesi klaim dibuat" },
  COMPLETED: {
    label: "Berhasil",
    tone: "success",
    description: "Produk sudah diserahkan",
  },
  REVOKED: {
    label: "Dicabut",
    tone: "danger",
    description: "Akses dicabut admin",
  },
  EXPIRED: {
    label: "Kedaluwarsa",
    tone: "warning",
    description: "Lewat batas waktu",
  },
  BLOCKED: {
    label: "Diblokir",
    tone: "danger",
    description: "Diblokir karena penyalahgunaan",
  },
};

export const DELIVERY_KIND: Record<string, string> = {
  DRIVE: "Google Drive",
  FILE: "Berkas unduhan",
  LINK: "Tautan eksternal",
  CODE: "Kode aktivasi",
  CREDENTIALS: "Kredensial akses",
  INSTRUCTIONS: "Instruksi digital",
};

export const JOB_STATUS: Record<string, StateMeta> = {
  QUEUED: { label: "Menunggu", tone: "neutral", description: "Dalam antrean" },
  RUNNING: { label: "Berjalan", tone: "info", description: "Sedang diproses" },
  SUCCEEDED: { label: "Sukses", tone: "success", description: "Selesai" },
  FAILED: {
    label: "Gagal",
    tone: "danger",
    description: "Gagal, akan dicoba lagi",
  },
  DEAD: {
    label: "Berhenti",
    tone: "danger",
    description: "Menyerah setelah beberapa percobaan",
  },
};

export const meta = (
  map: Record<string, StateMeta>,
  key: string | null | undefined,
): StateMeta =>
  (key && map[key]) || { label: key ?? "—", tone: "neutral", description: "" };

export const plural = (
  count: number,
  singular: string,
  pluralForm?: string,
): string =>
  `${formatNumber(count)} ${count === 1 ? singular : (pluralForm ?? singular)}`;

