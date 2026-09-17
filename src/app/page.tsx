import Link from "next/link";
import { LeadQueueTable } from "../components/dashboard/lead-queue-table";
import { EmptyState, ErrorState } from "../components/dashboard/states";
import { publicDashboardError } from "../lib/dashboard/errors";
import { prisma } from "../lib/db/client";
import { getOverview } from "../lib/dashboard/queries";
import { loadDashboardTenant } from "../lib/dashboard/session";
import { pipelineStatusLabel } from "../lib/dashboard/present";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  try {
    const tenant = await loadDashboardTenant();
    if (!tenant.selected) {
      return (
        <EmptyState title="Aún no hay empresas">
          Ejecuta <code>bun run pipeline</code> para persistir el dataset sintético y recarga.
        </EmptyState>
      );
    }

    const data = await getOverview(prisma, tenant.selected.id);
    const { kpis } = data;

    return (
      <>
        <header className="page-header">
          <h1>Qué hay que atender ahora</h1>
          <p>
            {kpis.companyName} · fecha de negocio {kpis.businessDate} · prioridad operativa hybrid-v1
            {data.latestPipeline ? ` · último pipeline ${pipelineStatusLabel(data.latestPipeline.status)}` : ""}
          </p>
        </header>
        <section className="kpis">
          <Link className="kpi" href="/leads">
            <div className="kpi-label">Leads elegibles</div>
            <div className="kpi-value">{kpis.eligibleLeads}</div>
          </Link>
          <Link className="kpi" href="/leads?band=CRITICAL">
            <div className="kpi-label">Críticos</div>
            <div className="kpi-value">{kpis.criticalLeads}</div>
          </Link>
          <Link className="kpi" href="/leads?assignment=ASSIGNED">
            <div className="kpi-label">Asignados hoy</div>
            <div className="kpi-value">{kpis.assignedToday}</div>
          </Link>
          <Link className="kpi" href="/leads?assignment=WAITING">
            <div className="kpi-label">En espera de capacidad</div>
            <div className="kpi-value">{kpis.waitingDueToCapacity}</div>
          </Link>
          <div className="kpi">
            <div className="kpi-label">Asesores activos</div>
            <div className="kpi-value">{kpis.activeAdvisors}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Capacidad diaria</div>
            <div className="kpi-value">{kpis.dailyCapacity}</div>
          </div>
        </section>
        <section className={`callout${kpis.saturatedPoolCount > 0 ? " saturated" : ""}`}>
          <strong>
            {kpis.saturatedPoolCount} de {kpis.poolCount} pools comerciales saturados ahora
          </strong>
          <p className="muted">
            La demanda elegible supera la capacidad diaria activa en esos puntos de venta. Los
            asesores inactivos no cuentan.
          </p>
        </section>
        <section className="panel">
          <div className="score-hero">
            <div>
              <div className="eyebrow">Empieza aquí</div>
              <h2>Cola crítica</h2>
            </div>
            <Link className="button secondary" href="/leads?band=CRITICAL">
              Abrir cola completa
            </Link>
          </div>
          <LeadQueueTable rows={data.attentionLeads} />
        </section>
      </>
    );
  } catch (error) {
    return <ErrorState message={publicDashboardError(error)} />;
  }
}
