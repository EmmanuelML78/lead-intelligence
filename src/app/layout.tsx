import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import { CompanySelector } from "../components/dashboard/company-selector";
import { DashboardNav } from "../components/dashboard/nav";
import { ErrorState } from "../components/dashboard/states";
import { publicDashboardError } from "../lib/dashboard/errors";
import { loadDashboardTenant } from "../lib/dashboard/session";
import "./globals.css";

const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap"
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap"
});

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lead Intelligence",
  description: "Prioridad operativa para equipos comerciales de concesionarios de motos"
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#1e252e"
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
    tenantError = publicDashboardError(error);
  }

  return (
    <html lang="es" className={`${archivo.variable} ${plexMono.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Saltar al contenido
        </a>
        <div className="app-shell">
          <aside className="sidebar">
            <div className="brand">
              <span className="plate" aria-hidden="true">
                LI-01
              </span>
              <div>
                <strong>Lead Intelligence</strong>
                <small>Despacho comercial</small>
              </div>
            </div>
            <DashboardNav />
          </aside>
          <div className="main">
            <DashboardNav variant="top" />
            <header className="topbar">
              <div className="brand brand-compact">
                <span className="plate" aria-hidden="true">
                  LI-01
                </span>
                <strong>Lead Intelligence</strong>
              </div>
              {selected && companies.length > 0 ? (
                <CompanySelector companies={companies} selectedId={selected.id} />
              ) : (
                <span className="muted">Sin empresa seleccionada</span>
              )}
              <p className="demo-note">
                Selector de empresa de demostración — no es autenticación de producción. Datos sintéticos, sin PII real.
              </p>
            </header>
            <main id="main" className="content">
              {tenantError ? <ErrorState message={tenantError} /> : children}
            </main>
            <DashboardNav variant="bottom" />
          </div>
        </div>
      </body>
    </html>
  );
}
