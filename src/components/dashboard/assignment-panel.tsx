import type { AssignmentView } from "../../lib/dashboard/present";

export function AssignmentPanel({ assignment }: { assignment: AssignmentView }) {
  return (
    <section className="panel">
      <div className="eyebrow">Carga de hoy</div>
      <h2>Asignación</h2>
      <dl className="facts">
        <div>
          <dt>Estado</dt>
          <dd>{assignment.label}</dd>
        </div>
        <div>
          <dt>Asesor</dt>
          <dd>{assignment.advisorName ?? "—"}</dd>
        </div>
        <div>
          <dt>Fecha de negocio</dt>
          <dd>{assignment.assignedFor ?? "—"}</dd>
        </div>
        <div>
          <dt>Motivo</dt>
          <dd>{assignment.explanation}</dd>
        </div>
      </dl>
    </section>
  );
}
