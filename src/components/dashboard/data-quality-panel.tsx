import { FEATURED_ISSUE_TYPES } from "../../lib/dashboard/issues";
import { formatDashboardDateTime, issueTypeLabel, pipelineStatusLabel } from "../../lib/dashboard/present";
import type { DataQualityData } from "../../lib/dashboard/queries";

function durationLabel(durationMs: number | null): string {
  if (durationMs == null) return "—";
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function DataQualityPanel({ data }: { data: DataQualityData }) {
  const featured = FEATURED_ISSUE_TYPES.map((type) => ({
    type,
    count: data.issueCounts.find((row) => row.type === type)?.count ?? 0
  }));
  const extra = data.issueCounts.filter(
    (row) => !FEATURED_ISSUE_TYPES.includes(row.type as (typeof FEATURED_ISSUE_TYPES)[number])
  );

  return (
    <>
      <section className="panel">
        <div className="eyebrow">Última corrida del pipeline</div>
        {data.latestRun ? (
          <>
            <h2>{pipelineStatusLabel(data.latestRun.status)}</h2>
            <dl className="facts">
              <div>
                <dt>Leads persistidos</dt>
                <dd>{data.latestRun.leadsPersisted}</dd>
              </div>
              <div>
                <dt>Clientes</dt>
                <dd>{data.latestRun.customersPersisted}</dd>
              </div>
              <div>
                <dt>Conversaciones</dt>
                <dd>{data.latestRun.conversationsPersisted}</dd>
              </div>
              <div>
                <dt>Mensajes</dt>
                <dd>{data.latestRun.messagesPersisted}</dd>
              </div>
              <div>
                <dt>Inicio</dt>
                <dd>{formatDashboardDateTime(data.latestRun.startedAt)}</dd>
              </div>
              <div>
                <dt>Duración</dt>
                <dd>{durationLabel(data.latestRun.durationMs)}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="muted">Aún no hay corridas de pipeline. Ejecuta `bun run pipeline`.</p>
        )}
      </section>
      <section className="panel">
        <div className="eyebrow">Hallazgos únicos por tipo</div>
        <h2>Huellas de calidad de datos</h2>
        <p className="muted">
          Los conteos son filas distintas de hallazgo, no la suma de reobservaciones del pipeline.
        </p>
        <div className="issue-list">
          {featured.map((row) => (
            <div key={row.type} className="issue">
              <span>{issueTypeLabel(row.type)}</span>
              <strong className="mono">{row.count}</strong>
            </div>
          ))}
          {extra.map((row) => (
            <div key={row.type} className="issue">
              <span>{issueTypeLabel(row.type)}</span>
              <strong className="mono">{row.count}</strong>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
