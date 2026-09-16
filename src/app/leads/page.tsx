import type { LeadChannel, PriorityBand } from "@prisma/client";
import { LeadFilters } from "../../components/dashboard/lead-filters";
import { LeadQueueTable } from "../../components/dashboard/lead-queue-table";
import { EmptyState, ErrorState } from "../../components/dashboard/states";
import { publicDashboardError } from "../../lib/dashboard/errors";
import { prisma } from "../../lib/db/client";
import { listLeadQueue } from "../../lib/dashboard/queries";
import { loadDashboardTenant } from "../../lib/dashboard/session";

export const dynamic = "force-dynamic";

const BANDS = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
const ASSIGNMENT_STATES = new Set(["ASSIGNED", "WAITING", "UNASSIGNED"]);
const CHANNELS = new Set(["WHATSAPP", "META_ADS", "WEB_FORM", "UNKNOWN"]);

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function pageHref(
  params: Record<string, string | string[] | undefined>,
  page: number
): string {
  const query = new URLSearchParams();
  for (const key of ["salesPoint", "band", "assignment", "channel"] as const) {
    const value = first(params[key]);
    if (value) query.set(key, value);
  }
  if (page > 1) query.set("page", String(page));
  const encoded = query.toString();
  return encoded ? `/leads?${encoded}` : "/leads";
}

export default async function LeadsPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    const tenant = await loadDashboardTenant();
    if (!tenant.selected) {
      return (
        <EmptyState title="No companies yet">
          Run <code>bun run pipeline</code> before opening the queue.
        </EmptyState>
      );
    }

    const params = await searchParams;
    const band = first(params.band);
    const assignment = first(params.assignment);
    const channel = first(params.channel);
    const pageValue = Number(first(params.page) ?? "1");
    const data = await listLeadQueue(prisma, tenant.selected.id, {
      salesPointId: first(params.salesPoint) || undefined,
      priorityBand: band && BANDS.has(band) ? (band as PriorityBand) : undefined,
      assignmentState:
        assignment && ASSIGNMENT_STATES.has(assignment)
          ? (assignment as "ASSIGNED" | "WAITING" | "UNASSIGNED")
          : undefined,
      channel: channel && CHANNELS.has(channel) ? (channel as LeadChannel) : undefined,
      page: Number.isFinite(pageValue) ? pageValue : 1
    });

    const from = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
    const to = Math.min(data.total, data.page * data.pageSize);

    return (
      <>
        <header className="page-header">
          <h1>Prioritized lead queue</h1>
          <p>
            Current valid hybrid-v1 score, company-scoped. Work the highest operational priority
            first.
          </p>
        </header>
        <LeadFilters
          salesPoints={data.salesPoints}
          current={{
            salesPointId: first(params.salesPoint),
            priorityBand: band && BANDS.has(band) ? (band as PriorityBand) : undefined,
            assignmentState: assignment,
            channel: channel && CHANNELS.has(channel) ? (channel as LeadChannel) : undefined
          }}
        />
        <p className="muted">
          Showing {from}–{to} of {data.total} · {data.businessDate}
        </p>
        <LeadQueueTable rows={data.rows} />
        {data.total > data.pageSize ? (
          <p className="muted">
            {data.page > 1 ? <a href={pageHref(params, data.page - 1)}>Previous</a> : null}
            {data.page > 1 && data.page * data.pageSize < data.total ? " · " : ""}
            {data.page * data.pageSize < data.total ? (
              <a href={pageHref(params, data.page + 1)}>Next</a>
            ) : null}
          </p>
        ) : null}
      </>
    );
  } catch (error) {
    return <ErrorState message={publicDashboardError(error)} />;
  }
}
