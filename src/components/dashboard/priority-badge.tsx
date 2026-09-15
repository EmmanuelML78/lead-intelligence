import type { PriorityBand } from "@prisma/client";
import { bandClassName } from "../../lib/dashboard/present";

export function PriorityBadge({ band }: { band: PriorityBand }) {
  return <span className={bandClassName(band)}>{band}</span>;
}
