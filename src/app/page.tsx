import Link from "next/link";
import { LeadQueueTable } from "../components/dashboard/lead-queue-table";
import { EmptyState, ErrorState } from "../components/dashboard/states";
import { publicDashboardError } from "../lib/dashboard/errors";
import { prisma } from "../lib/db/client";
import { getOverview } from "../lib/dashboard/queries";
import { loadDashboardTenant } from "../lib/dashboard/session";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  try {
    const tenant = await loadDashboardTenant();
    if (!tenant.selected) {
      return (
        <EmptyState title="No companies yet">
          Run <code>bun run pipeline</code> to persist the synthetic dataset, then refresh.
        </EmptyState>
      );
    }

    const data = await getOverview(prisma, tenant.selected.id);
    const { kpis } = data;

    return (
      <>
        <header className="page-header">
          <h1>What needs attention now</h1>
          <p>
            {kpis.companyName} · business date {kpis.businessDate} · hybrid-v1 operational priority
            {data.latestPipeline ? ` · last pipeline ${data.latestPipeline.status}` : ""}
          </p>
        </header>
        <section className="kpis">
          <Link className="kpi" href="/leads">
            <div className="kpi-label">Eligible leads</div>
            <div className="kpi-value">{kpis.eligibleLeads}</div>
          </Link>
          <Link className="kpi" href="/leads?band=CRITICAL">
            <div className="kpi-label">CRITICAL</div>
            <div className="kpi-value">{kpis.criticalLeads}</div>
          </Link>
          <Link className="kpi" href="/leads?assignment=ASSIGNED">
            <div className="kpi-label">Assigned today</div>
            <div className="kpi-value">{kpis.assignedToday}</div>
          </Link>
          <Link className="kpi" href="/leads?assignment=WAITING">
            <div className="kpi-label">Waiting on capacity</div>
            <div className="kpi-value">{kpis.waitingDueToCapacity}</div>
          </Link>
          <div className="kpi">
            <div className="kpi-label">Active advisors</div>
            <div className="kpi-value">{kpis.activeAdvisors}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Daily capacity</div>
            <div className="kpi-value">{kpis.dailyCapacity}</div>
          </div>
        </section>
        <section className={`callout${kpis.saturatedPoolCount > 0 ? " saturated" : ""}`}>
          <strong>
            {kpis.saturatedPoolCount} of {kpis.poolCount} commercial pools currently saturated
          </strong>
          <p className="muted" style={{ margin: "0.35rem 0 0" }}>
            Eligible demand exceeds active daily capacity at those sales points. Inactive advisors
            are excluded.
          </p>
        </section>
        <section className="panel">
          <div className="score-hero">
            <div>
              <div className="eyebrow">Start here</div>
              <h2 style={{ margin: "0.2rem 0" }}>CRITICAL queue</h2>
            </div>
            <Link className="button secondary" href="/leads?band=CRITICAL">
              Open full queue
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
