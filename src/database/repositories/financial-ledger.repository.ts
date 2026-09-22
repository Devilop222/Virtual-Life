import { PrismaClient, TransactionType, FinancialTransaction } from '@prisma/client'

export interface RecordTransactionInput {
  amount: number
  type: TransactionType
  reference?: string
  sourcePlayerId?: string
  destinationPlayerId?: string
  sourceBusinessId?: string
  destinationBusinessId?: string
}

export class FinancialLedgerRepository {
  constructor(private readonly db: PrismaClient) {}

  async record(input: RecordTransactionInput): Promise<FinancialTransaction> {
    return this.db.financialTransaction.create({
      data: {
        amount: input.amount,
        type: input.type,
        reference: input.reference,
        sourcePlayerId: input.sourcePlayerId,
        destinationPlayerId: input.destinationPlayerId,
        sourceBusinessId: input.sourceBusinessId,
        destinationBusinessId: input.destinationBusinessId
      }
    })
  }

  async listPlayerTransactions(playerId: string, limit = 20): Promise<FinancialTransaction[]> {
    return this.db.financialTransaction.findMany({
      where: {
        OR: [{ sourcePlayerId: playerId }, { destinationPlayerId: playerId }]
      },
      take: limit,
      orderBy: { createdAt: 'desc' }
    })
  }

  async listBusinessTransactions(businessId: string, limit = 20): Promise<FinancialTransaction[]> {
    return this.db.financialTransaction.findMany({
      where: {
        OR: [{ sourceBusinessId: businessId }, { destinationBusinessId: businessId }]
      },
      take: limit,
      orderBy: { createdAt: 'desc' }
    })
  }
}