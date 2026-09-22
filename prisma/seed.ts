import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL is required for seeding')
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })

const initialSkills = [
  {
    name: 'برنامه‌نویسی',
    description: 'توانایی نوشتن کد و حل مسائل الگوریتمی',
    category: 'technical'
  },
  {
    name: 'مدیریت',
    description: 'توانایی رهبری تیم‌ها و تخصیص بهینه منابع',
    category: 'management'
  },
  {
    name: 'ارتباطات',
    description: 'مهارت مذاکره و تعامل موثر با انسان‌ها',
    category: 'communication'
  },
  {
    name: 'تجارت',
    description: 'درک اقتصاد بازار و فروش محصولات و خدمات',
    category: 'business'
  },
  {
    name: 'فنی',
    description: 'مهارت در کار با ابزارها و تعمیرات',
    category: 'technical'
  },
  {
    name: 'آموزش',
    description: 'انتقال دانش به دیگران به روش‌های استاندارد',
    category: 'education'
  }
]

const initialOccupations = [
  {
    name: 'کارآموز',
    description: 'ورود به دنیای کار و یادگیری مقدمات',
    category: 'عمومی',
    level: 1,
    baseSalary: 3_000_000,
    requiredAge: 18,
    experience: 0,
    workingHours: 6,
    workplace: 'شرکت عمومی',
    requiredSkills: []
  },
  {
    name: 'کارمند',
    description: 'انجام امور دفتری و اداری روزمره',
    category: 'اداری',
    level: 2,
    baseSalary: 12_000_000,
    requiredAge: 20,
    experience: 1,
    workingHours: 8,
    workplace: 'سازمان',
    requiredSkills: ['ارتباطات']
  },
  {
    name: 'فروشنده',
    description: 'عرضه و فروش کالا و خدمات به مشتریان',
    category: 'بازار',
    level: 2,
    baseSalary: 15_000_000,
    requiredAge: 18,
    experience: 0,
    workingHours: 8,
    workplace: 'فروشگاه مرکزی',
    requiredSkills: ['تجارت', 'ارتباطات']
  },
  {
    name: 'برنامه‌نویس',
    description: 'توسعه نرم‌افزار و سیستم‌های کامپیوتری',
    category: 'فناوری',
    level: 3,
    baseSalary: 35_000_000,
    requiredAge: 21,
    experience: 2,
    workingHours: 8,
    workplace: 'شرکت فناوری اطلاعات',
    requiredSkills: ['برنامه‌نویسی']
  },
  {
    name: 'معلم',
    description: 'آموزش و پرورش نسل آینده',
    category: 'آموزش',
    level: 3,
    baseSalary: 18_000_000,
    requiredAge: 22,
    experience: 2,
    workingHours: 6,
    workplace: 'مدرسه',
    requiredSkills: ['آموزش', 'ارتباطات']
  },
  {
    name: 'مدیر',
    description: 'هدایت بخش و تصمیم‌گیری استراتژیک',
    category: 'مدیریت',
    level: 4,
    baseSalary: 55_000_000,
    requiredAge: 26,
    experience: 5,
    workingHours: 9,
    workplace: 'دفتر مرکزی شرکت',
    requiredSkills: ['مدیریت', 'ارتباطات']
  }
]

async function seed(): Promise<void> {
  console.log('Seeding skills...')
  for (const skill of initialSkills) {
    await prisma.skill.upsert({
      where: { name: skill.name },
      update: {
        description: skill.description,
        category: skill.category
      },
      create: skill
    })
  }

  console.log('Seeding occupations...')
  for (const occ of initialOccupations) {
    await prisma.occupation.upsert({
      where: { name: occ.name },
      update: {
        description: occ.description,
        category: occ.category,
        level: occ.level,
        baseSalary: occ.baseSalary,
        requiredAge: occ.requiredAge,
        experience: occ.experience,
        workingHours: occ.workingHours,
        workplace: occ.workplace,
        requiredSkills: occ.requiredSkills
      },
      create: occ
    })
  }

  console.log('Database seeded successfully.')
}

seed()
  .catch((e) => {
    console.error('Seed error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })