import { pino } from 'pino'
import { config } from '../config/env'

const isProduction = config.NODE_ENV === 'production'

export const logger = pino({
  level: config.LOG_LEVEL,
  base: {
    env: config.NODE_ENV
  },
  redact: {
    paths: [
      '*.token',
      '*.password',
      '*.secret',
      'req.headers.authorization'
    ],
    censor: '[REDACTED]'
  },
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname'
        }
      }
})