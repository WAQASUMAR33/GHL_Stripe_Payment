/**
 * lib/db.js
 * ---------------------------------------------------------------------------
 * Prisma client singleton.
 * In development, reuse the client across hot-reloads to avoid exhausting
 * the MySQL connection pool.
 * ---------------------------------------------------------------------------
 */

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
