import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { CompanySelector } from "../components/dashboard/company-selector";
import { DashboardNav } from "../components/dashboard/nav";
import { ErrorState } from "../components/dashboard/states";
import { loadDashboardTenant } from "../lib/dashboard/session";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Lead Intelligence",
  description: "Operational priority for motorcycle dealership commercial teams"
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  let tenantError: string | null = null;
  let companies: Awaited<ReturnType<typeof loadDashboardTenant>>["companies"] = [];
  let selected: Awaited<ReturnType<typeof loadDashboardTenant>>["selected"] = null;

  try {
    const tenant = await loadDashboardTenant();
    companies = tenant.companies;
    selected = tenant.selected;
  } catch (error) {
    tenantError = error instanceof Error ? error.message : "Database unavailable.";
  }

  return (
    <html lang="en">
      <body className={inter.className}>
        <div className="app-shell">
          <aside className="sidebar">
            <div className="brand">
              Lead Intelligence
              <small>Operational priority</small>
            </div>
            <DashboardNav />
          </aside>
          <div className="main">
            <DashboardNav variant="mobile" />
            <header className="topbar">
              {selected && companies.length > 0 ? (
                <CompanySelector companies={companies} selectedId={selected.id} />
              ) : (
                <span className="muted">No company context</span>
              )}
              <p className="demo-note">
                Demo tenant selector — not production authentication. Synthetic dataset, no real PII.
              </p>
            </header>
            <main className="content">
              {tenantError ? <ErrorState message={tenantError} /> : children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
