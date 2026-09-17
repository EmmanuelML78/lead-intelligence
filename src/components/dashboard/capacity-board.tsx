import { formatPercent } from "../../lib/dashboard/present";
import type { CapacitySnapshot } from "../../lib/dashboard/capacity";

export function CapacityBoard({ snapshot }: { snapshot: CapacitySnapshot }) {
  if (snapshot.pools.length === 0) {
    return <div className="state">No sales points for this company.</div>;
  }

  return (
    <div className="pool-list">
      {snapshot.pools.map((pool) => (
        <section key={pool.salesPointId} className={`panel pool${pool.saturated ? " saturated" : ""}`}>
          <div className="score-hero">
            <div>
              <div className="eyebrow">{pool.saturated ? "Saturated pool" : "Sales point"}</div>
              <h2>{pool.salesPointId}</h2>
            </div>
            <div className="mono">{formatPercent(pool.utilization)} utilized</div>
          </div>
          <dl className="facts">
            <div>
              <dt>Eligible leads</dt>
              <dd>{pool.eligibleLeads}</dd>
            </div>
            <div>
              <dt>Active advisors</dt>
              <dd>{pool.activeAdvisors}</dd>
            </div>
            <div>
              <dt>Daily capacity</dt>
              <dd>{pool.dailyCapacity}</dd>
            </div>
            <div>
              <dt>Assigned / waiting</dt>
              <dd>
                {pool.assigned} / {pool.waiting}
              </dd>
            </div>
          </dl>
          <div className={`util-bar${pool.saturated ? " hot" : ""}`}>
            <span style={{ width: `${Math.min(100, Math.round((pool.utilization ?? 0) * 100))}%` }} />
          </div>
          {pool.advisors.length === 0 ? (
            <p className="muted">No active advisors at this sales point.</p>
          ) : (
            <div className="table-wrap advisor-table">
              <table className="data">
                <thead>
                  <tr>
                    <th>Advisor</th>
                    <th>Assigned today</th>
                    <th>Daily capacity</th>
                    <th>Utilization</th>
                  </tr>
                </thead>
                <tbody>
                  {pool.advisors.map((advisor) => (
                    <tr key={advisor.advisorId}>
                      <td data-label="Advisor">{advisor.name}</td>
                      <td data-label="Assigned today">{advisor.assignedToday}</td>
                      <td data-label="Daily capacity">{advisor.dailyCapacity}</td>
                      <td data-label="Utilization">{formatPercent(advisor.utilization)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
