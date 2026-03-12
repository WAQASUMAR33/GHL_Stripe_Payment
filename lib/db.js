/**
 * lib/db.js
 * ---------------------------------------------------------------------------
 * Prisma client singleton — lazy-initialized so the build phase never
 * throws when DATABASE_URL is not yet available.
 * ---------------------------------------------------------------------------
 */

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis;

export function getPrisma() {
  if (!globalForPrisma._prisma) {
    globalForPrisma._prisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    });
  }
  return globalForPrisma._prisma;
}
