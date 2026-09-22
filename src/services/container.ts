import { PrismaClient } from '@prisma/client'
import { prisma } from '../database/client'
import { PlayerRepository } from '../database/repositories/player.repository'
import { UserStateRepository } from '../database/repositories/user-state.repository'
import { GroupRepository } from '../database/repositories/group.repository'
import { PlayerGroupRepository } from '../database/repositories/player-group.repository'
import { OccupationRepository } from '../database/repositories/occupation.repository'
import { SkillRepository } from '../database/repositories/skill.repository'
import { PlayerSkillRepository } from '../database/repositories/player-skill.repository'
import { RelationshipRepository } from '../database/repositories/relationship.repository'
import { NotificationRepository } from '../database/repositories/notification.repository'
import { WorkSessionRepository } from '../database/repositories/work-session.repository'
import { BusinessRepository } from '../database/repositories/business.repository'
import { FinancialLedgerRepository } from '../database/repositories/financial-ledger.repository'
import { JobCapacityRepository } from '../database/repositories/job-capacity.repository'
import { HousingRepository } from '../database/repositories/housing.repository'
import { BankingRepository } from '../database/repositories/banking.repository'
import { RegistrationService } from '../modules/registration/registration.service'
import { PlayerService } from '../modules/identity/player.service'
import { IdentityPrivacyService } from '../modules/identity/identity-privacy.service'
import { GroupService, MemberInfoProvider } from '../modules/groups/group.service'
import { EnvironmentClassifier } from '../modules/groups/environment.classifier'
import { IncomeCalculationService } from '../modules/occupation/income-calculation.service'
import { WorkSessionService } from '../modules/occupation/work-session.service'
import { JobCapacityService } from '../modules/occupation/job-market.service'
import { BusinessService } from '../modules/occupation/business.service'
import { PayrollService } from '../modules/occupation/payroll.service'
import { EducationService } from '../modules/education/education.service'
import { LifeCycleService } from '../modules/lifecycle/lifecycle.service'
import { HousingService } from '../modules/housing/housing.service'
import { BankingService } from '../modules/banking/banking.service'
import { AdminService } from '../modules/admin/admin.service'
import { SkillService } from '../modules/skills/skill.service'
import { RelationshipService } from '../modules/relationship/relationship.service'
import { NotificationService } from '../modules/notification/notification.service'
import { BankTransferService } from '../modules/banking/bank-transfer.service'
import { TransferService } from '../modules/finance/transfer.service'
import { ShopService } from '../modules/shop/shop.service'
import { CreditService } from '../modules/finance/credit.service'
import { LedgerService } from '../modules/finance/ledger.service'
import { EventService } from '../modules/events/event.service'
import { NewsService } from '../modules/news/news.service'
import { RegionService } from '../modules/city/region.service'
import { RankingService } from '../modules/ranking/ranking.service'
import { MissionService } from '../modules/missions/mission.service'
import { ResidenceService } from '../modules/residence/residence.service'
import { ActivityService } from '../modules/activity/activity.service'
import { RetentionService } from '../modules/maintenance/retention.service'
import { RewardsService } from '../modules/rewards/rewards.service'
import { OvertimeService } from '../modules/occupation/overtime.service'
import { ProjectsService } from '../modules/city/projects.service'
import { LotteryService } from '../modules/city/lottery.service'
import { ElectionsService } from '../modules/city/elections.service'
import { TradeService } from '../modules/market/trade.service'
import { StatisticsService } from '../modules/statistics/statistics.service'
import { LeaderboardService } from '../modules/ranking/leaderboard.service'
import { DailyQuestService } from '../modules/quests/daily-quest.service'
import { AchievementService } from '../modules/achievements/achievement.service'
import { DepositService } from '../modules/banking/deposit.service'
import { FortuneService } from '../modules/rewards/fortune.service'
import { ClinicService } from '../modules/health/clinic.service'
import { RentalService } from '../modules/housing/rental.service'
import { PassportService } from '../modules/residence/passport.service'
import { MarriageService } from '../modules/family/marriage.service'
import { FamilyLifeService } from '../modules/family/family-life.service'
import { PetService } from '../modules/pets/pet.service'
import { AuctionService } from '../modules/auction/auction.service'
import { GymService } from '../modules/gym/gym.service'
import { PlayerLoanService } from '../modules/lending/player-loan.service'
import { ChallengeService } from '../modules/city/challenge.service'
import { PolicyService } from '../modules/city/policy.service'
import { BranchService } from '../modules/occupation/branch.service'
import { AdService } from '../modules/news/ad.service'
import { ReportService } from '../modules/statistics/report.service'
import { SupportService } from '../modules/support/support.service'
import { InheritanceService } from '../modules/inheritance/inheritance.service'
import { DeathService } from '../modules/inheritance/death.service'
import { VitalityService } from '../modules/health/vitality.service'
import { RebirthService } from '../modules/inheritance/rebirth.service'
import { DeployService } from '../modules/deploy/deploy.service'
import { BackupService } from '../modules/ops/backup.service'
import { CodeStateReader } from '../modules/ops/code-state'
import { PrismaOpsDatabase } from '../modules/ops/ops-database'
import { OpsStateFile } from '../modules/ops/ops-state'
import { SystemStatusService } from '../modules/ops/system-status.service'
import { WillService } from '../modules/inheritance/will.service'
import { BankPoolService } from '../modules/banking/bank-pool.service'
import { AutonomousService } from '../modules/autonomous/autonomous.service'
import { buildAutonomousJobs } from '../modules/autonomous/autonomous.jobs'

export interface Container {
  db: PrismaClient
  playerRepository: PlayerRepository
  userStateRepository: UserStateRepository
  groupRepository: GroupRepository
  playerGroupRepository: PlayerGroupRepository
  occupationRepository: OccupationRepository
  skillRepository: SkillRepository
  playerSkillRepository: PlayerSkillRepository
  relationshipRepository: RelationshipRepository
  notificationRepository: NotificationRepository
  workSessionRepository: WorkSessionRepository
  businessRepository: BusinessRepository
  financialLedgerRepository: FinancialLedgerRepository
  jobCapacityRepository: JobCapacityRepository
  jobCapacityService: JobCapacityService
  housingRepository: HousingRepository
  bankingRepository: BankingRepository
  environmentClassifier: EnvironmentClassifier
  registrationService: RegistrationService
  playerService: PlayerService
  identityPrivacyService: IdentityPrivacyService
  groupService: GroupService
  incomeCalculationService: IncomeCalculationService
  workSessionService: WorkSessionService
  businessService: BusinessService
  educationService: EducationService
  lifeCycleService: LifeCycleService
  housingService: HousingService
  bankingService: BankingService
  adminService: AdminService
  skillService: SkillService
  relationshipService: RelationshipService
  notificationService: NotificationService
  transferService: TransferService
  /** انتقالِ بانکی (حساب به حساب) — مسیری جدا از انتقالِ نقدی، با سقفِ روزانه و مالیات. */
  bankTransferService: BankTransferService
  shopService: ShopService
  leaderboardService: LeaderboardService
  creditService: CreditService
  ledgerService: LedgerService
  eventService: EventService
  newsService: NewsService
  regionService: RegionService
  rankingService: RankingService
  missionService: MissionService
  residenceService: ResidenceService
  activityService: ActivityService
  payrollService: PayrollService
  retentionService: RetentionService
  statisticsService: StatisticsService
  rewardsService: RewardsService
  overtimeService: OvertimeService
  projectsService: ProjectsService
  lotteryService: LotteryService
  electionsService: ElectionsService
  tradeService: TradeService
  dailyQuestService: DailyQuestService
  achievementService: AchievementService
  depositService: DepositService
  fortuneService: FortuneService
  clinicService: ClinicService
  rentalService: RentalService
  passportService: PassportService
  marriageService: MarriageService
  familyLifeService: FamilyLifeService
  petService: PetService
  auctionService: AuctionService
  gymService: GymService
  playerLoanService: PlayerLoanService
  challengeService: ChallengeService
  policyService: PolicyService
  branchService: BranchService
  adService: AdService
  reportService: ReportService
  supportService: SupportService
  inheritanceService: InheritanceService
  deathService: DeathService
  willService: WillService
  vitalityService: VitalityService
  rebirthService: RebirthService
  deployService: DeployService
  backupService: BackupService
  systemStatusService: SystemStatusService
  /**
   * تنها زمان‌بندِ سرور. هر تغییرِ زمان‌محور (پایان شیفت، پایان تحصیل، ارتقای
   * منطقه، نگهداری) از این یک تایمر رد می‌شود تا هیچ مسیری «تایمر خصوصی»
   * نسازد و همه از یک ریتم پیروی کنند.
   */
  autonomousService: AutonomousService
}

export function buildContainer(memberInfoProvider: MemberInfoProvider): Container {
  const playerRepository = new PlayerRepository(prisma)
  // نگهداری داده پیش از مصرف‌کنندگانش ساخته می‌شود: کارهای خودکار به همان
  // نمونهٔ مشترک وصل می‌شوند، نه به یک نمونهٔ تازه.
  const retentionService = new RetentionService(prisma)
  const userStateRepository = new UserStateRepository(prisma)
  const groupRepository = new GroupRepository(prisma)
  const playerGroupRepository = new PlayerGroupRepository(prisma)
  const occupationRepository = new OccupationRepository(prisma)
  const skillRepository = new SkillRepository(prisma)
  const playerSkillRepository = new PlayerSkillRepository(prisma)
  const relationshipRepository = new RelationshipRepository(prisma)
  const notificationRepository = new NotificationRepository(prisma)
  const workSessionRepository = new WorkSessionRepository(prisma)
  const businessRepository = new BusinessRepository(prisma)
  const financialLedgerRepository = new FinancialLedgerRepository(prisma)
  const jobCapacityRepository = new JobCapacityRepository(prisma)
  const housingRepository = new HousingRepository(prisma)
  const bankingRepository = new BankingRepository(prisma)

  const environmentClassifier = new EnvironmentClassifier()
  const lifeCycleService = new LifeCycleService()
  const playerService = new PlayerService(playerRepository)
  const identityPrivacyService = new IdentityPrivacyService(playerRepository, playerService)
  const incomeCalculationService = new IncomeCalculationService()
  const jobCapacityService = new JobCapacityService(
    jobCapacityRepository,
    playerRepository,
    workSessionRepository
  )
  const workSessionService = new WorkSessionService(
    workSessionRepository,
    playerRepository,
    incomeCalculationService,
    jobCapacityService,
    playerSkillRepository,
    skillRepository,
    prisma
  )
  // اعلان‌ها پیش از مصرف‌کنندگانشان ساخته می‌شوند (فقط به مخزن‌ها نیاز دارد)
  const notificationService = new NotificationService(
    notificationRepository,
    playerRepository,
    prisma
  )
  // حسابداری حقوق هم اعلان می‌دهد: کارمند تا پیش از این هیچ‌وقت نمی‌فهمید
  // حقوقش واریز شده است و موجودی‌اش بی‌صدا بالا می‌رفت.
  const payrollService = new PayrollService(prisma, notificationService)
  const businessService = new BusinessService(
    businessRepository,
    playerRepository,
    payrollService,
    notificationService
  )
  const educationService = new EducationService(
    playerRepository,
    playerSkillRepository,
    skillRepository
  )
  const eventService = new EventService(prisma)
  // میراث پیش از مصرف‌کنندگانش ساخته می‌شود: `AdminService` با صفرکردن
  // سلامتِ یک بازیکن، مرگ را ثبت می‌کند و `WillService` هم برای بررسی Lazy
  // سلامت به سرویس مرگ نیاز دارد. ترتیب ساخت عمدی است، نه تصادفی.
  const inheritanceService = new InheritanceService(
    prisma,
    eventService,
    new BankPoolService(),
    notificationService
  )
  const deathService = new DeathService(
    prisma,
    inheritanceService,
    notificationService,
    eventService
  )
  // فرسودگیِ طبیعیِ بدن پس از سرویس مرگ ساخته می‌شود: تنها مسیری است که
  // سلامت را بی‌کف پایین می‌برد و باید مرگ را از همان مسیرِ واحد اعلام کند.
  const vitalityService = new VitalityService(prisma, deathService, notificationService)
  const rebirthService = new RebirthService(prisma)
  const willService = new WillService(
    prisma,
    eventService,
    deathService,
    inheritanceService,
    notificationService
  )
  // پروژه‌های شهری منبع بافرهای منطقه‌اند و پیش از مصرف‌کنندگان ساخته می‌شوند
  const projectsService = new ProjectsService(prisma, eventService)
  const housingService = new HousingService(housingRepository, playerRepository, projectsService, prisma)
  const creditService = new CreditService(prisma)
  const residenceService = new ResidenceService(prisma, eventService, projectsService)
  // پاداش‌های معرفی پولِ واقعی‌اند و به دو نفر می‌رسند؛ بی‌خبری‌شان پذیرفتنی نبود.
  const rewardsService = new RewardsService(prisma, eventService, notificationService)
  const activityService = new ActivityService(prisma, residenceService, rewardsService)
  const bankingService = new BankingService(
    bankingRepository,
    playerRepository,
    housingRepository,
    businessRepository,
    creditService,
    notificationService,
    // رخدادِ سرگذشتِ نکول وام (LOAN_DEFAULTED) باید در تاریخچه بماند تا
    // بازیکن بفهمد چرا وثیقه‌اش از دست رفت.
    {
      recordPlayerEvent: (input) => eventService.recordPlayerEvent(input)
    }
  )
  // میراث به پنل مدیریت هم داده می‌شود: پرونده‌هایی که چرخهٔ خودکار رهایشان
  // کرده (بی‌وارث یا با سقفِ تلاشِ پر) فقط با تلاش دستی جمع می‌شوند.
  const adminService = new AdminService(prisma, deathService, inheritanceService)

  const groupService = new GroupService(
    groupRepository,
    playerGroupRepository,
    playerRepository,
    memberInfoProvider,
    environmentClassifier
  )

  // بازار بازیکنی هم اعلان می‌گیرد (فروشِ کالا پولِ قطعی است و انقضای آگهی
  // داراییِ برگشته) و هم انقضای خودکار دارد؛ پس یک نمونهٔ مشترک ساخته می‌شود
  // که چرخهٔ خودکار و پنل از همان استفاده کنند.
  const tradeService = new TradeService(prisma, eventService, notificationService)
  const rentalService = new RentalService(prisma, housingRepository, eventService, notificationService)
  const gymService = new GymService(prisma, eventService)
  const challengeService = new ChallengeService(prisma, eventService)

  // عملیاتِ سرور: وضعیت، بکاپ و بازیابی. همه از یک درگاهِ دیتابیس رد می‌شوند تا
  // مسیرِ بازیابی قابل آزمون باشد و مستقیم به مدل‌های دامنه گره نخورد.
  const repoRoot = process.cwd()
  const deployService = new DeployService(repoRoot)
  const opsDatabase = new PrismaOpsDatabase(prisma)
  const backupService = new BackupService(opsDatabase, repoRoot)
  const systemStatusService = new SystemStatusService(
    opsDatabase,
    new CodeStateReader(repoRoot),
    deployService,
    backupService,
    new OpsStateFile(OpsStateFile.defaultPath(repoRoot)),
    repoRoot,
    // شمارشِ جمعیت از مدل‌های دامنه خوانده می‌شود، نه از SQLِ دستی: نامِ جدول‌ها
    // `@@map` شده‌اند و یک پرس‌وجوی دستی، روزی که نقشه عوض شود، بی‌صدا می‌شکند.
    async () => ({
      players: await prisma.player.count(),
      groups: await prisma.group.count()
    })
  )

  // کارهای پردازش خودکار: همان منطق‌هایی که پیش‌تر یا با باز شدن پنل اجرا
  // می‌شدند یا در یک تایمرِ ۶ ساعته دستی صدا زده می‌شدند، اکنون یک تعریفِ
  // واحد با فاصلهٔ مشخص دارند. هیچ‌کدام منطق دامنه را تکرار نمی‌کند؛ همه
  // سرویس‌های واقعیِ همین Container را صدا می‌زنند.
  const autonomousService = new AutonomousService(
    buildAutonomousJobs({
      work: { settleDueSessions: (limit) => workSessionService.settleDueSessions(limit) },
      education: { graduateDueStudents: (limit) => educationService.graduateDueStudents(limit) },
      groups: { sweepEnvironmentLevels: (limit) => groupService.sweepEnvironmentLevels(limit) },
      players: { findIdsByTelegramUserIds: (ids) => playerRepository.findIdsByTelegramUserIds(ids) },
      notifications: { announce: (input) => notificationService.announce(input) },
      events: { recordRegionEvent: (input) => eventService.recordRegionEvent(input) },
      periodic: {
        loanSweep: () => bankingService.sweepOverdueLoans(50),
        vitality: () => vitalityService.sweep(),
        inheritanceRecovery: () => inheritanceService.recoverStalled(),
        projectAnnouncements: () => projectsService.recoverPendingAnnouncements(5),
        underwork: () => payrollService.notifyUnderworked(),
        marketExpiry: () => tradeService.sweepExpired(),
        retention: () => retentionService.runAll()
      }
    })
  )

  return {
    db: prisma,
    playerRepository,
    userStateRepository,
    groupRepository,
    playerGroupRepository,
    occupationRepository,
    skillRepository,
    playerSkillRepository,
    relationshipRepository,
    notificationRepository,
    workSessionRepository,
    businessRepository,
    financialLedgerRepository,
    jobCapacityRepository,
    jobCapacityService,
    housingRepository,
    bankingRepository,
    environmentClassifier,
    registrationService: new RegistrationService(playerRepository, userStateRepository),
    playerService,
    identityPrivacyService,
    groupService,
    incomeCalculationService,
    workSessionService,
    businessService,
    educationService,
    lifeCycleService,
    housingService,
    bankingService,
    adminService,
    skillService: new SkillService(skillRepository, playerSkillRepository, playerRepository, prisma),
    relationshipService: new RelationshipService(relationshipRepository, playerRepository),
    notificationService,
    transferService: new TransferService(prisma, playerRepository, notificationService),
    bankTransferService: new BankTransferService(
      prisma,
      playerRepository,
      notificationService,
      bankingService
    ),
    shopService: new ShopService(prisma, projectsService),
    leaderboardService: new LeaderboardService(
      playerRepository,
      playerGroupRepository,
      groupRepository
    ),
    creditService,
    ledgerService: new LedgerService(prisma),
    eventService,
    newsService: new NewsService(prisma),
    regionService: new RegionService(prisma, eventService),
    rankingService: new RankingService(prisma),
    missionService: new MissionService(prisma),
    residenceService,
    activityService,
    payrollService,
    retentionService,
    statisticsService: new StatisticsService(prisma),
    rewardsService,
    overtimeService: new OvertimeService(prisma, eventService, playerSkillRepository),
    projectsService,
    // برندهٔ قرعه‌کشی جایزهٔ نقدی می‌گیرد؛ خودش باید بداند (نه فقط رخداد گروه).
    lotteryService: new LotteryService(prisma, eventService, notificationService),
    // انتخابات هم اعلان دارد: برگشت ودیه (پول) و بردِ شهرداری هر دو خبرِ شخصی‌اند.
    electionsService: new ElectionsService(prisma, eventService, notificationService),
    tradeService,
    dailyQuestService: new DailyQuestService(prisma, eventService),
    achievementService: new AchievementService(prisma, eventService),
    depositService: new DepositService(prisma, eventService, notificationService),
    fortuneService: new FortuneService(prisma),
    clinicService: new ClinicService(prisma, eventService, notificationService),
    rentalService,
    passportService: new PassportService(prisma, eventService),
    marriageService: new MarriageService(prisma, eventService, notificationService),
    familyLifeService: new FamilyLifeService(prisma, eventService, notificationService),
    // اعلان‌ها به PetService هم وصل‌اند: بیماریِ حیوان باید به بازیکن گفته شود
    petService: new PetService(prisma, eventService, notificationService),
    auctionService: new AuctionService(prisma, eventService, notificationService),
    gymService,
    playerLoanService: new PlayerLoanService(prisma, eventService, notificationService),
    challengeService,
    policyService: new PolicyService(prisma, eventService),
    branchService: new BranchService(prisma, eventService),
    adService: new AdService(prisma),
    reportService: new ReportService(prisma, notificationService),
    // مسیر بازیکن→پشتیبانی؛ رسیدگیِ ادمین در AdminService است تا نگهبانِ
    // دسترسی و گزارش مدیریت دور زده نشود.
    supportService: new SupportService(prisma),
    // میراث: انتقال داراییِ شخصیت فوت‌شده. ترتیب ساخت عمدی است — اجرای میراث
    // به مرگ نیاز دارد، مرگ به سرویسِ وصیت، و وصیت به هر دو (برای بررسی Lazy
    // سلامت). صندوق بانک هم این‌جاست تا تسویهٔ وامِ متوفی با همزادِ خودِ
    // عملیات بانکی انجام شود (یک مسیر، یک فرمول).
    inheritanceService,
    deathService,
    willService,
    vitalityService,
    rebirthService,
    // استقرار فقط روی سرور معنا دارد؛ سرویس خودش محیط را می‌سنجد و بیرون از
    // production صریحاً «در دسترس نیست» می‌گوید.
    deployService,
    backupService,
    systemStatusService,
    autonomousService
  }
}