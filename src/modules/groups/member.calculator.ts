export interface TelegramUserLike {
  id: number
  is_bot: boolean
}

export function countNonBots(users: readonly TelegramUserLike[]): number {
  return users.reduce((acc, u) => acc + (u.is_bot ? 0 : 1), 0)
}

export function computeRealMemberCount(
  totalCount: number,
  adminBotsCount: number
): number {
  const adjusted = totalCount - adminBotsCount
  return Math.max(0, adjusted)
}