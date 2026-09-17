import { formatPercent, formatScore } from "../../lib/dashboard/present";
import type { LeadDetail } from "../../lib/dashboard/queries";
import { PriorityBadge } from "./priority-badge";

export function ScoreBreakdown({ score }: { score: NonNullable<LeadDetail["score"]> }) {
  const total = score.components.reduce((sum, component) => sum + component.contribution, 0) || 1;

  return (
    <section className="panel">
      <div className="score-hero">
        <div>
          <div className="eyebrow">Priority</div>
          <div className="score-number mono">{formatScore(score.totalScore)}</div>
          <PriorityBadge band={score.priorityBand} />
          <div className="priority-disclaimer">Operational priority — not purchase probability</div>
        </div>
        <p className="muted score-lede">
          {score.summary || `${score.scoreVersion} hybrid score.`}
        </p>
      </div>
      <div className="score-stack" aria-hidden="true">
        {score.components.map((component) => (
          <span
            key={component.key}
            className={`stack-${component.key}`}
            style={{ width: `${(component.contribution / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="components">
        {score.components.map((component) => (
          <article key={component.key} className="component card">
            <h3>{component.title}</h3>
            <div className="mono">
              {formatScore(component.component)} × {component.weight}% = {formatScore(component.contribution)}
            </div>
            <div className="muted">Weighted contribution {formatPercent(component.contribution / 100)}</div>
            <p>{component.explanation}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
