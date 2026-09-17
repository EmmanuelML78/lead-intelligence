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
        <EmptyState title="Aún no hay empresas">
          Ejecuta <code>bun run pipeline</code> antes de abrir la cola.
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
          <h1>Cola priorizada de leads</h1>
          <p>
            Puntaje hybrid-v1 vigente, aislado por empresa. Atiende primero la mayor prioridad
            operativa.
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
          Mostrando {from}–{to} de {data.total} · {data.businessDate}
        </p>
        <LeadQueueTable rows={data.rows} />
        {data.total > data.pageSize ? (
          <nav className="pager" aria-label="Páginas de la cola">
            {data.page > 1 ? (
              <a className="button secondary" href={pageHref(params, data.page - 1)}>
                Anterior
              </a>
            ) : null}
            {data.page * data.pageSize < data.total ? (
              <a className="button secondary" href={pageHref(params, data.page + 1)}>
                Siguiente
              </a>
            ) : null}
          </nav>
        ) : null}
      </>
    );
  } catch (error) {
    return <ErrorState message={publicDashboardError(error)} />;
  }
}
