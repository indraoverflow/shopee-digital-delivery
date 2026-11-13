import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Serah Terima",
    template: "%s · Serah Terima",
  },
  description:
    "Klaim produk digital dari pesanan Shopee Anda dengan cepat dan aman.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
