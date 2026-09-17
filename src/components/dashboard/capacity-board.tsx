import { formatPercent } from "../../lib/dashboard/present";
import type { CapacitySnapshot } from "../../lib/dashboard/capacity";

export function CapacityBoard({ snapshot }: { snapshot: CapacitySnapshot }) {
  if (snapshot.pools.length === 0) {
    return <div className="state">No hay puntos de venta para esta empresa.</div>;
  }

  return (
    <div className="pool-list">
      {snapshot.pools.map((pool) => (
        <section key={pool.salesPointId} className={`panel pool${pool.saturated ? " saturated" : ""}`}>
          <div className="score-hero">
            <div>
              <div className="eyebrow">{pool.saturated ? "Pool saturado" : "Punto de venta"}</div>
              <h2>{pool.salesPointId}</h2>
            </div>
            <div className="mono">{formatPercent(pool.utilization)} utilizado</div>
          </div>
          <dl className="facts">
            <div>
              <dt>Leads elegibles</dt>
              <dd>{pool.eligibleLeads}</dd>
            </div>
            <div>
              <dt>Asesores activos</dt>
              <dd>{pool.activeAdvisors}</dd>
            </div>
            <div>
              <dt>Capacidad diaria</dt>
              <dd>{pool.dailyCapacity}</dd>
            </div>
            <div>
              <dt>Asignados / en espera</dt>
              <dd>
                {pool.assigned} / {pool.waiting}
              </dd>
            </div>
          </dl>
          <div className={`util-bar${pool.saturated ? " hot" : ""}`}>
            <span style={{ width: `${Math.min(100, Math.round((pool.utilization ?? 0) * 100))}%` }} />
          </div>
          {pool.advisors.length === 0 ? (
            <p className="muted">No hay asesores activos en este punto de venta.</p>
          ) : (
            <div className="table-wrap advisor-table">
              <table className="data">
                <thead>
                  <tr>
                    <th>Asesor</th>
                    <th>Asignados hoy</th>
                    <th>Capacidad diaria</th>
                    <th>Utilización</th>
                  </tr>
                </thead>
                <tbody>
                  {pool.advisors.map((advisor) => (
                    <tr key={advisor.advisorId}>
                      <td data-label="Asesor">{advisor.name}</td>
                      <td data-label="Asignados hoy">{advisor.assignedToday}</td>
                      <td data-label="Capacidad diaria">{advisor.dailyCapacity}</td>
                      <td data-label="Utilización">{formatPercent(advisor.utilization)}</td>
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
