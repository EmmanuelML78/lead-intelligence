import Link from "next/link";
import { notFound } from "next/navigation";
import { AiExtractionPanel } from "../../../components/dashboard/ai-extraction-panel";
import { AssignmentPanel } from "../../../components/dashboard/assignment-panel";
import { ConversationThread } from "../../../components/dashboard/conversation-thread";
import { ScoreBreakdown } from "../../../components/dashboard/score-breakdown";
import { ErrorState } from "../../../components/dashboard/states";
import { publicDashboardError } from "../../../lib/dashboard/errors";
import { prisma } from "../../../lib/db/client";
import { channelLabel, statusLabel } from "../../../lib/dashboard/present";
import { getLeadDetail } from "../../../lib/dashboard/queries";
import { loadDashboardTenant } from "../../../lib/dashboard/session";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  let tenant: Awaited<ReturnType<typeof loadDashboardTenant>>;
  try {
    tenant = await loadDashboardTenant();
  } catch (error) {
    return <ErrorState message={publicDashboardError(error)} />;
  }
  if (!tenant.selected) notFound();

  let lead: Awaited<ReturnType<typeof getLeadDetail>>;
  try {
    const { id } = await params;
    lead = await getLeadDetail(prisma, tenant.selected.id, id);
  } catch (error) {
    return <ErrorState message={publicDashboardError(error)} />;
  }
  if (!lead) notFound();

  return (
    <>
      <header className="page-header">
        <Link className="back-link" href="/leads">
          Back to queue
        </Link>
        <h1>{lead.customerName}</h1>
        <p>
          {lead.leadId} · {lead.companyName} / {lead.salesPointId} · {channelLabel(lead.channel)}
        </p>
      </header>
      <section className="panel">
        <dl className="facts">
          <div>
            <dt>Status</dt>
            <dd>{statusLabel(lead.status)}</dd>
          </div>
          <div>
            <dt>Motorcycle</dt>
            <dd>{lead.motorcycle}</dd>
          </div>
          <div>
            <dt>Registered</dt>
            <dd>{lead.registeredAt ? new Date(lead.registeredAt).toLocaleString("en-CA") : "—"}</dd>
          </div>
          <div>
            <dt>First contact</dt>
            <dd>
              {lead.firstContactAt ? new Date(lead.firstContactAt).toLocaleString("en-CA") : "Not contacted"}
            </dd>
          </div>
          <div>
            <dt>SLA</dt>
            <dd>
              {lead.sla.ageLabel} · {lead.sla.label}
            </dd>
          </div>
        </dl>
      </section>
      {lead.score ? (
        <ScoreBreakdown score={lead.score} />
      ) : (
        <section className="panel">
          <h2>No current hybrid-v1 score</h2>
          <p className="muted">This lead has no valid current priority score.</p>
        </section>
      )}
      <div className="grid-2">
        <AiExtractionPanel extraction={lead.aiExtraction} />
        <AssignmentPanel assignment={lead.assignment} />
      </div>
      <ConversationThread messages={lead.conversation} />
    </>
  );
}
