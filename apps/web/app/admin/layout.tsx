import { AuthProvider } from "@/lib/auth";
import { AdminShell } from "@/components/admin/shell";
import { ToastProvider } from "@/components/ui";

export const metadata = { title: "Konsol" };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ToastProvider>
        <AdminShell>{children}</AdminShell>
      </ToastProvider>
    </AuthProvider>
  );
}
