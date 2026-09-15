import type { UnassignedReasonCode } from "./types";
import { normalizedLoad } from "./load-balance";

export type AssignmentExplanationInput = {
  advisorId: string;
  companyId: string;
  salesPointId: string;
  assignedToday: number;
  dailyCapacity: number;
};

export function formatAssignedExplanation(input: AssignmentExplanationInput): string {
  const percent = Math.round(normalizedLoad(input.assignedToday, input.dailyCapacity) * 100);
  return (
    `Asignado a ${input.advisorId}: asesor activo de ${input.companyId}/${input.salesPointId}` +
    ` con ${percent}% de capacidad utilizada, menor carga normalizada entre los asesores elegibles.`
  );
}

export function formatUnassignedExplanation(
  reasonCode: UnassignedReasonCode,
  companyId: string,
  salesPointId: string
): string {
  switch (reasonCode) {
    case "NO_ACTIVE_ADVISOR":
      return `Sin asignar: no hay asesores activos en ${companyId}/${salesPointId}.`;
    case "CAPACITY_EXHAUSTED":
      return `Sin asignar: capacidad diaria agotada en ${companyId}/${salesPointId}.`;
    case "NO_ELIGIBLE_ADVISOR":
      return `Sin asignar: no hay asesores elegibles en ${companyId}/${salesPointId}.`;
  }
}
