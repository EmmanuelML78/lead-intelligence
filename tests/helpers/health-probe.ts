/**
 * Calls the deployed health route handler in a fresh process and prints its
 * HTTP status and body as one JSON line. The process environment decides
 * which database the route sees, exactly as it does for a deployment.
 */
import { prisma } from "../../src/lib/db/client";
import { GET } from "../../src/app/api/health/route";

async function main() {
  const response = await GET();
  console.log(
    JSON.stringify({
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      body: await response.json()
    })
  );
}

main()
  .catch((error) => {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
