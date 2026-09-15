import { CapacityBoard } from "../../components/dashboard/capacity-board";
import { EmptyState, ErrorState } from "../../components/dashboard/states";
import { prisma } from "../../lib/db/client";
import { getCapacity } from "../../lib/dashboard/queries";
import { loadDashboardTenant } from "../../lib/dashboard/session";

export const dynamic = "force-dynamic";

export default async function CapacityPage() {
  try {
    const tenant = await loadDashboardTenant();
    if (!tenant.selected) {
      return (
        <EmptyState title="No companies yet">
          Run <code>bun run pipeline</code> to persist advisors and assignments.
        </EmptyState>
      );
    }

    const data = await getCapacity(prisma, tenant.selected.id);

    return (
      <>
        <header className="page-header">
          <h1>Commercial capacity</h1>
          <p>
            {data.snapshot.saturatedPoolCount} of {data.snapshot.poolCount} pools saturated ·{" "}
            {data.businessDate}. Inactive advisors are excluded from available capacity.
          </p>
        </header>
        <section className="kpis">
          <div className="kpi">
            <div className="kpi-label">Eligible</div>
            <div className="kpi-value">{data.snapshot.eligibleLeads}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Assigned</div>
            <div className="kpi-value">{data.snapshot.assigned}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Waiting</div>
            <div className="kpi-value">{data.snapshot.waiting}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Active advisors</div>
            <div className="kpi-value">{data.snapshot.activeAdvisors}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Daily capacity</div>
            <div className="kpi-value">{data.snapshot.dailyCapacity}</div>
          </div>
        </section>
        <CapacityBoard snapshot={data.snapshot} />
      </>
    );
  } catch (error) {
    return <ErrorState message={error instanceof Error ? error.message : "Database unavailable."} />;
  }
}
