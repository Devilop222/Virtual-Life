import { prismaLogMessage, prismaLogSeverity } from '../src/database/prisma-log'

/**
 * لاگِ خطاهای دیتابیس باید صادق باشد: «تکراری نوشتنِ مهارشده» هشدار است و
 * هر چیز دیگری خطا. وگرنه لاگِ عملیاتی پر می‌شود از هشدارِ بی‌مورد و خطاهای
 * واقعی میانِ آن‌ها گم می‌شوند.
 */
describe('prisma log severity', () => {
  test('an idempotency refusal is a warning, not an error', () => {
    const uniqueViolation =
      '\nInvalid `this.db.bankAccount.create()` invocation:\nUnique constraint failed on the fields: (`player_id`)'

    expect(prismaLogSeverity(uniqueViolation)).toBe('warn')
    expect(
      prismaLogSeverity('P2002: Unique constraint failed on the fields: (`dedupe_key`)')
    ).toBe('warn')
  })

  test('every other database failure stays an error', () => {
    expect(
      prismaLogSeverity(
        'Foreign key constraint failed on the field: `marriages_player_a_id_fkey`'
      )
    ).toBe('error')
    expect(prismaLogSeverity('P2024: Timed out fetching a new connection string')).toBe('error')
    expect(
      prismaLogSeverity('An operation failed because it depends on one or more records')
    ).toBe('error')
    expect(prismaLogSeverity('')).toBe('error')
  })

  test('the log message says what really happened, without dev jargon', () => {
    expect(prismaLogMessage('warn')).toContain('duplicate write was refused')
    expect(prismaLogMessage('error')).toBe('prisma error')
  })
})
