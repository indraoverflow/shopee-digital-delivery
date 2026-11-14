import type { Metadata } from "next";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HelpArticle } from "./help-article";

/**
 * Server shell for the help article. It owns the page title, and it answers one question
 * the client cannot: whether a real Shopee screenshot has been dropped into
 * `public/bantuan/`. Checking here means the page never requests a missing image.
 */

export const metadata: Metadata = {
  title: "Cara melihat detail pesanan Shopee",
  description:
    "Di mana menemukan nomor pesanan, username, dan 4 digit terakhir nomor HP di aplikasi Shopee.",
};

const SHOTS = ["nomor-pesanan", "username", "nomor-hp"];

export default function HelpPage() {
  const dir = join(process.cwd(), "public", "bantuan");
  const screenshots = Object.fromEntries(
    SHOTS.map((id) => [id, existsSync(join(dir, `${id}.png`))]),
  );
  return <HelpArticle screenshots={screenshots} />;
}
