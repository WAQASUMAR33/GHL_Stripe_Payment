/**
 * lib/db.js
 * ---------------------------------------------------------------------------
 * Prisma client singleton — uses a dynamic import so @prisma/client is
 * NEVER loaded during Next.js build-time route analysis (the build worker
 * would crash trying to bundle the platform-specific native query engine).
 * The PrismaClient is only instantiated on the first real request.
 * ---------------------------------------------------------------------------
 */

export async function getPrisma() {
  if (!globalThis._prisma) {
    const { PrismaClient } = await import('@prisma/client');
    globalThis._prisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    });
  }
  return globalThis._prisma;
}
