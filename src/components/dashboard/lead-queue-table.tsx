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
    return <div className="state">Ningún lead coincide con los filtros actuales.</div>;
  }

  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Prioridad</th>
            <th>Lead / cliente</th>
            <th>Punto de venta</th>
            <th>Canal</th>
            <th>Motocicleta</th>
            <th>Edad / SLA</th>
            <th>Intención IA</th>
            <th>Asesor</th>
            <th>Asignación</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.leadId} className="lead-row">
              <td data-label="Prioridad">
                <PriorityBadge band={row.priorityBand} />
                <div className="mono muted">{formatScore(row.totalScore)}</div>
              </td>
              <td data-label="Lead / cliente">
                <Link href={`/leads/${row.leadId}`}>
                  <strong>{row.customerName}</strong>
                  <div className="muted mono">{row.leadId}</div>
                </Link>
              </td>
              <td data-label="Punto de venta">
                {row.salesPointId}
                <div className="muted">{row.companyId}</div>
              </td>
              <td data-label="Canal">{channelLabel(row.channel)}</td>
              <td data-label="Motocicleta">{row.motorcycle}</td>
              <td data-label="Edad / SLA">
                {row.sla.ageLabel}
                <div className="muted">{row.sla.label}</div>
              </td>
              <td data-label="Intención IA">
                {row.aiIntent ? purchaseIntentLabel(row.aiIntent) : "—"}
              </td>
              <td data-label="Asesor">{row.assignment.advisorName ?? "—"}</td>
              <td data-label="Asignación">{row.assignment.explanation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
