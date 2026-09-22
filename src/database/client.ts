import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { logger } from '../utils/logger'
import { prismaLogMessage, prismaLogSeverity } from './prisma-log'

declare global {
  var __prisma: PrismaClient | undefined
}

/**
 * اتصال به PostgreSQL از طریق driver adapter (pg) — بدون نیاز به موتور باینری
 * Prisma برای هر پلتفرم؛ کلاینت با موتور WASM کار می‌کند و روی x64 و arm64
 * بدون هیچ دانلود اضافی اجرا می‌شود.
 */
function createPgAdapter() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to create the database adapter')
  }
  return new PrismaPg({ connectionString })
}

export function createPrismaClient(): PrismaClient {
  // خطاهای Prisma در همهٔ محیط‌ها به‌صورت رویداد گرفته می‌شوند تا از همان
  // لاگرِ ساختاریافتهٔ برنامه رد شوند (نه stdout خامِ خودِ Prisma).
  const log: Array<{ emit: 'event'; level: 'query' | 'error' }> = [
    { emit: 'event', level: 'error' }
  ]
  if (process.env.NODE_ENV !== 'production') {
    log.unshift({ emit: 'event', level: 'query' })
  }

  const client = new PrismaClient({ adapter: createPgAdapter(), log })

  if (process.env.NODE_ENV !== 'production') {
    client.$on('query', (e: { query: string; duration: number }) => {
      logger.debug({ query: e.query, duration: e.duration }, 'prisma query')
    })
  }

  client.$on('error', (e: { message: string }) => {
    const fields = { prismaError: e.message }
    if (prismaLogSeverity(e.message) === 'warn') {
      logger.warn(fields, prismaLogMessage('warn'))
    } else {
      logger.error(fields, prismaLogMessage('error'))
    }
  })

  return client
}

export const prisma: PrismaClient = global.__prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma
}