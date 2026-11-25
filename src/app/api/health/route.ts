import { prisma } from "../../../lib/db/client";
import { createHealthChecker, prismaHealthProbes } from "../../../lib/health/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// One checker per server instance, so the schema inspection is cached
// across requests. See src/lib/health/health.ts.
const check = createHealthChecker(prismaHealthProbes(prisma));

/**
 * 200 when the database is reachable and has the schema this build needs.
 * 503 when it is unreachable, or reachable but missing migrations, tables,
 * columns or enum values the deployed code requires.
 */
export async function GET() {
  const { httpStatus, body } = await check();
  return Response.json(body, {
    status: httpStatus,
    headers: { "Cache-Control": "no-store" }
  });
}
