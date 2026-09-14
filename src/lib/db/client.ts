import { PrismaClient } from "@prisma/client";

// Standard Next.js/Bun-friendly singleton so hot reload and repeated
// `bun run pipeline` invocations within the same process don't open a new
// connection pool every time.
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient = globalThis.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}
