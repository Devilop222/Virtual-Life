import { createServer, Server } from 'node:http'
import { config } from '../config/env'
import { prisma } from '../database/client'

/** نتیجهٔ بررسی دیتابیس برای «degraded» نبودنِ بی‌دلیل کشیده می‌شود. */
const DB_PROBE_TTL_MS = 5_000
let dbHealthy = true
let dbProbedAt = 0

async function isDatabaseUp(): Promise<boolean> {
  if (Date.now() - dbProbedAt < DB_PROBE_TTL_MS) {
    return dbHealthy
  }
  try {
    await prisma.$queryRaw`SELECT 1`
    dbHealthy = true
  } catch {
    dbHealthy = false
  }
  dbProbedAt = Date.now()
  return dbHealthy
}

export function startHealthServer(): Server {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === config.HEALTH_PATH) {
      void isDatabaseUp().then((up) => {
        res.writeHead(up ? 200 : 503, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            status: up ? 'ok' : 'degraded',
            database: up ? 'up' : 'down',
            uptime: process.uptime()
          })
        )
      })
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'not_found' }))
  })

  return server
}
