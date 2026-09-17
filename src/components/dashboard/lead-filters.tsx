import type { LeadChannel, PriorityBand } from "@prisma/client";
import { channelLabel, priorityBandLabel } from "../../lib/dashboard/present";

export function LeadFilters({
  salesPoints,
  current
}: {
  salesPoints: string[];
  current: {
    salesPointId?: string;
    priorityBand?: PriorityBand;
    assignmentState?: string;
    channel?: LeadChannel;
  };
}) {
  return (
    <form className="filters panel" method="get">
      <label className="field">
        Punto de venta
        <select name="salesPoint" defaultValue={current.salesPointId ?? ""}>
          <option value="">Todos</option>
          {salesPoints.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Prioridad
        <select name="band" defaultValue={current.priorityBand ?? ""}>
          <option value="">Todas</option>
          <option value="CRITICAL">{priorityBandLabel("CRITICAL")}</option>
          <option value="HIGH">{priorityBandLabel("HIGH")}</option>
          <option value="MEDIUM">{priorityBandLabel("MEDIUM")}</option>
          <option value="LOW">{priorityBandLabel("LOW")}</option>
        </select>
      </label>
      <label className="field">
        Asignación
        <select name="assignment" defaultValue={current.assignmentState ?? ""}>
          <option value="">Todas</option>
          <option value="ASSIGNED">Asignado</option>
          <option value="WAITING">En espera</option>
          <option value="UNASSIGNED">Sin asignar</option>
        </select>
      </label>
      <label className="field">
        Canal
        <select name="channel" defaultValue={current.channel ?? ""}>
          <option value="">Todos</option>
          <option value="WHATSAPP">{channelLabel("WHATSAPP")}</option>
          <option value="META_ADS">{channelLabel("META_ADS")}</option>
          <option value="WEB_FORM">{channelLabel("WEB_FORM")}</option>
        </select>
      </label>
      <button type="submit">Aplicar</button>
    </form>
  );
}
