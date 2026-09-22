import {
  Prisma,
  PrismaClient,
  Business,
  BusinessCategory,
  BusinessStatus,
  BusinessEmployee,
  JobPosting,
  JobPostingStatus,
  JobApplication,
  JobApplicationStatus,
  DegreeLevel,
  TransactionType
} from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import {
  minutesSince,
  remainingContractMinutes,
  salaryAnchorAt,
  salaryMinutes
} from '../../modules/occupation/payroll-math'
import { gameMonthStart, ratePerGameMinute } from '../../utils/game-time'
import { creditedMinutesOf, completedShifts } from '../../modules/occupation/work-minutes'
import {
  BUSINESS_BLUEPRINTS,
  MAX_ACTIVE_BUSINESSES_PER_OWNER
} from '../../modules/occupation/work-blueprints'
import { TaxService } from '../../modules/economy/tax.service'

export interface CreateBusinessInput {
  ownerId: string
  name: string
  category: BusinessCategory
  modelType: string
  startupCost: number
  employeeCapacity: number
  baseRevenuePerMinute: number
  operatingCostPerMinute: number
}

export interface CreateJobPostingInput {
  businessId: string
  title: string
  salaryPerMinute: number
  /** حجمِ قراردادِ ماهانه (دقیقهٔ بازی در ماهِ بازی) — به استخدام منتقل می‌شود. */
  contractMinutesPerMonth: number
  capacity: number
  minExperience: number
  minAge: number | null
  maxAge: number | null
  requiredDegree: DegreeLevel
  requiredSkill: string | null
  requiredField: string | null
}

export type BusinessWithRelations = Prisma.BusinessGetPayload<{
  include: {
    owner: true
    employees: { include: { player: true } }
    jobPostings: true
  }
}>

export type JobPostingWithBusiness = JobPosting & { business: Business }

/** حداکثر تعداد آگهی بازِ هر کسب‌وکار (ضد آگهی‌باران بی‌هدف). */
const MAX_OPEN_POSTINGS = 6

export class BusinessRepository {
  constructor(private readonly db: PrismaClient) {}

  async findById(id: string): Promise<BusinessWithRelations | null> {
    return this.db.business.findUnique({
      where: { id },
      include: { owner: true, employees: { include: { player: true } }, jobPostings: true }
    })
  }

  async listByOwner(ownerId: string): Promise<BusinessWithRelations[]> {
    return this.db.business.findMany({
      where: { ownerId, status: BusinessStatus.ACTIVE },
      include: { owner: true, employees: { include: { player: true } }, jobPostings: true }
    })
  }

  async countActiveByOwner(ownerId: string): Promise<number> {
    return this.db.business.count({
      where: { ownerId, status: BusinessStatus.ACTIVE }
    })
  }

  async createBusinessWithStartupCost(input: CreateBusinessInput): Promise<Business> {
    return this.db.$transaction(async (tx) => {
      // سقف کسب‌وکار فعال، داخل همان تراکنش: دو درخواست همزمان نمی‌توانند
      // با هم از سقف رد شوند (شمارش و تأسیس یک تراکنش‌اند).
      const activeCount = await tx.business.count({
        where: { ownerId: input.ownerId, status: BusinessStatus.ACTIVE }
      })
      if (activeCount >= MAX_ACTIVE_BUSINESSES_PER_OWNER) {
        throw new ConflictError(
          'Business limit reached',
          `هر بازیکن فقط تا ${MAX_ACTIVE_BUSINESSES_PER_OWNER} کسب‌وکارِ فعال می‌تواند داشته باشد؛ یکی را تعطیل کن.`
        )
      }

      // کسر شرطی سرمایه: محافظت از Double-Spend در تأسیس همزمان
      const debited = await tx.player.updateMany({
        where: { id: input.ownerId, balance: { gte: input.startupCost } },
        data: { balance: { decrement: input.startupCost } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient balance for startup cost',
          'سرمایه‌ات برای راه‌اندازی این کسب‌وکار کافی نیست.'
        )
      }

      const business = await tx.business.create({
        data: {
          ownerId: input.ownerId,
          name: input.name,
          category: input.category,
          modelType: input.modelType,
          employeeCapacity: input.employeeCapacity,
          baseRevenuePerMinute: input.baseRevenuePerMinute,
          operatingCostPerMinute: input.operatingCostPerMinute,
          treasury: 0,
          activeEmployees: 0,
          status: BusinessStatus.ACTIVE
        }
      })

      await tx.financialTransaction.create({
        data: {
          amount: input.startupCost,
          type: TransactionType.STARTUP_COST,
          sourcePlayerId: input.ownerId,
          destinationBusinessId: business.id,
          reference: `ایجاد کسب‌وکار: ${input.name}`
        }
      })

      return business
    })
  }

  // ---------- آگهی استخدام ----------

  async createJobPosting(input: CreateJobPostingInput): Promise<JobPosting> {
    return this.db.$transaction(async (tx) => {
      // سقف آگهی‌های باز هر کسب‌وکار
      const openCount = await tx.jobPosting.count({
        where: { businessId: input.businessId, status: JobPostingStatus.OPEN }
      })
      if (openCount >= MAX_OPEN_POSTINGS) {
        throw new ConflictError(
          'Too many open postings',
          `حداکثر ${MAX_OPEN_POSTINGS} آگهی باز می‌توانی همزمان داشته باشی.`
        )
      }

      return tx.jobPosting.create({
        data: {
          businessId: input.businessId,
          title: input.title,
          salaryPerMinute: input.salaryPerMinute,
          contractMinutesPerMonth: input.contractMinutesPerMonth,
          capacity: input.capacity,
          minExperience: input.minExperience,
          minAge: input.minAge,
          maxAge: input.maxAge,
          requiredDegree: input.requiredDegree,
          requiredSkill: input.requiredSkill,
          requiredField: input.requiredField,
          status: JobPostingStatus.OPEN
        }
      })
    })
  }

  /**
   * آگهی‌های باز، صفحه‌بندی‌شده.
   * آگهیِ پر‌شده با پذیرشِ آخر خودکار بسته می‌شود؛ فیلترِ دفاعی هم اگر
   * رقیقی از قبل پر شده باشد، نمایشش نمی‌دهد.
   */
  async listOpenJobPostings(
    page = 1,
    pageSize = 10
  ): Promise<{ postings: JobPostingWithBusiness[]; total: number; page: number; pages: number }> {
    const where: Prisma.JobPostingWhereInput = {
      status: JobPostingStatus.OPEN,
      business: { status: BusinessStatus.ACTIVE }
    }
    const [rows, total] = await Promise.all([
      this.db.jobPosting.findMany({
        where,
        include: { business: true },
        orderBy: { createdAt: 'desc' },
        take: pageSize,
        skip: (Math.max(1, page) - 1) * pageSize
      }),
      this.db.jobPosting.count({ where })
    ])
    return {
      postings: rows.filter((p) => p.hiredCount < p.capacity),
      total,
      page: Math.max(1, page),
      pages: Math.max(1, Math.ceil(total / pageSize))
    }
  }

  async getJobPosting(id: string): Promise<JobPostingWithBusiness | null> {
    return this.db.jobPosting.findUnique({
      where: { id },
      include: { business: true }
    })
  }

  /** بستن آگهی توسط مالک (هر وضعیتی به CLOSED می‌رود، حتی پر‌شده). */
  async closeJobPosting(businessId: string, postingId: string): Promise<void> {
    const closed = await this.db.jobPosting.updateMany({
      where: { id: postingId, businessId, status: JobPostingStatus.OPEN },
      // بستنِ دستی ثبت می‌شود تا با خالی‌شدنِ صندلی خودکار باز نشود
      data: { status: JobPostingStatus.CLOSED, closedByOwner: true }
    })
    if (closed.count !== 1) {
      throw new ConflictError('Posting not open', 'این آگهی باز نیست یا مالکیت تو نیست.')
    }
  }

  /** آگهی‌های بازِ یک کسب‌وکار — برای پنل مدیریت مالک. */
  async listOpenPostingsForBusiness(businessId: string): Promise<
    (JobPosting & {
      _count: { applications: number }
    })[]
  > {
    return this.db.jobPosting.findMany({
      where: { businessId, status: JobPostingStatus.OPEN },
      include: { _count: { select: { applications: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10
    })
  }

  // ---------- درخواست‌ها ----------

  async applyForJob(jobPostingId: string, playerId: string): Promise<JobApplication> {
    try {
      return await this.db.jobApplication.create({
        data: { jobPostingId, playerId, status: JobApplicationStatus.PENDING }
      })
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictError('Already applied', 'برای این آگهی قبلاً درخواست داده‌ای.')
      }
      throw error
    }
  }

  async listApplicationsForBusiness(businessId: string): Promise<
    (JobApplication & {
      player: { firstName: string; lastName: string | null; id: string }
      jobPosting: JobPosting
    })[]
  > {
    return this.db.jobApplication.findMany({
      where: {
        jobPosting: { businessId },
        status: JobApplicationStatus.PENDING
      },
      include: {
        player: { select: { id: true, firstName: true, lastName: true } },
        jobPosting: true
      },
      orderBy: { createdAt: 'desc' },
      take: 30
    })
  }

  /** درخواست‌های بازِ خودِ بازیکن (برای پیگیری/انصراف). */
  async listMyOpenApplications(playerId: string): Promise<
    (JobApplication & { jobPosting: JobPostingWithBusiness })[]
  > {
    return this.db.jobApplication.findMany({
      where: { playerId, status: JobApplicationStatus.PENDING },
      include: { jobPosting: { include: { business: true } } },
      orderBy: { createdAt: 'desc' },
      take: 30
    })
  }

  /** وضعیت درخواستِ بازیکن روی یک آگهی (برای نمایش «درخواست داده‌ای»). */
  async findApplicationStatus(
    playerId: string,
    jobPostingId: string
  ): Promise<JobApplicationStatus | null> {
    const application = await this.db.jobApplication.findFirst({
      where: { playerId, jobPostingId },
      select: { status: true }
    })
    return application?.status ?? null
  }

  /** انصراف بازیکن از درخواستِ در انتظار پاسخ. */
  async withdrawApplication(playerId: string, applicationId: string): Promise<void> {
    const updated = await this.db.jobApplication.updateMany({
      where: { id: applicationId, playerId, status: JobApplicationStatus.PENDING },
      data: { status: JobApplicationStatus.CANCELLED }
    })
    if (updated.count !== 1) {
      throw new ConflictError('Cannot withdraw', 'این درخواست قابل انصراف نیست.')
    }
  }

  /** پروفایل خلاصه برای بازسنجی شرایط در لحظهٔ پذیرش. */
  async findPlayerProfile(playerId: string): Promise<{
    age: number
    startedAt: Date | null
    experience: number
    currentDegree: string
    status: string
  } | null> {
    const player = await this.db.player.findUnique({
      where: { id: playerId },
      select: { age: true, startedAt: true, experience: true, currentDegree: true, status: true }
    })
    if (!player) {
      return null
    }
    if (player.status !== 'ACTIVE') {
      return null
    }
    return {
      age: player.age,
      startedAt: player.startedAt,
      experience: player.experience,
      currentDegree: player.currentDegree,
      status: player.status
    }
  }

  async findApplicationWithBusiness(
    applicationId: string
  ): Promise<(JobApplication & { jobPosting: JobPosting & { business: Business } }) | null> {
    return this.db.jobApplication.findUnique({
      where: { id: applicationId },
      include: {
        jobPosting: { include: { business: true } }
      }
    })
  }

  /** رد درخواست توسط مالک. */
  async rejectApplication(ownerPlayerId: string, applicationId: string): Promise<void> {
    const application = await this.db.jobApplication.findUnique({
      where: { id: applicationId },
      include: { jobPosting: { select: { businessId: true } } }
    })
    if (!application) {
      throw new NotFoundError('Application not found', 'درخواست موردنظر یافت نشد. فهرست درخواست‌ها را به‌روزرسانی کن.')
    }
    const business = await this.db.business.findFirst({
      where: { id: application.jobPosting.businessId, ownerId: ownerPlayerId }
    })
    if (!business) {
      throw new ConflictError('Access denied', 'این کسب‌وکار متعلق به تو نیست. از «کسب‌وکار» شرکت خودت را انتخاب کن.')
    }
    const updated = await this.db.jobApplication.updateMany({
      where: { id: applicationId, status: JobApplicationStatus.PENDING },
      data: { status: JobApplicationStatus.REJECTED }
    })
    if (updated.count !== 1) {
      throw new ConflictError('Application handled', 'این درخواست پیش‌تر بررسی شده است.')
    }
  }

  /**
   * استخدام قطعی — تمام گاردها در یک تراکنش و با قفل‌های شرطی:
   *  • ظرفیت آگهی (hiredCount < capacity) و ظرفیت کسب‌وکار (activeEmployees < employeeCapacity)
   *    هر دو با «شرط داخل UPDATE» افزایش می‌یابند، نه با خواندنِ قبلی — پس دو
   *    پذیرش همزمان نمی‌توانند ظرفیت را سوراخ کنند.
   *  • اگر کارمند جای دیگری استخدام فعال داشته باشد، پذیرش رد می‌شود.
   *  • درخواست‌های بازِ دیگرِ همان بازیکن خودکار بسته می‌شوند.
   */
  /**
   * دادهٔ تماسِ یک درخواست استخدام — برای اینکه بتوان به متقاضی خبر داد.
   * جدا از خودِ عملیات خوانده می‌شود تا امضای `hireEmployee`/`rejectApplication`
   * عوض نشود و اعلان فقط یک خواندنِ اضافه باشد.
   */
  async findApplicationNotice(
    applicationId: string
  ): Promise<{
    applicantPlayerId: string
    applicantTelegramUserId: bigint
    applicantName: string
    businessName: string
    title: string
    salaryPerMinute: number
  } | null> {
    const application = await this.db.jobApplication.findUnique({
      where: { id: applicationId },
      include: {
        player: { select: { id: true, telegramUserId: true, firstName: true, lastName: true } },
        jobPosting: {
          select: {
            title: true,
            salaryPerMinute: true,
            business: { select: { name: true } }
          }
        }
      }
    })
    if (!application) return null
    return {
      applicantPlayerId: application.player.id,
      applicantTelegramUserId: application.player.telegramUserId,
      applicantName: `${application.player.firstName} ${application.player.lastName ?? ''}`.trim(),
      businessName: application.jobPosting.business.name,
      title: application.jobPosting.title,
      salaryPerMinute: Number(application.jobPosting.salaryPerMinute)
    }
  }

  /** دادهٔ تماسِ یک کارمندِ فعال — برای خبر دادن به او هنگامِ اخراج. */
  async findEmployeeNotice(
    businessId: string,
    employeePlayerId: string
  ): Promise<{
    employeeTelegramUserId: bigint
    employeeName: string
    businessName: string
    title: string
  } | null> {
    const employment = await this.db.businessEmployee.findFirst({
      where: { businessId, playerId: employeePlayerId, isActive: true },
      include: {
        player: { select: { telegramUserId: true, firstName: true, lastName: true } },
        business: { select: { name: true } }
      }
    })
    if (!employment) return null
    return {
      employeeTelegramUserId: employment.player.telegramUserId,
      employeeName: `${employment.player.firstName} ${employment.player.lastName ?? ''}`.trim(),
      businessName: employment.business.name,
      title: employment.title
    }
  }

  async hireEmployee(
    applicationId: string,
    ownerPlayerId: string
  ): Promise<BusinessEmployee> {
    return this.db.$transaction(async (tx) => {
      const app = await tx.jobApplication.findUnique({
        where: { id: applicationId },
        include: { jobPosting: { include: { business: true } } }
      })
      if (!app) {
        throw new NotFoundError('Application not found', 'درخواست موردنظر یافت نشد. فهرست درخواست‌ها را به‌روزرسانی کن.')
      }
      if (app.status !== JobApplicationStatus.PENDING) {
        throw new ConflictError('Application handled', 'این درخواست پیش‌تر بررسی شده است.')
      }
      const posting = app.jobPosting
      const business = posting.business
      if (business.ownerId !== ownerPlayerId) {
        throw new ConflictError('Access denied', 'این کسب‌وکار متعلق به تو نیست. از «کسب‌وکار» شرکت خودت را انتخاب کن.')
      }
      if (business.status !== BusinessStatus.ACTIVE) {
        throw new ConflictError('Business not active', 'این کسب‌وکار فعال نیست.')
      }
      if (posting.status !== JobPostingStatus.OPEN) {
        throw new ConflictError('Posting closed', 'این آگهی دیگر باز نیست. از بخش «کار» فرصت‌های استخدام فعلی را ببین.')
      }

      // تک‌اشغالی: یک بازیکن همزمان فقط یک شغل کارمندی دارد
      const alreadyEmployed = await tx.businessEmployee.count({
        where: { playerId: app.playerId, isActive: true }
      })
      if (alreadyEmployed > 0) {
        throw new ConflictError(
          'Already employed',
          'این بازیکن هم‌اکنون جای دیگری استخدام فعال دارد.'
        )
      }

      // قفل ظرفیت آگهی
      const seatTaken = await tx.jobPosting.updateMany({
        where: { id: posting.id, status: JobPostingStatus.OPEN, hiredCount: { lt: posting.capacity } },
        data: { hiredCount: { increment: 1 } }
      })
      if (seatTaken.count !== 1) {
        await tx.jobApplication.update({
          where: { id: applicationId },
          data: { status: JobApplicationStatus.REJECTED }
        })
        throw new ConflictError('Posting full', 'ظرفیت این آگهی پر شده است.')
      }
      // آگهی پر شد؟ همان‌جا ببند تا در فهرست نماند.
      // شرط روی hiredCountِ تازه (نه مقدار خوانده‌شدهٔ اولیه) نوشته می‌شود
      // تا پذیرشِ همزمانِ آخرین جای خالی، هرگز «باز» نبیند.
      await tx.jobPosting.updateMany({
        where: {
          id: posting.id,
          status: JobPostingStatus.OPEN,
          hiredCount: { gte: posting.capacity }
        },
        data: { status: JobPostingStatus.CLOSED }
      })

      // قفل ظرفیت کسب‌وکار (شمارندهٔ قطعی)
      const capTaken = await tx.business.updateMany({
        where: { id: business.id, activeEmployees: { lt: business.employeeCapacity } },
        data: { activeEmployees: { increment: 1 } }
      })
      if (capTaken.count !== 1) {
        throw new ConflictError(
          'Business capacity full',
          `ظرفیت کارمندان «${business.name}» پر است؛ اول ارتقا بده یا نیرو آزاد کن.`
        )
      }

      const employment = await tx.businessEmployee.upsert({
        where: { businessId_playerId: { businessId: business.id, playerId: app.playerId } },
        create: {
          businessId: business.id,
          playerId: app.playerId,
          title: posting.title,
          salaryPerMinute: posting.salaryPerMinute,
          // قرارداد از خودِ آگهی می‌آید: همان حجمی که کارفرما آگهی کرده است
          contractMinutesPerMonth: posting.contractMinutesPerMonth,
          isActive: true,
          jobPostingId: posting.id
        },
        update: {
          title: posting.title,
          salaryPerMinute: posting.salaryPerMinute,
          contractMinutesPerMonth: posting.contractMinutesPerMonth,
          isActive: true,
          jobPostingId: posting.id,
          hiredAt: new Date(),
          paidUntilAt: new Date()
        }
      })

      await tx.jobApplication.update({
        where: { id: applicationId },
        data: { status: JobApplicationStatus.ACCEPTED }
      })
      // سایر درخواست‌های بازِ این بازیکن خودکار بسته می‌شوند
      await tx.jobApplication.updateMany({
        where: { playerId: app.playerId, status: JobApplicationStatus.PENDING, id: { not: applicationId } },
        data: { status: JobApplicationStatus.REJECTED }
      })

      return employment
    })
  }

  /**
   * جدایی کارمند (استعفا یا اخراج) با تسویهٔ همان‌لحظه‌ایِ بدهیِ حقوق.
   * پرداخت از خزانه با شرط gte انجام می‌شود؛ کسری به‌عنوان بدهی می‌ماند و در
   * تسویهٔ کلِ بعدی جبران می‌شود. لنگر paidUntilAt جلوی پرداخت دوباره را می‌گیرد.
   */
  private async settleSeparation(
    tx: Prisma.TransactionClient,
    employment: BusinessEmployee & {
      business: Pick<Business, 'id' | 'name' | 'treasury' | 'lastPayrollAt'>
    },
    reason: string
  ): Promise<{ paid: number; unpaid: number }> {
    const business = employment.business
    const anchor = salaryAnchorAt(business.lastPayrollAt, {
      hiredAt: employment.hiredAt,
      paidUntilAt: employment.paidUntilAt
    })
    // دستمزدِ جدایی فقط برای کارکردی است که واقعاً ثبت شده — نه برای زمانی که
    // از استخدام گذشته. کارکرد از همان شیفت‌های FULL_TIME این کسب‌وکار می‌آید
    // که تسویهٔ کل هم از آن می‌خواند، پس دو مسیر هرگز دو عدد نمی‌دهند.
    const shifts = await completedShifts(tx, business.id, anchor)
    const workedMinutes = creditedMinutesOf(shifts, employment.playerId, anchor)
    // جدایی هم از سقفِ ماهانهٔ قرارداد آزاد نیست: وگرنه کارمندی که حجم ماه را
    // پر کرده بود با استعفا دوباره دستمزد می‌گرفت و سقف دور زده می‌شد.
    const monthStart = gameMonthStart()
    const priorMonthMinutes =
      anchor > monthStart
        ? creditedMinutesOf(
            await completedShifts(tx, business.id, monthStart, anchor),
            employment.playerId,
            monthStart
          )
        : 0
    // نرخ ذخیره‌شده «در دقیقهٔ واقعی» است و کارکرد «دقیقهٔ بازی»؛ ترجمه از
    // ساعت مرکزی بازی می‌آید تا دستمزد جدا در زمان واقعی ثابت بماند.
    const owed =
      Math.round(
        ratePerGameMinute(Number(employment.salaryPerMinute)) *
          Math.min(
            workedMinutes,
            salaryMinutes(minutesSince(anchor)),
            remainingContractMinutes(employment.contractMinutesPerMonth, priorMonthMinutes)
          )
      ) + Math.max(0, Number(employment.unpaidSalary))
    const payable = Math.min(owed, Math.max(0, Math.round(Number(business.treasury))))
    const unpaid = owed - payable

    if (payable > 0) {
      const funded = await tx.business.updateMany({
        where: { id: business.id, treasury: { gte: payable } },
        data: { treasury: { decrement: payable } }
      })
      if (funded.count !== 1) {
        throw new ConflictError('Treasury changed', 'خزانه همین حالا تغییر کرد؛ دوباره تلاش کن.')
      }
      await tx.player.update({
        where: { id: employment.playerId },
        data: { balance: { increment: payable } }
      })
      await tx.financialTransaction.create({
        data: {
          amount: payable,
          type: TransactionType.SALARY_PAYMENT,
          sourceBusinessId: business.id,
          destinationPlayerId: employment.playerId,
          reference: `حقوق معوق هنگام ${reason}`
        }
      })
    }

    // آزادکردنِ صندلیِ آگهی. پیش از این `hiredCount` فقط زیاد می‌شد، پس
    // پس از هر جدایی یک صندلی برای همیشه سوخت می‌شد و آگهیِ پُر هم بسته
    // می‌ماند؛ کارفرما ناچار بود برای هر نیروی تازه آگهیِ تازه بزند.
    if (employment.jobPostingId) {
      await tx.jobPosting.updateMany({
        where: { id: employment.jobPostingId, hiredCount: { gt: 0 } },
        data: { hiredCount: { decrement: 1 } }
      })
      const posting = await tx.jobPosting.findUnique({
        where: { id: employment.jobPostingId },
        select: { id: true, status: true, closedByOwner: true, hiredCount: true, capacity: true }
      })
      // فقط بسته‌شدنِ خودکار (پُرشدنِ ظرفیت) برگشت‌پذیر است؛ آگهی‌ای که
      // خودِ کارفرما بسته دست‌نخورده می‌ماند.
      if (
        posting &&
        posting.status === JobPostingStatus.CLOSED &&
        !posting.closedByOwner &&
        posting.hiredCount < posting.capacity
      ) {
        await tx.jobPosting.update({
          where: { id: posting.id },
          data: { status: JobPostingStatus.OPEN }
        })
      }

      // ردیفِ «پذیرفته‌شده» کارش تمام شده است. اگر بماند، قیدِ یکتای
      // (آگهی، بازیکن) جلویش را می‌گیرد و همان کارمندِ دیروز هرگز نمی‌تواند
      // دوباره برای همان آگهی — که حالا صندلیِ خالی دارد — درخواست بدهد.
      // درخواستِ «ردشده» عمداً نگه داشته می‌شود: پاسخِ منفیِ کارفرما پایدار است.
      await tx.jobApplication.deleteMany({
        where: {
          jobPostingId: employment.jobPostingId,
          playerId: employment.playerId,
          status: JobApplicationStatus.ACCEPTED
        }
      })
    }

    return { paid: payable, unpaid }
  }

  /** استعفای داوطلبانهٔ کارمند. */
  async resignEmployee(
    playerId: string,
    employmentId: string
  ): Promise<{
    paid: number
    unpaid: number
    businessName: string
    /** مالکِ کسب‌وکار — تا سرویس بتواند خبرِ استعفا را به او بدهد. */
    ownerPlayerId: string
    title: string
  }> {
    return this.db.$transaction(async (tx) => {
      const employment = await tx.businessEmployee.findFirst({
        where: { id: employmentId, playerId, isActive: true },
        include: {
          business: {
            select: { id: true, name: true, treasury: true, lastPayrollAt: true, ownerId: true }
          }
        }
      })
      if (!employment) {
        throw new NotFoundError('Employment not found', 'شغل فعالی با این مشخصات نداری.')
      }

      const settled = await this.settleSeparation(tx, employment, 'استعفا')

      const left = await tx.businessEmployee.updateMany({
        where: { id: employment.id, isActive: true },
        data: {
          isActive: false,
          unpaidSalary: settled.unpaid,
          paidUntilAt: new Date()
        }
      })
      if (left.count !== 1) {
        throw new ConflictError('Concurrent separation', 'این شغل همین حالا تغییر وضعیت داده است.')
      }
      await tx.business.updateMany({
        where: { id: employment.businessId, activeEmployees: { gt: 0 } },
        data: { activeEmployees: { decrement: 1 } }
      })

      return {
        ...settled,
        businessName: employment.business.name,
        ownerPlayerId: employment.business.ownerId,
        title: employment.title
      }
    })
  }

  /** اخراج توسط مالک (همان تسویهٔ استعفا). */
  async fireEmployee(
    ownerPlayerId: string,
    businessId: string,
    employeePlayerId: string
  ): Promise<{ paid: number; unpaid: number }> {
    return this.db.$transaction(async (tx) => {
      const employment = await tx.businessEmployee.findFirst({
        where: { businessId, playerId: employeePlayerId, isActive: true },
        include: {
          business: {
            select: {
              id: true,
              name: true,
              treasury: true,
              lastPayrollAt: true,
              ownerId: true
            }
          }
        }
      })
      if (!employment) {
        throw new NotFoundError('Employee not found', 'این کارمند در کسب‌وکار تو فعال نیست.')
      }
      if (employment.business.ownerId !== ownerPlayerId) {
        throw new ConflictError('Access denied', 'این کسب‌وکار متعلق به تو نیست. از «کسب‌وکار» شرکت خودت را انتخاب کن.')
      }

      const settled = await this.settleSeparation(tx, employment, 'اخراج')

      const left = await tx.businessEmployee.updateMany({
        where: { id: employment.id, isActive: true },
        data: {
          isActive: false,
          unpaidSalary: settled.unpaid,
          paidUntilAt: new Date()
        }
      })
      if (left.count !== 1) {
        throw new ConflictError('Concurrent separation', 'این کارمند همین حالا جدا شده است.')
      }
      await tx.business.updateMany({
        where: { id: businessId, activeEmployees: { gt: 0 } },
        data: { activeEmployees: { decrement: 1 } }
      })

      // صفّرداشتن درخواست‌های بازِ این فرد روی آگهی‌های همین شرکت
      await tx.jobApplication.updateMany({
        where: {
          playerId: employeePlayerId,
          status: JobApplicationStatus.PENDING,
          jobPosting: { businessId }
        },
        data: { status: JobApplicationStatus.REJECTED }
      })

      return settled
    })
  }

  async updateEmployeeSalary(
    businessId: string,
    playerId: string,
    newSalaryPerMinute: number
  ): Promise<BusinessEmployee> {
    return this.db.businessEmployee.update({
      where: {
        businessId_playerId: { businessId, playerId }
      },
      data: { salaryPerMinute: newSalaryPerMinute }
    })
  }

  /**
   * شغل فعالِ کارمندیِ بازیکن (برای پنل «شغل من» و شرط تک‌اشغالی).
   */
  async findActiveEmployment(playerId: string): Promise<
    | (BusinessEmployee & { business: Business })
    | null
  > {
    return this.db.businessEmployee.findFirst({
      where: { playerId, isActive: true },
      include: { business: true }
    })
  }

  /** فهرست شغل‌های فعالِ کارمندیِ بازیکن (معمولاً صفر یا یک). */
  async listActiveEmployments(playerId: string): Promise<(BusinessEmployee & { business: Pick<Business, 'id' | 'name' | 'lastPayrollAt' | 'activeEmployees' | 'employeeCapacity'> })[]> {
    return this.db.businessEmployee.findMany({
      where: { playerId, isActive: true },
      include: {
        business: {
          select: {
            id: true,
            name: true,
            lastPayrollAt: true,
            activeEmployees: true,
            employeeCapacity: true
          }
        }
      }
    })
  }

  /** تغییر قراردادِ حجمیِ یک کارمند (تنها کارفرما). */
  async updateEmployeeContract(
    businessId: string,
    playerId: string,
    contractMinutesPerMonth: number
  ): Promise<number> {
    const updated = await this.db.businessEmployee.updateMany({
      where: { businessId, playerId, isActive: true },
      data: { contractMinutesPerMonth: Math.max(1, Math.floor(contractMinutesPerMonth)) }
    })
    return updated.count
  }

  /** کارکردِ ثبت‌شدهٔ یک بازیکن در این کسب‌وکار از لحظهٔ `since` (دقیقهٔ بازی). */
  async workedMinutesFor(businessId: string, playerId: string, since: Date): Promise<number> {
    const shifts = await completedShifts(this.db, businessId, since)
    return creditedMinutesOf(shifts, playerId, since)
  }

  /**
   * کارکردِ یک کارمند در **ماهِ بازیِ جاری** — سنجهٔ سقفِ قرارداد.
   *
   * حساب قرارداد ماهانه است ولی پرداخت در تسویه انجام می‌شود، پس برای
   * "اجازهٔ کارکردن" باید کارکردِ همین ماهِ بازی شمرده شود، نه بازهٔ تسویه.
   */
  async workedMinutesThisMonth(businessId: string, playerId: string): Promise<number> {
    const monthStart = gameMonthStart()
    const shifts = await completedShifts(this.db, businessId, monthStart)
    return creditedMinutesOf(shifts, playerId, monthStart)
  }

  /**
   * ارتقای کسب‌وکار: سطح، ظرفیت و درآمد پایه — هزینه و رشد متناسب با Tier.
   *
   * ظرفیت تازه همیشه از ظرفیت فعلی بیشتر است (هرگز نیروی فعلی «جا‌کم» نمی‌شود)
   * و ثبت مالی به‌عنوان پرداختِ بازیکن (sourcePlayerId) نوشته می‌شود تا
   * دفتر کل، جریانِ پولِ کیف پول را درست نشان دهد.
   *
   * Tier-aware:
   *  • Tier 1 (فروشگاه): رشد ظرفیت ۳۰٪، هزینهٔ پایه
   *  • Tier 2 (شرکت)  : رشد ۴۰٪، هزینه ×۱.۲
   *  • Tier 3 (کارخانه): رشد ۵۰٪، هزینه ×۱.۵ (ریسک و مقیاس بالاتر)
   */
  async upgradeBusiness(businessId: string): Promise<Business> {
    return this.db.$transaction(async (tx) => {
      const business = await tx.business.findUnique({ where: { id: businessId } })
      if (!business || business.status !== BusinessStatus.ACTIVE) {
        throw new NotFoundError('Business not found', 'این کسب‌وکار یافت نشد یا فعال نیست.')
      }

      // نگاشت Tier از modelType (اگر الگویی ناشناس بود، Tier 2 فرض می‌شود)
      let tierFactor = 1
      let growthRate = 1.3
      {
        const blueprint = BUSINESS_BLUEPRINTS.find(
          (b) => b.modelType === business.modelType
        ) as { tier?: number; riskFactor?: number } | undefined
        if (blueprint?.tier === 1) {
          tierFactor = 1
          growthRate = 1.3
        } else if (blueprint?.tier === 2) {
          tierFactor = 1.2
          growthRate = 1.4
        } else if (blueprint?.tier === 3) {
          tierFactor = 1.5
          growthRate = 1.5
        } else if (blueprint?.riskFactor) {
          tierFactor = 1 + blueprint.riskFactor
        }
      }

      const baseUpgradeCost = Math.round(Number(business.baseRevenuePerMinute) * 3_000 * business.level)
      const upgradeCost = Math.round(baseUpgradeCost * tierFactor)

      const newLevel = business.level + 1
      const grown = Math.round(business.employeeCapacity * growthRate)
      const newCapacity = Math.max(business.employeeCapacity + 1, grown)
      const newProduction = Math.round(Number(business.productionUnitsPerHour) * 1.2)
      const newRevenue = Math.round(Number(business.baseRevenuePerMinute) * 1.15)

      const debited = await tx.player.updateMany({
        where: { id: business.ownerId, balance: { gte: upgradeCost } },
        data: { balance: { decrement: upgradeCost } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient balance for business upgrade',
          'موجودیت برای ارتقای این کسب‌وکار کافی نیست.'
        )
      }

      // شرط روی level: جلوگیری از ارتقای دوباره با کلیک همزمان؛ همهٔ فیلدها
      // در همان یک نوشتارِ شرطی به‌روز می‌شوند.
      const upgraded = await tx.business.updateMany({
        where: { id: businessId, level: business.level },
        data: {
          level: newLevel,
          employeeCapacity: newCapacity,
          productionUnitsPerHour: newProduction,
          baseRevenuePerMinute: newRevenue
        }
      })
      if (upgraded.count !== 1) {
        throw new ConflictError(
          'Business already upgraded',
          'این کسب‌وکار همین حالا ارتقا یافته است.'
        )
      }

      await tx.financialTransaction.create({
        data: {
          amount: upgradeCost,
          type: TransactionType.BUSINESS_UPGRADE,
          sourcePlayerId: business.ownerId,
          reference: `ارتقای کسب‌وکار ${business.name} به سطح ${newLevel}`
        }
      })

      return tx.business.findUniqueOrThrow({ where: { id: businessId } })
    })
  }

  /**
   * برداشت مالک از خزانه (تقسیم سود).
   * مالیات ۱۵٪ بر درآمد شرکت کسر و به‌عنوان Sink ثبت می‌شود؛ مابه‌التفاوت
   * به کیف پول مالک واریز می‌گردد. کل عمل در یک تراکنش با شرط خزانه است.
   */
  async withdrawBusinessProfit(
    ownerPlayerId: string,
    businessId: string,
    amount: number | null
  ): Promise<{ gross: number; tax: number; net: number; treasuryAfter: number }> {
    return this.db.$transaction(async (tx) => {
      const business = await tx.business.findFirst({
        where: { id: businessId, ownerId: ownerPlayerId, status: BusinessStatus.ACTIVE }
      })
      if (!business) {
        throw new NotFoundError('Business not found', 'کسب‌وکار فعالی با این مشخصات نداری.')
      }

      const treasury = Math.max(0, Math.round(Number(business.treasury)))
      const gross = amount === null ? treasury : Math.min(Math.max(1, Math.round(amount)), treasury)
      if (gross <= 0) {
        throw new ValidationError('Empty treasury', 'خزانهٔ این کسب‌وکار خالی است.')
      }

      const drained = await tx.business.updateMany({
        where: { id: business.id, treasury: { gte: gross } },
        data: { treasury: { decrement: gross } }
      })
      if (drained.count !== 1) {
        throw new ConflictError('Treasury changed', 'خزانه همین حالا تغییر کرد؛ دوباره تلاش کن.')
      }

      // مالیات بر سود توزیع‌شده از همین‌جا (تنها منبع نرخ) کسر و به صندوق
      // منطقهٔ مالک واریز می‌شود؛ پیش‌تر ۰٫۱۵ داخل همین فایل تکرار شده بود و
      // پول مالیات بدون هیچ ردی به صندوق نمی‌رسید.
      const groupId =
        (
          await tx.player.findUnique({
            where: { id: ownerPlayerId },
            select: { homeGroupId: true }
          })
        )?.homeGroupId ?? null
      const tax = await new TaxService().takeProfitTax(tx, {
        playerId: ownerPlayerId,
        amount: gross,
        reference: `برداشت سود ${business.name}`,
        groupId,
        sourceBusinessId: business.id
      })
      const net = gross - tax

      await tx.player.update({
        where: { id: ownerPlayerId },
        data: { balance: { increment: net } }
      })
      await tx.financialTransaction.create({
        data: {
          amount: gross,
          type: TransactionType.BUSINESS_REVENUE,
          sourceBusinessId: business.id,
          destinationPlayerId: ownerPlayerId,
          reference: `برداشت سود ${business.name}`
        }
      })

      return { gross, tax, net, treasuryAfter: treasury - gross }
    })
  }
}
