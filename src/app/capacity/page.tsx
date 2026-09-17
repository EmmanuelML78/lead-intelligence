import { CapacityBoard } from "../../components/dashboard/capacity-board";
import { EmptyState, ErrorState } from "../../components/dashboard/states";
import { publicDashboardError } from "../../lib/dashboard/errors";
import { prisma } from "../../lib/db/client";
import { getCapacity } from "../../lib/dashboard/queries";
import { loadDashboardTenant } from "../../lib/dashboard/session";

export const dynamic = "force-dynamic";

export default async function CapacityPage() {
  try {
    const tenant = await loadDashboardTenant();
    if (!tenant.selected) {
      return (
        <EmptyState title="Aún no hay empresas">
          Ejecuta <code>bun run pipeline</code> para persistir asesores y asignaciones.
        </EmptyState>
      );
    }

    const data = await getCapacity(prisma, tenant.selected.id);

    return (
      <>
        <header className="page-header">
          <h1>Capacidad comercial</h1>
          <p>
            {data.snapshot.saturatedPoolCount} de {data.snapshot.poolCount} pools saturados ·{" "}
            {data.businessDate}. Los asesores inactivos no cuentan en la capacidad disponible.
          </p>
        </header>
        <section className="kpis">
          <div className="kpi">
            <div className="kpi-label">Elegibles</div>
            <div className="kpi-value">{data.snapshot.eligibleLeads}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Asignados</div>
            <div className="kpi-value">{data.snapshot.assigned}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">En espera</div>
            <div className="kpi-value">{data.snapshot.waiting}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Asesores activos</div>
            <div className="kpi-value">{data.snapshot.activeAdvisors}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Capacidad diaria</div>
            <div className="kpi-value">{data.snapshot.dailyCapacity}</div>
          </div>
        </section>
        <CapacityBoard snapshot={data.snapshot} />
      </>
    );
  } catch (error) {
    return <ErrorState message={publicDashboardError(error)} />;
  }
}
