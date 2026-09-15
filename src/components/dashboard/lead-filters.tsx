import type { LeadChannel, PriorityBand } from "@prisma/client";

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
    <form className="filters" method="get">
      <label className="field">
        Sales point
        <select name="salesPoint" defaultValue={current.salesPointId ?? ""}>
          <option value="">All</option>
          {salesPoints.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Priority
        <select name="band" defaultValue={current.priorityBand ?? ""}>
          <option value="">All</option>
          <option value="CRITICAL">CRITICAL</option>
          <option value="HIGH">HIGH</option>
          <option value="MEDIUM">MEDIUM</option>
          <option value="LOW">LOW</option>
        </select>
      </label>
      <label className="field">
        Assignment
        <select name="assignment" defaultValue={current.assignmentState ?? ""}>
          <option value="">All</option>
          <option value="ASSIGNED">Assigned</option>
          <option value="WAITING">Waiting</option>
          <option value="UNASSIGNED">Unassigned</option>
        </select>
      </label>
      <label className="field">
        Channel
        <select name="channel" defaultValue={current.channel ?? ""}>
          <option value="">All</option>
          <option value="WHATSAPP">WhatsApp</option>
          <option value="META_ADS">Meta Ads</option>
          <option value="WEB_FORM">Web form</option>
        </select>
      </label>
      <button type="submit">Apply</button>
    </form>
  );
}
