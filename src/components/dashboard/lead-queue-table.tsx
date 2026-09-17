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
            <tr key={row.leadId} className="lead-row">
              <td data-label="Priority">
                <PriorityBadge band={row.priorityBand} />
                <div className="mono muted">{formatScore(row.totalScore)}</div>
              </td>
              <td data-label="Lead / customer">
                <Link href={`/leads/${row.leadId}`}>
                  <strong>{row.customerName}</strong>
                  <div className="muted mono">{row.leadId}</div>
                </Link>
              </td>
              <td data-label="Sales point">
                {row.salesPointId}
                <div className="muted">{row.companyId}</div>
              </td>
              <td data-label="Channel">{channelLabel(row.channel)}</td>
              <td data-label="Motorcycle">{row.motorcycle}</td>
              <td data-label="Age / SLA">
                {row.sla.ageLabel}
                <div className="muted">{row.sla.label}</div>
              </td>
              <td data-label="AI intent">{row.aiIntent ? purchaseIntentLabel(row.aiIntent) : "—"}</td>
              <td data-label="Advisor">{row.assignment.advisorName ?? "—"}</td>
              <td data-label="Assignment">{row.assignment.explanation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
