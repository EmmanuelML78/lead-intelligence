import { FEATURED_ISSUE_TYPES } from "../../lib/dashboard/issues";
import { issueTypeLabel } from "../../lib/dashboard/present";
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
        <div className="eyebrow">Latest pipeline run</div>
        {data.latestRun ? (
          <>
            <h2>{data.latestRun.status}</h2>
            <dl className="facts">
              <div>
                <dt>Leads persisted</dt>
                <dd>{data.latestRun.leadsPersisted}</dd>
              </div>
              <div>
                <dt>Customers</dt>
                <dd>{data.latestRun.customersPersisted}</dd>
              </div>
              <div>
                <dt>Conversations</dt>
                <dd>{data.latestRun.conversationsPersisted}</dd>
              </div>
              <div>
                <dt>Messages</dt>
                <dd>{data.latestRun.messagesPersisted}</dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{new Date(data.latestRun.startedAt).toLocaleString("en-CA")}</dd>
              </div>
              <div>
                <dt>Run time</dt>
                <dd>{durationLabel(data.latestRun.durationMs)}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="muted">No pipeline runs recorded yet. Run `bun run pipeline`.</p>
        )}
      </section>
      <section className="panel">
        <div className="eyebrow">Unique issues by type</div>
        <h2>Data-quality fingerprints</h2>
        <p className="muted">
          Counts are distinct issue rows, not the sum of reobserved pipeline runs.
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
