/**
 * پروندهٔ وضعیتِ عملیاتِ عملیاتی (بکاپ/بازیابی).
 *
 * ## چرا فایل و نه فقط پیام؟
 * بازیابی، ربات را **خاموش و دوباره روشن** می‌کند. پیامی که در تلگرام می‌ماند
 * نمی‌تواند بگوید آخرین کار چگونه تمام شد، چون رباتی که آن را می‌فرستاد وسطِ
 * کار مرده است. پروندهٔ وضعیت روی دیسک می‌ماند و پس از بالا آمدن دوباره، پنلِ
 * مالک آن را می‌خواند و واقعیت را می‌گوید.
 *
 * ## قراردادِ مشترک با bash
 * `offline-deps/install.sh` هم همین فایل را می‌نویسد — چون وقتی ربات بالا
 * نیاید، *او* تنها کسی است که می‌داند. برای اینکه دو زبان یک قالب بنویسند و
 * خطای نقل‌قولِ شل قالب را نشکند، bash مقادیر را از **متغیر محیطی** می‌خواند
 * (`OPS_PHASE`, `OPS_MESSAGE`, `OPS_BACKUP_ID`, `OPS_ACTOR_ID`) و هیچ‌وقت
 * رشته‌ای را داخل کد جا نمی‌گذارد. تغییرِ نامِ هر کلید یعنی شکستنِ bash.
 *
 * هیچ رازی در این فایل نوشته نمی‌شود: نه توکن، نه `DATABASE_URL`، نه مسیرِ
 * حساس. فقط شناسهٔ عملیات، فاز، زمان و پیامِ انسانی.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { logger } from '../../utils/logger'
import { toolsDir } from './ops-lock'

export type OpsPhase = 'idle' | 'running' | 'success' | 'failed'
export type OpsOperation = 'backup' | 'restore'

export interface OpsOperationState {
  phase: OpsPhase
  operation: OpsOperation | null
  startedAt: string | null
  finishedAt: string | null
  message: string | null
  backupId: string | null
  actorId: string | null
}

export function emptyOpsState(): OpsOperationState {
  return {
    phase: 'idle',
    operation: null,
    startedAt: null,
    finishedAt: null,
    message: null,
    backupId: null,
    actorId: null
  }
}

export class OpsStateFile {
  constructor(private readonly path: string) {}

  static defaultPath(repoRoot: string): string {
    return join(toolsDir(repoRoot), 'ops.state.json')
  }

  filePath(): string {
    return this.path
  }

  read(): OpsOperationState {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<OpsOperationState>
      return { ...emptyOpsState(), ...parsed }
    } catch {
      return emptyOpsState()
    }
  }

  write(state: OpsOperationState): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(state, null, 2))
    } catch (error) {
      logger.warn({ err: error }, 'could not write ops state')
    }
  }
}
