import Link from "next/link";
import {
  channelLabel,
  formatScore,
  purchaseIntentLabel
} from "../../lib/dashboard/present";
import type { QueueLeadRow } from "../../lib/dashboard/queries";
import { PriorityBadge } from "./priority-badge";

export function LeadQueueTable({ rows }: { rows: QueueLeadRow[] }) {
  if (rows.length === 0) {
    return <div className="state">No leads match the current filters.</div>;
  }

  return (
    <>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Priority</th>
              <th>Lead / customer</th>
              <th>Sales point</th>
              <th>Channel</th>
              <th>Motorcycle</th>
              <th>Age / SLA</th>
              <th>AI intent</th>
              <th>Advisor</th>
              <th>Assignment</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.leadId}>
                <td>
                  <PriorityBadge band={row.priorityBand} />
                  <div className="mono muted">{formatScore(row.totalScore)}</div>
                </td>
                <td>
                  <Link href={`/leads/${row.leadId}`}>
                    <strong>{row.customerName}</strong>
                    <div className="muted">{row.leadId}</div>
                  </Link>
                </td>
                <td>
                  {row.salesPointId}
                  <div className="muted">{row.companyId}</div>
                </td>
                <td>{channelLabel(row.channel)}</td>
                <td>{row.motorcycle}</td>
                <td>
                  {row.sla.ageLabel}
                  <div className="muted">{row.sla.label}</div>
                </td>
                <td>{row.aiIntent ? purchaseIntentLabel(row.aiIntent) : "—"}</td>
                <td>{row.assignment.advisorName ?? "—"}</td>
                <td>{row.assignment.explanation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="lead-cards">
        {rows.map((row) => (
          <Link key={row.leadId} href={`/leads/${row.leadId}`} className="lead-card">
            <div>
              <PriorityBadge band={row.priorityBand} /> {formatScore(row.totalScore)}
            </div>
            <strong>{row.customerName}</strong>
            <div className="muted">
              {row.salesPointId} · {channelLabel(row.channel)} · {row.motorcycle}
            </div>
            <div>{row.assignment.explanation}</div>
          </Link>
        ))}
      </div>
    </>
  );
}
