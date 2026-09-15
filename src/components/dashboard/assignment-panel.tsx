import type { AssignmentView } from "../../lib/dashboard/present";

export function AssignmentPanel({ assignment }: { assignment: AssignmentView }) {
  return (
    <section className="panel">
      <div className="eyebrow">Today’s workload</div>
      <h2>Assignment</h2>
      <dl className="facts">
        <div>
          <dt>State</dt>
          <dd>{assignment.label}</dd>
        </div>
        <div>
          <dt>Advisor</dt>
          <dd>{assignment.advisorName ?? "—"}</dd>
        </div>
        <div>
          <dt>Business date</dt>
          <dd>{assignment.assignedFor ?? "—"}</dd>
        </div>
        <div>
          <dt>Why</dt>
          <dd>{assignment.explanation}</dd>
        </div>
      </dl>
    </section>
  );
}
