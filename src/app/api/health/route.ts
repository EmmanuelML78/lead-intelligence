import { prisma } from "../../../lib/db/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type HealthBody = {
  status: "ok" | "error";
  database: "reachable" | "unreachable";
};

function json(body: HealthBody, status: number) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return json({ status: "ok", database: "reachable" }, 200);
  } catch {
    return json({ status: "error", database: "unreachable" }, 503);
  }
}
