import type { PriorityBand } from "@prisma/client";
import { bandClassName, priorityBandLabel } from "../../lib/dashboard/present";

export function PriorityBadge({ band }: { band: PriorityBand }) {
  return <span className={bandClassName(band)}>{priorityBandLabel(band)}</span>;
}
