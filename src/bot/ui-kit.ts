/**
 * ابزارهای ساخت پنل‌های زیبا و یکدست برای تلگرام.
 * تمام پنل‌ها از این توابع استفاده می‌کنند تا ظاهر یکسان داشته باشند.
 */

export { plainInput } from '../utils/validation'
export { fa, money, faDate } from '../utils/format'
import { fa } from '../utils/format'

export interface PanelRow {
  label: string
  value: string
}

export interface PanelSection {
  title?: string
  rows?: PanelRow[]
  lines?: string[]
}

/** نوار پیشرفت گرافیکی — ▰ پر / ▱ خالی (همان کاراکترِ تست‌شده) */
export function bar(percent: number, size = 10): string {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)))
  const filled = Math.round((clamped / 100) * size)
  return '▰'.repeat(filled) + '▱'.repeat(Math.max(0, size - filled))
}

/** نوار پیشرفت همراه با درصد — شامل نوار + درصدِ فارسی برای پنل‌های جدید */
export function barWithPercent(percent: number, size = 10): string {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)))
  return `${bar(clamped, size)}  ${fa(clamped)}٪`
}

/** نوار سلامت رنگی — روی bar می‌نشیند تا تستِ bar دست‌نخورده بماند */
export function healthBar(percent: number): string {
  const p = Math.min(100, Math.max(0, Math.round(percent)))
  const icon = p >= 80 ? '🟢' : p >= 50 ? '🟡' : p >= 25 ? '🟠' : '🔴'
  return `${icon} ${bar(p, 8)} ${fa(p)}٪`
}

export function fatigueBar(percent: number): string {
  const p = Math.min(100, Math.max(0, Math.round(percent)))
  const icon = p <= 20 ? '🟢' : p <= 50 ? '🟡' : p <= 80 ? '🟠' : '🔴'
  return `${icon} ${bar(p, 8)} ${fa(p)}٪`
}

/**
 * ساخت سطرهای «برچسب · مقدار».
 * از دنبالهٔ نقطه استفاده نمی‌شود؛ در تلگرام فونت غیر ثابت‌عرض است و
 * نقطه‌چین طولانی باعث شلوغی می‌شود.
 * ایموجیِ ابتدای برچسب حذف می‌شود (تستِ «row icon does not repeat»)
 */
/**
 * تاریخ و ساعتِ خوانا — برای پنل‌های مدیریتی که زمانِ "آخرین کار" مهم است.
 *
 * چرا در UI kit و نه محلی؟ پیش‌تر در هندلرِ استقرار بود و پنل‌های مدیریتیِ
 * تازه هم همان را لازم داشتند. دو قالبِ متفاوت برای یک مفهومِ یکسان، به‌زودی
 * دو رفتارِ متفاوت می‌سازد.
 */
export function momentFa(date: Date | null | undefined): string {
  if (!date) return '—'
  return date.toLocaleString('fa-IR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Tehran'
  })
}

export function table(rows: PanelRow[]): string[] {
  return rows.map(
    (row) =>
      `${row.label.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '')}: ${row.value}`
  )
}

/**
 * ساخت یک پنل کامل.
 *
 * چیدمان: عنوان → فاصلهٔ خالی → بخش‌ها → پانویس.
 * بدون کادر و خط تزئینی؛ از قالب‌بندی بومی تلگرام استفاده می‌شود.
 * عنوانِ همراهِ آیکن، ایموجیِ ابتدای title را حذف می‌کند (تستِ panel polishing)
 */
export function panel(options: {
  title: string
  icon?: string
  sections: PanelSection[]
  footer?: string
}): string {
  const title = options.icon
    ? options.title.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '')
    : options.title
  const heading = `${options.icon ? `${options.icon} ` : ''}*${title}*`
  const out: string[] = [heading]

  for (const section of options.sections) {
    const block: string[] = []
    if (section.title) {
      block.push(`*${section.title}*`)
    }
    if (section.rows && section.rows.length > 0) {
      block.push(...table(section.rows))
    }
    if (section.lines && section.lines.length > 0) {
      block.push(...section.lines)
    }
    if (block.length === 0) {
      continue
    }
    out.push('', ...block)
  }

  if (options.footer) {
    out.push('', options.footer)
  }

  return out.join('\n')
}

/** فهرست شماره‌دار فارسی. */
export function numbered(lines: string[], startFrom = 1): string[] {
  return lines.map((line, index) => `${fa(startFrom + index)}. ${line}`)
}

/** فهرست گلوله‌ای. */
export function bullets(lines: string[]): string[] {
  return lines.map((line) => `• ${line}`)
}

// ── افزوده‌های نمایش (بدون شکستن تست‌های موجود) ──────────────────────────

export const ICONS = {
  identity: '🪪',
  status: '📋',
  health: '❤️',
  fatigue: '⚡',
  experience: '⭐',
  education: '🎓',
  skill: '🎯',
  money: '💰',
  wallet: '💵',
  bank: '🏦',
  treasury: '🏛️',
  ledger: '📜',
  credit: '📈',
  debt: '📑',
  work: '💼',
  business: '🏢',
  factory: '🏭',
  job: '🧾',
  staff: '👥',
  branch: '🏬',
  housing: '🏠',
  home: '🏡',
  region: '🗺️',
  city: '🏙️',
  market: '🛒',
  family: '💞',
  pet: '🐾',
  friend: '💬',
  quest: '🎴',
  achievement: '🏅',
  leaderboard: '🏆',
  fortunes: '🎲',
  warning: '⚠️',
  success: '✅',
  error: '❌',
  info: '💡',
  empty: '📭',
  locked: '🔒',
} as const

/** خط جداسازِ ظریف — فقط برای مصرفِ دستی در پنل‌های سفارشی، داخل panel() استفاده نمی‌شود */
export const DIVIDER = '━━━━━━━━━━━━━━━━━━━━'

export function sectionTitle(icon: string, title: string): string {
  return `${icon} *${title}*`
}

export function kv(label: string, value: string): string {
  return `${label}: ${value}`
}

export function monoRow(cells: string[]): string {
  return '`' + cells.join(' │ ') + '`'
}

export function emptyState(icon: string, title: string, hint?: string): string {
  const lines = [`${icon} *${title}*`, '', 'چیزی برای نمایش نیست.']
  if (hint) lines.push('', hint)
  return lines.join('\n')
}

export function errorBlock(message: string, hint?: string): string {
  const lines = [`❌ ${message}`]
  if (hint) lines.push('', `💡 ${hint}`)
  return lines.join('\n')
}

export function successBlock(message: string, detail?: string): string {
  const lines = [`✅ ${message}`]
  if (detail) lines.push(detail)
  return lines.join('\n')
}

export function infoBox(lines: string[]): string {
  return lines.join('\n')
}

export function bulletPair(title: string, desc: string): string {
  return `▸ *${title}* — ${desc}`
}
