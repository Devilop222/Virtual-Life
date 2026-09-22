import { fa, money } from '../ui-kit'
import { ratePerGameHour } from '../../utils/game-time'
import { InlineKeyboard } from 'grammy'
import { Gender, ProfilePrivacy } from '@prisma/client'
import { menu } from '../../utils/classes/texts'
import {
  JOB_CATEGORIES,
  PART_TIME_JOBS,
  BUSINESS_BLUEPRINTS
} from '../../modules/occupation/work-blueprints'
import { DegreeLevel, degreeLabels } from '../../modules/education/education-blueprints'
import { PROPERTY_BLUEPRINTS } from '../../modules/housing/housing-blueprints'
import { SHOP_CATEGORIES } from '../../modules/shop/shop-catalog'
import { HELP_CATEGORIES, getCategoryTopics } from '../help-content'

interface ShopRowItem {
  key: string
  name: string
  rarity: string
  stock: number
  /** قیمت جاری بازار (پس از اعمال ضریب عرضه و تقاضا). */
  currentPrice: number
  /** روند قیمت برای نمایش نشانگر. */
  trend?: 'up' | 'down' | 'stable'
}

export function buildShopCategoriesKeyboard() {
  const keyboard = new InlineKeyboard()
  SHOP_CATEGORIES.forEach((category, index) => {
    keyboard.text(category, `shop:cat:${category}`)
    if (index % 2 === 1) keyboard.row()
  })
  keyboard.row().text('📦 انبار من', 'inv:list:0')
  keyboard.text('بستن', 'panel:close')
  keyboard.row().text('❓ راهنمای فروشگاه', 'help:topic:shop')
  return keyboard
}

export function buildShopCategoryItemsKeyboard(
  category: string,
  items: ShopRowItem[]
) {
  const keyboard = new InlineKeyboard()
  for (const item of items) {
    const rare = item.rarity === 'rare' || item.rarity === 'epic' || item.rarity === 'legendary'
    const trendIcon = item.trend === 'up' ? ' 📈' : item.trend === 'down' ? ' 📉' : ''
    const label =
      `${rare ? '⭐ ' : ''}${item.name} • ${item.currentPrice.toLocaleString('fa-IR')} ت${trendIcon}` +
      (item.stock !== -1 ? ` • ${item.stock} عدد` : '')
    keyboard.add({
      text: label,
      callback_data: `shop:buy:${item.key}`,
      style: 'success'
    }).row()
  }
  keyboard.row().text('⬅️ دسته‌بندی‌ها', `shop:cat:${category}`)
  return keyboard
}

export function buildInventoryListKeyboard(
  rows: Array<{ id: string; name: string }>,
  page: number,
  totalPages: number
) {
  const keyboard = new InlineKeyboard()
  rows.forEach((row) => {
    keyboard
      .text(`✅ ${row.name}`, `inv:use:${row.id}`)
      .text('🏷️ فروش', `mkt:sell:${row.id}`)
      .row()
  })
  if (page > 0) keyboard.text('⬅️ قبلی', `inv:list:${page - 1}`)
  keyboard.text(`${fa(page + 1)} / ${fa(Math.max(1, totalPages))}`, `inv:list:${page}`)
  if (page + 1 < totalPages) {
    keyboard.text('بعدی ➡️', `inv:list:${page + 1}`)
  }
  keyboard.row().text('🤝 بازار بازیکنان', 'mkt:list:0').text('📋 آگهی‌های من', 'mkt:mine')
  keyboard.row().text('🏪 فروشگاه', 'shop:main').text('بستن', 'panel:close')
  return keyboard
}

/** کیبورد فهرست آگهی‌های بازار بازیکنی. */
export function buildMarketListKeyboard(
  listings: Array<{ id: string; itemName: string; totalPrice: number }>,
  page: number,
  totalPages: number
) {
  const keyboard = new InlineKeyboard()
  listings.forEach((l) => {
    keyboard.add({
      text: `🤝 ${l.itemName} · ${money(l.totalPrice)}`,
      callback_data: `trade:buy:${l.id}`,
      style: 'success'
    }).row()
  })
  if (page > 0) keyboard.text('⬅️ قبلی', `mkt:list:${page - 1}`)
  keyboard.text(`${fa(page + 1)} / ${fa(Math.max(1, totalPages))}`, `mkt:list:${page}`)
  if (page + 1 < totalPages) keyboard.text('بعدی ➡️', `mkt:list:${page + 1}`)
  keyboard.row().text('🎒 انبار من', 'inv:list:0').text('📋 آگهی‌های من', 'mkt:mine')
  keyboard.row().text('بستن', 'panel:close')
  keyboard.row().text('❓ راهنمای معامله', 'help:topic:trade')
  return keyboard
}

/** کیبورد آگهی‌های خودم با امکان لغو. */
export function buildMyListingsKeyboard(listings: Array<{ id: string; itemName: string }>) {
  const keyboard = new InlineKeyboard()
  listings.forEach((l) => {
    keyboard.add({
      text: `🗑️ لغو ${l.itemName}`,
      callback_data: `mkt:cancel:${l.id}`,
      style: 'danger'
    }).row()
  })
  keyboard.text('🤝 بازار بازیکنان', 'mkt:list:0').text('🎒 انبار من', 'inv:list:0')
  keyboard.row().text('بستن', 'panel:close')
  return keyboard
}

/** کیبورد انصراف از ثبت آگهی. */
export function buildMarketCancelKeyboard() {
  return new InlineKeyboard()
    .add({ text: 'انصراف', callback_data: 'mkt:sell_cancel', style: 'danger' })
}

export function buildLeaderboardKeyboard(
  scope: 'group' | 'global',
  metric: string,
  page: number,
  inGroup: boolean,
  hasNextPage: boolean
) {
  const keyboard = new InlineKeyboard()
  const labelMap: Record<string, string> = {
    money: '💰 پول',
    experience: '⭐ تجربه',
    health: '❤️ سلامت',
    age: '🎂 سن'
  }
  Object.keys(labelMap).forEach((m) => {
    keyboard.text(m === metric ? `▫️${labelMap[m]}` : labelMap[m] ?? m, `lb:${scope}:${m}:0`)
  })
  keyboard.row()
  if (page > 0) keyboard.text('⬅️ قبلی', `lb:${scope}:${metric}:${page - 1}`)
  keyboard.text(`صفحهٔ ${fa(page + 1)}`, `lb:${scope}:${metric}:${page}`)
  if (hasNextPage) keyboard.text('بعدی ➡️', `lb:${scope}:${metric}:${page + 1}`)
  keyboard.row().text('🔄 به‌روزرسانی', `lb:${scope}:${metric}:${page}`)
  if (scope === 'group' && inGroup) {
    keyboard.text('🌍 جهانی', `lb:global:${metric}:0`)
  }
  keyboard.text('بستن', 'panel:close')
  return keyboard
}

export function buildGenderKeyboard() {
  return new InlineKeyboard()
    .text(menu.genderMale, `reg:gender:${Gender.MALE}`)
    .text(menu.genderFemale, `reg:gender:${Gender.FEMALE}`)
}

export function buildRegistrationCancelKeyboard() {
  return new InlineKeyboard().add({
    text: 'انصراف',
    callback_data: 'reg:cancel',
    style: 'danger'
  })
}

export function buildIdentityPrivacyKeyboard(currentPrivacy: ProfilePrivacy) {
  const isPublic = currentPrivacy === ProfilePrivacy.PUBLIC
  const label = isPublic ? '🔓 اطلاعات من: عمومی (تغییر به خصوصی)' : '🔒 اطلاعات من: خصوصی (تغییر به عمومی)'
  return new InlineKeyboard()
    .text(label, 'id:toggle_privacy')
    .row()
    .text('بستن', 'panel:close')
}

export function buildHousingMenuKeyboard(isResting: boolean) {
  const keyboard = new InlineKeyboard()
  if (isResting) {
    keyboard.text('🛑 پایان استراحت و ریکاوری', 'house:stop_rest').row()
  } else {
    keyboard.text('🛌 استراحت در خانه', 'house:start_rest').row()
  }
  keyboard
    .text('🛒 خرید ملک مسکونی', 'house:buy_catalog')
    .text('📋 املاک من', 'house:my_list')
    .row()
    .text('🔑 بازار اجاره', 'rent:main')
    .text('🏥 درمانگاه', 'clinic:main')
    .row()
    .text('🐾 حیوان خانگی', 'pet:main')
    .text('💪 باشگاه', 'gym:main')
    .row()
    .text('❓ راهنمای خانه و اجاره', 'help:topic:housing')
    .row()
    .text('بستن', 'panel:close')
  return keyboard
}

export function buildPropertyCatalogKeyboard() {
  const keyboard = new InlineKeyboard()
  PROPERTY_BLUEPRINTS.forEach((p) => {
    keyboard.text(`${p.title} (${money(p.purchasePrice)})`, `house:buy:${p.type}`).row()
  })
  keyboard.text('بازگشت', 'house:main')
  return keyboard
}

export function buildBankingMenuKeyboard() {
  return new InlineKeyboard()
    .text('📥 واریز به حساب', 'bank:deposit_prompt')
    .text('📤 برداشت از حساب', 'bank:withdraw_prompt')
    .row()
    .text('💰 دریافت سود سپرده', 'bank:interest')
    .text('📑 درخواست وام', 'bank:loan_menu')
    .row()
    .text('💳 بازپرداخت قسط', 'bank:loan_repay')
    .text('✅ تسویهٔ کامل وام', 'bank:loan_settle')
    .row()
    .text('⏳ سپردهٔ مدت‌دار', 'dep:main')
    .text('🤝 قرض بازیکنی', 'loan:main')
    .row()
    .text('❓ راهنمای بانک', 'help:topic:bank')
    .text('💸 انتقال به بازیکن', 'transfer:help')
    .row()
    .text('بستن', 'panel:close')
}

export function buildBankCancelKeyboard() {
  return new InlineKeyboard().text('انصراف', 'bank:cancel')
}

/** صفحهٔ تأیید تسویهٔ کامل وام؛ شناسهٔ وام در دکمه می‌ماند، مبلغ نه. */
export function buildBankSettleConfirmKeyboard(loanId: string) {
  return new InlineKeyboard()
    .add({
      text: '✅ پرداخت و تسویه',
      callback_data: `bank:loan_settle_go:${loanId}`,
      style: 'success'
    })
    .row()
    .add({ text: 'بازگشت به بانک', callback_data: 'bank:main', style: 'primary' })
}

export function buildWorkMenuKeyboard(hasWorkplace = true) {
  const keyboard = new InlineKeyboard()
  // فقط برای کسی که واقعاً جایی شاغل است (یا صاحب کسب‌وکار)؛ بقیه دکمه‌ای
  // نمی‌بینند که تنها کارش دادن پیام خطا باشد.
  if (hasWorkplace) {
    keyboard.add({ text: '🏢 شروع شیفت در محل کار', callback_data: 'work:start_wp', style: 'success' }).row()
  }
  return keyboard
    .text('🕐 کار پاره‌وقت', 'work:menu:part_time')
    .text('🏢 کار تمام‌وقت', 'work:menu:full_time')
    .row()
    .text('🏭 کسب‌وکارهای من', 'work:menu:my_biz')
    .text('📊 وضعیت فعلی کار', 'work:status')
    .row()
    .text('🏢 شعبه‌های کسب‌وکار', 'br:main')
    .row()
    .text('❓ راهنمای کار', 'help:topic:work')
    .row()
    .text('بستن', 'panel:close')
}

/**
 * دسته‌های شغلی. فقط دسته‌هایی نمایش داده می‌شوند که واقعاً شغل دارند
 * تا بازیکن به فهرست خالی نرسد. شمار شغل هر دسته روی دکمه می‌آید.
 */
export function buildPartTimeCategoriesKeyboard() {
  const keyboard = new InlineKeyboard()
  let index = 0
  for (const category of JOB_CATEGORIES) {
    const count = PART_TIME_JOBS.filter((job) => job.category === category).length
    if (count === 0) {
      continue
    }
    keyboard.text(`${category} (${count.toLocaleString('fa-IR')})`, `work:pt:cat:${category}`)
    if (index % 2 === 1) keyboard.row()
    index++
  }
  keyboard.row().text('بازگشت', 'work:main').text('بستن', 'panel:close')
  return keyboard
}

/**
 * دکمه‌های مشاغل یک دسته با نشانگر شرایط.
 * نشانگرها پیش از کلیک مشخص می‌کنند چه شرطی لازم است:
 *   🎓 نیاز به مدرک   ⭐N نیاز به N سابقه   🔴 ظرفیت تکمیل
 */
/**
 * فهرست شغل‌های یک دسته.
 *
 * `fieldMatched` وقتی true است که رشتهٔ تحصیلیِ بازیکن با همین دسته
 * هم‌حوزه باشد؛ آن‌وقت یک ✨ کنار نام دسته می‌نشیند تا بازیکن بداند اینجا
 * دستمزدش بیشتر است. این همان پیامدِ واقعیِ انتخاب رشته است.
 */
export function buildPartTimeJobsByCategoryKeyboard(
  category: string,
  capacityMap: Record<string, { capacity: number; occupied: number }>,
  options: { fieldMatched?: boolean } = {}
) {
  const keyboard = new InlineKeyboard()
  const jobs = PART_TIME_JOBS.filter((job) => job.category === category)
  for (const job of jobs) {
    const cap = capacityMap[job.key]
    const isFull = cap !== undefined && cap.capacity > 0 && cap.occupied >= cap.capacity
    const badges =
      (job.requiredEducation ? ' 🎓' : '') +
      (job.minExperience ? ` ⭐${job.minExperience}` : '') +
      (options.fieldMatched ? ' ✨' : '')
    // دستمزد روی دکمه به «ساعت بازی» است — همان واحدی که فرمول پرداخت دارد.
    const pay = ratePerGameHour(job.basePayPerMinute).toLocaleString('fa-IR')
    const capText = cap !== undefined ? ` · ${cap.occupied}/${cap.capacity}` : ''
    keyboard
      .text(
        `${isFull ? '🔴 ' : ''}${job.name} · ${pay}${badges}${capText}`,
        `work:start_pt:${job.key}`
      )
      .row()
  }
  keyboard
    .row()
    .text('⬅️ دسته‌ها', 'work:menu:part_time')
    .text('بستن', 'panel:close')
  return keyboard
}

export function buildActiveWorkKeyboard(hasOvertime = true, workplaceShift = false) {
  const kb = new InlineKeyboard()
    .add({
      text: workplaceShift ? '🛑 پایان شیفت و ثبت کارکرد' : '🛑 پایان کار و دریافت دستمزد',
      callback_data: 'work:stop',
      style: 'success'
    })
    .row()
  // اضافه‌کاری مزد را *فوری* می‌دهد و فقط برای کار پاره‌وقت معنا دارد؛ در شیفت
  // محل کار، مزد در تسویهٔ کارفرما می‌آید و اضافه‌کاری یعنی دور زدنِ آن حساب.
  if (hasOvertime && !workplaceShift) {
    kb.add({ text: '🔥 سخت کار کردن', callback_data: 'work:overtime', style: 'success' })
       .add({ text: '🔄 به‌روزرسانی', callback_data: 'work:status', style: 'primary' })
       .row()
  } else {
    kb.add({ text: '🔄 به‌روزرسانی', callback_data: 'work:status', style: 'primary' }).row()
  }
  return kb.add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
}

export function buildFullTimeMenuKeyboard() {
  return new InlineKeyboard()
    .text('🔎 پیدا کردن شغل', 'work:ft:find_jobs')
    .text('🏢 تأسیس کسب‌وکار', 'work:ft:new_biz')
    .row()
    .text('🧑‍💼 شغل من', 'job:mine')
    .text('بازگشت', 'work:main')
}

export function buildBusinessBlueprintsKeyboard() {
  const keyboard = new InlineKeyboard()
  BUSINESS_BLUEPRINTS.forEach((biz) => {
    keyboard.text(
      `${biz.title} • ${(biz.startupCost / 1_000_000).toLocaleString('fa-IR')} میلیون`,
      `biz:create:${biz.modelType}`
    ).row()
  })
  keyboard.row().text('بازگشت', 'work:menu:full_time')
  return keyboard
}

export function buildEducationMenuKeyboard(canGraduate: boolean, isStudying: boolean) {
  const keyboard = new InlineKeyboard()
  if (canGraduate) {
    keyboard.text('🎓 دریافت مدرک و فارغ‌التحصیلی', 'edu:graduate').row()
  } else if (!isStudying) {
    keyboard.text('📝 انتخاب رشته و ثبت‌نام در دانشگاه', 'edu:choose_field').row()
  }
  keyboard.text('🔄 به‌روزرسانی وضعیت تحصیلی', 'edu:refresh')
  keyboard.row().text('بستن', 'panel:close')
  keyboard.row().text('❓ راهنمای تحصیل', 'help:topic:education')
  return keyboard
}

/**
 * فهرست رشته‌ها با «مقطع بعدی» هرکدام برای همین بازیکن.
 *
 * ورودی از پیش محاسبه‌شده است (در handler با `nextEnrollableDegree` از مدرک
 * فعلی بازیکن ساخته می‌شود) تا دکمه‌ای که پیش‌نیازش فراهم نیست هرگز ساخته
 * نشود — پیش‌تر همهٔ دکمه‌ها فقط «کارشناسی» ارائه می‌دادند و فارغ‌التحصیلان
 * لیسانس به‌همیشه با خطای پیش‌نیاز مواجه می‌شدند.
 */
export function buildEducationFieldsKeyboard(
  entries: Array<{ key: string; degree: DegreeLevel; title: string; baseTuitionCost: number }>
) {
  const keyboard = new InlineKeyboard()
  entries.forEach((entry) => {
    keyboard
      .text(`${entry.title} — ${degreeLabels[entry.degree]} (${money(entry.baseTuitionCost)})`, `edu:enroll:${entry.key}:${entry.degree}`)
      .row()
  })
  keyboard.text('بازگشت', 'edu:main')
  return keyboard
}

/**
 * فهرست فصل‌های راهنما (سطح اول).
 *
 * `newcomer` تعیین می‌کند میان‌بر «شروع تازه‌کار» بیاید یا نه. فقط کسی که
 * هنوز شخصیت نساخته این میان‌بر را می‌بیند: بازیکنی که سال‌ها بازی کرده
 * نباید آموزشی برای ساختِ شخصیت ببیند — نه دکمه، نه توضیح. پیش‌فرض `false`
 * است تا مسیرِ نادرست مسیرِ خاموش باشد، نه مسیرِ پیش‌فرض.
 */
export function buildHelpMainKeyboard(options: { newcomer?: boolean } = {}) {
  const keyboard = new InlineKeyboard()
  if (options.newcomer) {
    keyboard.text('🚀 شروع تازه‌کار', 'help:topic:basics:start').row()
  }
  HELP_CATEGORIES.forEach((category, index) => {
    keyboard.text(category.buttonLabel, `help:cat:${category.key}`)
    if (index % 2 === 1) keyboard.row()
  })
  if (HELP_CATEGORIES.length % 2 === 1) keyboard.row()
  keyboard.row().text('بستن', 'panel:close')
  return keyboard
}

/** موضوع‌های یک فصل (سطح دوم). */
export function buildHelpCategoryKeyboard(
  categoryKey: string,
  options: { newcomer?: boolean } = {}
) {
  const keyboard = new InlineKeyboard()
  // فصلِ «قدم‌های اول» موضوعِ ساختِ شخصیت را فقط برای تازه‌وارد دارد؛ برای
  // بازیکنِ فعال، بقیهٔ همان فصل (پنل‌ها، زمان، قانون‌ها) سر جای خود می‌ماند.
  const topics = getCategoryTopics(categoryKey).filter(
    (topic) => !(topic.key === 'start' && !options.newcomer)
  )
  for (const topic of topics) {
    keyboard.text(topic.buttonLabel, `help:topic:${categoryKey}:${topic.key}`).row()
  }
  keyboard.row().text('⬅️ فصل‌ها', 'help:main').text('بستن', 'panel:close')
  return keyboard
}

/** متن یک موضوع (سطح سوم). بازگشت به فصل خودش انجام می‌شود. */
export function buildHelpTopicKeyboard(categoryKey?: string) {
  return new InlineKeyboard()
    .text('بازگشت', categoryKey ? `help:cat:${categoryKey}` : 'help:main')
    .text('بستن', 'panel:close')
}

export function buildHousingBackKeyboard() {
  return new InlineKeyboard()
    .add({ text: 'بازگشت به خانه', callback_data: 'house:main', style: 'primary' })
    .add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
}

/** فهرست املاک من: دکمهٔ مبله‌کردن برای ملک‌های بدون مبله. */
export function buildMyPropertiesKeyboard(
  properties: Array<{ id: string; title: string; isFurnished: boolean; rentedOut: boolean }>
) {
  const keyboard = new InlineKeyboard()
  for (const property of properties.slice(0, 8)) {
    // ملکِ اجاره‌داده‌شده فعلاً قابل فروش/مبله‌سازی نیست؛ دکمهٔ بی‌اثر نشان
    // نمی‌دهیم تا بازیکن روی دکمه‌ای نزند که فقط «نبودن» را بگوید.
    if (property.rentedOut) continue
    if (!property.isFurnished) {
      keyboard
        .add({ text: `🛋️ مبله‌کردن ${property.title}`, callback_data: `house:furnish:${property.id}`, style: 'primary' })
        .row()
    }
    keyboard
      .add({ text: `💸 فروش ${property.title}`, callback_data: `house:sell:${property.id}`, style: 'danger' })
      .row()
  }
  keyboard
    .add({ text: 'بازگشت به خانه', callback_data: 'house:main', style: 'primary' })
    .add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
  return keyboard
}

export function buildWorkBackKeyboard() {
  return new InlineKeyboard()
    .add({ text: 'بازگشت به شغل', callback_data: 'work:main', style: 'primary' })
    .add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
}

export function buildBankBackKeyboard() {
  return new InlineKeyboard()
    .add({ text: 'بازگشت به بانک', callback_data: 'bank:main', style: 'primary' })
    .add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
}

export function buildEducationBackKeyboard() {
  return new InlineKeyboard()
    .add({ text: 'بازگشت به تحصیل', callback_data: 'edu:main', style: 'primary' })
    .add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
}

export function buildShopBackKeyboard() {
  return new InlineKeyboard()
    .add({ text: '⬅️ فروشگاه', callback_data: 'shop:main', style: 'primary' })
    .add({ text: '🎒 انبار', callback_data: 'inv:list:0', style: 'primary' })
    .row()
    .add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
}

export function buildClosePanelKeyboard() {
  return new InlineKeyboard().add({
    text: 'بستن',
    callback_data: 'panel:close',
    style: 'danger'
  })
}

/**
 * تأییدِ انتقال پول — همان توکنِ تک‌مصرفی که سرویس صادر کرده.
 * دکمه هیچ مبلغ و هیچ شناسه‌ای حمل نمی‌کند: هر دو در stateِ سمت سرور
 * بسته شده‌اند تا callback_data قابل دستکاری نباشد.
 */
export function buildTransferConfirmKeyboard(token: string) {
  return new InlineKeyboard()
    .add({ text: '✅ تأیید و ارسال', callback_data: `transfer:confirm:${token}`, style: 'success' })
    .text('انصراف', 'transfer:cancel')
}

/** راهنمای انتقال پول از پنل بانک. */
export function buildTransferHelpKeyboard() {
  return new InlineKeyboard().text('🏦 بازگشت به بانک', 'bank:main').text('بستن', 'panel:close')
}

/**
 * پس از لغوِ انتقال: بازگشت به قدمِ قبلیِ همین جریان (راهنمای انتقال).
 *
 * چرا نه `bank:main`؟ انتقال بیشتر وقت‌ها با ریپلای روی پیام بازیکن در گروه
 * آغاز می‌شود، نه از پنل بانک. پرش به پنل بانک پس از «لغو» بازیکن را از
 * زمینه‌ای که بود جدا می‌کند؛ زنجیرهٔ درست این است: لغو → راهنمای انتقال → بانک.
 */
/**
 * پس از انتقالِ موفق: قدمِ معنادارِ بعدی، دیدنِ همان ردیف در دفتر مالی است —
 * نه پرش به پنل بانک که هیچ کاری با انتقال انجام‌شده ندارد.
 */
export function buildTransferDoneKeyboard() {
  return new InlineKeyboard()
    .add({ text: '📜 دفتر مالی', callback_data: 'ledger:0', style: 'primary' })
    .add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
}

export function buildTransferCancelledKeyboard() {
  return new InlineKeyboard()
    .add({ text: '↩️ بازگشت', callback_data: 'transfer:help', style: 'primary' })
    .add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
}

/**
 * پایانِ یک جریانِ ورودی: راهِ برگشت به همان بخش + بستن.
 * هیچ پنلی نباید بن‌بست باشد؛ بازیکن پس از هر پاسخِ متنی یک قدمِ بعدی می‌بیند.
 */
export function buildSectionDoneKeyboard(backLabel: string, backCb: string) {
  return new InlineKeyboard().text(backLabel, backCb).text('بستن', 'panel:close')
}

export function buildCreditKeyboard() {
  return new InlineKeyboard()
    .text('🔄 به‌روزرسانی', 'credit:refresh')
    .text('🏦 بانک', 'bank:main')
    .row()
    .text('📜 دفتر مالی', 'ledger:0')
    .text('بستن', 'panel:close')
}

export function buildLedgerKeyboard(page: number, totalPages: number) {
  const keyboard = new InlineKeyboard()
  if (page > 0) keyboard.text('⬅️ جدیدتر', `ledger:${page - 1}`)
  keyboard.text(`صفحهٔ ${fa(page + 1)} از ${fa(Math.max(1, totalPages))}`, `ledger:${page}`)
  if (page + 1 < totalPages) keyboard.text('قدیمی‌تر ➡️', `ledger:${page + 1}`)
  keyboard
    .row()
    .text('📊 آمار زندگی', 'stats:main')
    .text('🗂️ تاریخچه', 'history:0')
    .row()
    .text('بستن', 'panel:close')
  return keyboard
}

export function buildStatsKeyboard() {
  return new InlineKeyboard()
    .text('🔄 به‌روزرسانی', 'stats:main')
    .text('📜 دفتر مالی', 'ledger:0')
    .row()
    .text('📈 اعتبار مالی', 'credit:refresh')
    .text('📊 گزارش هفتگی', 'report:main')
    .row()
    .text('👪 خانواده', 'fam:main')
    .text('📣 آگهی همگانی', 'ad:main')
    .row()
    .text('بستن', 'panel:close')
}

export function buildBusinessManageKeyboard(businessId: string) {
  return new InlineKeyboard()
    .text('📢 آگهی استخدام', `biz:postjob:${businessId}`)
    .text('📋 آگهی‌های من', `biz:postings:${businessId}`)
    .row()
    .text('📨 درخواست‌ها', `biz:apps:${businessId}`)
    .text('👷 کارمندان', `biz:emps:${businessId}`)
    .row()
    .text('💵 برداشت سود', `biz:profit:${businessId}`)
    .text('💼 تسویه حقوق', `payroll:preview:${businessId}`)
    .row()
    .text('⬆️ ارتقا', `biz:upgrade:${businessId}`)
    .row()
    .text('بازگشت به شغل', 'work:main')
    .text('بستن', 'panel:close')
    .row()
    .text('❓ راهنمای کسب‌وکار', 'help:topic:business')
}

/** فهرست آگهی‌های شغلی بازیکنان با صفحه‌گردانی و ورودی «شغل من». */
export function buildJobPostingsKeyboard(
  postings: Array<{ id: string }>,
  page: number,
  pages: number
) {
  const keyboard = new InlineKeyboard()
  for (const posting of postings.slice(0, 8)) {
    keyboard.text(`📄 مشاهده آگهی`, `job:open:${posting.id}`).row()
  }
  if (pages > 1) {
    if (page > 1) keyboard.text('⬅️ قبلی', `job:page:${page - 1}`)
    if (page < pages) keyboard.text('بعدی ➡️', `job:page:${page + 1}`)
    keyboard.row()
  }
  keyboard.text('🧑‍💼 شغل من', 'job:mine').text('بستن', 'panel:close')
  return keyboard
}

/** پنل جزئیات آگهی: درخواست، بازگشت و پیگیری. */
export function buildJobDetailKeyboard(
  postingId: string,
  applied: boolean,
  problems: string[],
  hired = false
) {
  const keyboard = new InlineKeyboard()
  if (applied) {
    keyboard
      .add({
        // PENDING یعنی در انتظار بررسی کارفرما؛ ACCEPTED یعنی استخدام شده
        text: hired
          ? '✅ در این آگهی استخدام شده‌ای'
          : '✅ درخواستت ثبت شد — در انتظار بررسی',
        callback_data: 'job:noop'
      })
      .row()
  } else if (problems.length > 0) {
    keyboard
      .add({ text: '⛔ شرایط این آگهی را نداری', callback_data: 'job:noop', style: 'danger' })
      .row()
  } else {
    keyboard
      .add({ text: '📨 ارسال درخواست استخدام', callback_data: `job:apply:${postingId}`, style: 'success' })
      .row()
  }
  keyboard
    .text('📋 همهٔ آگهی‌ها', 'job:page:1')
    .text('🧑‍💼 شغل من', 'job:mine')
    .row()
    .text('بستن', 'panel:close')
  return keyboard
}

/** درخواست‌های بازیکن برای پیگیری/انصراف + میان‌بر به شغل فعلی. */
export function buildMyApplicationsKeyboard(applications: Array<{ id: string }>) {
  const keyboard = new InlineKeyboard()
  for (const application of applications.slice(0, 5)) {
    keyboard.add({
      text: 'انصراف از این درخواست',
      callback_data: `job:withdraw:${application.id}`,
      style: 'danger'
    }).row()
  }
  keyboard
    .text('📋 آگهی‌های باز', 'job:page:1')
    .text('بستن', 'panel:close')
  return keyboard
}

/** پنل «شغل من»: به‌روزرسانی و استعفا (تأییدشده در پنل جدا). */
export function buildMyJobKeyboard(hasJob: boolean) {
  const keyboard = new InlineKeyboard()
  if (hasJob) {
    keyboard
      .add({ text: '🏢 شروع شیفت در محل کار', callback_data: 'work:start_wp', style: 'success' })
      .row()
      .add({ text: '🔄 به‌روزرسانی', callback_data: 'job:mine', style: 'primary' })
      .row()
      .add({ text: '🚪 درخواست استعفا', callback_data: 'job:quit', style: 'danger' })
      .row()
  }
  keyboard
    .text('📋 آگهی‌های باز', 'job:page:1')
    .text('بستن', 'panel:close')
  return keyboard
}

/** تأیید استعفای کارمند. */
export function buildQuitConfirmKeyboard(employmentId: string) {
  return new InlineKeyboard()
    .add({
      text: '✅ تأیید استعفا و تسویه',
      callback_data: `job:quit_go:${employmentId}`,
      style: 'danger'
    })
    .row()
    .text('بازگشت', 'job:mine')
}

/** ردیف actions برای کارمندان و درخواست‌دهندگانِ پنل مالک. */
export function buildBusinessStaffKeyboard(
  rows: Array<{ text: string; cb: string }>,
  backCb: string
) {
  const keyboard = new InlineKeyboard()
  for (const row of rows.slice(0, 10)) {
    keyboard.text(row.text, row.cb).row()
  }
  keyboard.text('⬅️ کسب‌وکار', backCb).text('بستن', 'panel:close')
  return keyboard
}

/** سازندهٔ آگهی استخدام: شرایط با دکمه‌های پله‌ای تنظیم می‌شود. */
export function buildJobWizardKeyboard(canSave: boolean) {
  const keyboard = new InlineKeyboard()
  // تنظیم دقیق با دکمه تا ۵۰ تومان در دقیقهٔ بازی جابه‌جا می‌شود؛ عدد دلخواه را
  // کارفرما با «حقوق دلخواه» در همان واحدِ ساعت بازی می‌نویسد.
  keyboard
    .text('💰 −۵۰', 'biz:jf:sal:-50')
    .text('💰 +۵۰', 'biz:jf:sal:50')
    .text('✏️ حقوق دلخواه', 'biz:jf:salin')
    .row()
  keyboard.text('👥 −۱', 'biz:jf:cap:-1').text('👥 +۱', 'biz:jf:cap:1').row()
  // حجمِ قرارداد: کارفرما تعیین می‌کند کارمند در هر ماهِ بازی چند ساعت کار کند
  keyboard.text('⏱ −۳۰ ساعت', 'biz:jf:hrs:-30').text('⏱ +۳۰ ساعت', 'biz:jf:hrs:30').row()
  keyboard.text('⭐ −۵۰', 'biz:jf:exp:-50').text('⭐ +۵۰', 'biz:jf:exp:50').row()
  keyboard.text('🎓 مدرک', 'biz:jf:deg').text('🎂 سن', 'biz:jf:age').row()
  if (canSave) {
    keyboard
      .add({ text: '💾 ثبت آگهی', callback_data: 'biz:jf:save', style: 'success' })
      .row()
  }
  keyboard.text('✏️ تغییر عنوان', 'biz:jf:title').text('انصراف', 'biz:jf:cancel')
  return keyboard
}

/** پنل تأیید وام با وثیقه: یک دکمهٔ عمل، یک دکمهٔ بازگشت. */
export function buildLoanConfirmKeyboard(collateralKind: 'property' | 'business', id: string) {
  return new InlineKeyboard()
    .add({
      text: '✅ تأیید و دریافت وام',
      callback_data: `bank:loan_go:${collateralKind}:${id}`,
      style: 'success'
    })
    .row()
    .add({ text: 'انصراف', callback_data: 'bank:main', style: 'danger' })
}

/** انتخاب وثیقهٔ وام از بین املاک و کسب‌وکارهای بازیکن. */
export function buildLoanCollateralKeyboard(
  properties: Array<{ id: string; title: string }>,
  businesses: Array<{ id: string; name: string }>
) {
  const keyboard = new InlineKeyboard()
  for (const property of properties.slice(0, 6)) {
    keyboard.text(`🏠 ${property.title}`, `bank:loan_p:${property.id}`).row()
  }
  for (const business of businesses.slice(0, 4)) {
    keyboard.text(`🏢 ${business.name}`, `bank:loan_b:${business.id}`).row()
  }
  keyboard.text('⬅️ بانک', 'bank:main').text('بستن', 'panel:close')
  return keyboard
}

/** انصراف از جریان‌های متنی کوتاه (تعیین مهریه، مبلغ برداشت). */
export function buildFlowCancelKeyboard(cancelCb: string) {
  return new InlineKeyboard().add({ text: 'انصراف', callback_data: cancelCb, style: 'danger' })
}

/** صفحه‌گردان فهرست‌های کوتاه. */
export function buildPagedBackKeyboard(
  backCb: string,
  page: number,
  pages: number,
  pageCbPrefix: string
) {
  const keyboard = new InlineKeyboard()
  if (pages > 1) {
    if (page > 1) keyboard.text('⬅️ قبلی', `${pageCbPrefix}${page - 1}`)
    if (page < pages) keyboard.text('بعدی ➡️', `${pageCbPrefix}${page + 1}`)
    keyboard.row()
  }
  keyboard.text('بازگشت', backCb).text('بستن', 'panel:close')
  return keyboard
}

/** انتخاب یکی از چند کسب‌وکار برای مدیریت؛ برای مالکان چند شرکت. */
export function buildBusinessSelectKeyboard(
  businesses: Array<{ id: string; name: string }>
) {
  const keyboard = new InlineKeyboard()
  for (const business of businesses.slice(0, 8)) {
    keyboard.text(`🏢 ${business.name}`, `biz:manage:${business.id}`).row()
  }
  keyboard.text('بازگشت به شغل', 'work:main').text('بستن', 'panel:close')
  return keyboard
}

export function buildPayrollConfirmKeyboard(businessId: string, canSettle: boolean) {
  const keyboard = new InlineKeyboard()
  if (canSettle) {
    keyboard.add({
      text: '✅ تأیید و پرداخت حقوق',
      callback_data: `payroll:settle:${businessId}`,
      style: 'success'
    }).row()
  }
  keyboard
    .add({ text: '⬅️ کسب‌وکارها', callback_data: 'work:menu:my_biz', style: 'primary' })
    .add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
  return keyboard
}

export function buildPayrollDoneKeyboard(businessId: string) {
  return new InlineKeyboard()
    .text('🔄 پیش‌نمایش دوره بعد', `payroll:preview:${businessId}`)
    .row()
    .text('⬅️ کسب‌وکارهای من', 'work:menu:my_biz')
    .text('بستن', 'panel:close')
}

export function buildResidenceKeyboard(
  regions: Array<{ id: string; title: string }>,
  canMigrate: boolean
) {
  const keyboard = new InlineKeyboard()
  if (canMigrate) {
    for (const region of regions.slice(0, 5)) {
      keyboard.text(`✈️ مهاجرت به ${region.title}`, `residence:check:${region.id}`).row()
    }
  }
  keyboard.text('🧭 گذرنامهٔ سفر', 'passport:main')
  keyboard.row().text('🔄 به‌روزرسانی', 'residence:main')
  keyboard.text('بستن', 'panel:close')
  return keyboard
}

export function buildMigrationConfirmKeyboard(targetGroupId: string, allowed: boolean) {
  const keyboard = new InlineKeyboard()
  if (allowed) {
    keyboard.add({
      text: '✅ تأیید مهاجرت',
      callback_data: `residence:migrate:${targetGroupId}`,
      style: 'success'
    }).row()
  }
  keyboard
    .add({ text: 'بازگشت', callback_data: 'residence:main', style: 'primary' })
    .add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
  return keyboard
}

export function buildNewsKeyboard(page: number, totalPages: number) {
  const keyboard = new InlineKeyboard()
  if (page > 0) keyboard.text('⬅️ جدیدتر', `news:${page - 1}`)
  keyboard.text(`صفحهٔ ${fa(page + 1)} از ${fa(Math.max(1, totalPages))}`, `news:${page}`)
  if (page + 1 < totalPages) keyboard.text('قدیمی‌تر ➡️', `news:${page + 1}`)
  keyboard.row().text('🏙️ وضعیت منطقه', 'region:refresh').text('بستن', 'panel:close')
  return keyboard
}

export function buildRegionKeyboard(isManager: boolean) {
  const keyboard = new InlineKeyboard()
    .text('🔄 به‌روزرسانی', 'region:refresh')
    .text('📰 اخبار', 'news:0')
    .row()
    .text('🏆 رتبه‌بندی', 'rank:group:wealth:0')
  if (isManager) {
    keyboard.text('🛡️ مدیریت', 'manage:main')
  }
  keyboard.row().text('بستن', 'panel:close')
  return keyboard
}

export function buildRankingKeyboard(
  scope: 'group' | 'global' | 'region',
  category: string,
  page: number,
  totalPages: number,
  inGroup: boolean
) {
  const keyboard = new InlineKeyboard()

  if (scope === 'region') {
    const regionCats: Array<[string, string]> = [
      ['region_wealth', '💰 ثروت'],
      ['region_population', '👥 جمعیت'],
      ['region_activity', '📈 فعالیت']
    ]
    for (const [key, title] of regionCats) {
      keyboard.text(key === category ? `▫️${title}` : title, `rank:region:${key}:0`)
    }
  } else {
    const playerCats: Array<[string, string]> = [
      ['wealth', '💰 ثروت'],
      ['education', '🎓 سواد'],
      ['experience', '⭐ تجربه'],
      ['assets', '🏘️ دارایی']
    ]
    playerCats.forEach(([key, title], index) => {
      keyboard.text(key === category ? `▫️${title}` : title, `rank:${scope}:${key}:0`)
      if (index === 1) keyboard.row()
    })
  }

  keyboard.row()
  if (page > 0) keyboard.text('⬅️ قبلی', `rank:${scope}:${category}:${page - 1}`)
  keyboard.text(`${fa(page + 1)} / ${fa(Math.max(1, totalPages))}`, `rank:${scope}:${category}:${page}`)
  if (page + 1 < totalPages) {
    keyboard.text('بعدی ➡️', `rank:${scope}:${category}:${page + 1}`)
  }

  keyboard.row()
  if (scope !== 'global') keyboard.text('🌍 جهانی', 'rank:global:wealth:0')
  if (scope !== 'region') keyboard.text('🏙️ مناطق', 'rank:region:region_wealth:0')
  if (scope !== 'group' && inGroup) keyboard.text('👥 این منطقه', 'rank:group:wealth:0')
  keyboard.row().text('بستن', 'panel:close')
  return keyboard
}

export function buildMissionKeyboard() {
  return new InlineKeyboard()
    .text('🔄 به‌روزرسانی', 'mission:refresh')
    .text('🎯 کارت‌های روزانه', 'quest:main')
    .row()
    .text('🏅 نشان‌ها', 'ach:main')
    .text('📊 آمار زندگی', 'stats:main')
    .row()
    .text('بستن', 'panel:close')
}

/** دکمه‌های فیلتر تاریخچه — برش‌های مختلف از همان دادهٔ واقعی. */
export const HISTORY_FILTER_LABELS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'all', label: 'همه' },
  { key: 'work', label: '💼 کار' },
  { key: 'money', label: '💰 مالی' },
  { key: 'family', label: '💞 خانواده' },
  { key: 'city', label: '🏙️ شهر' }
]

export function buildHistoryKeyboard(page: number, totalPages: number, filter = 'all') {
  const keyboard = new InlineKeyboard()
  // ردیف فیلترها؛ فیلتر فعال با ✅ مشخص می‌شود
  HISTORY_FILTER_LABELS.forEach((f, index) => {
    const active = f.key === filter
    keyboard.text(active ? `✅ ${f.label}` : f.label, `history:f:${f.key}:0`)
    if (index === 1 || index === 3) keyboard.row()
  })
  keyboard.row()
  if (page > 0) keyboard.text('⬅️ جدیدتر', `history:f:${filter}:${page - 1}`)
  keyboard.text(`صفحهٔ ${fa(page + 1)} از ${fa(Math.max(1, totalPages))}`, `history:f:${filter}:${page}`)
  if (page + 1 < totalPages) keyboard.text('قدیمی‌تر ➡️', `history:f:${filter}:${page + 1}`)
  keyboard.row().text('📜 دفتر مالی', 'ledger:0').text('بستن', 'panel:close')
  return keyboard
}

export function buildManagementKeyboard() {
  return new InlineKeyboard()
    .text('🔄 به‌روزرسانی', 'manage:main')
    .text('📰 اخبار', 'news:0')
    .row()
    .text('🏙️ وضعیت منطقه', 'region:refresh')
    .text('🏆 رتبه‌بندی', 'rank:group:wealth:0')
    .row()
    .text('بستن', 'panel:close')
}

export function buildCityKeyboard() {
  return new InlineKeyboard()
    .add({ text: '🏗️ پروژه‌های شهر', callback_data: 'city:projects', style: 'success' })
    .row()
    .text('🗳️ انتخابات شهردار', 'city:elections')
    .text('🎯 چالش منطقه', 'chal:main')
    .row()
    .text('🔨 حراجی هفتگی', 'auc:main')
    .text('📜 سیاست شهردار', 'pol:main')
    .row()
    .text('🔄 به‌روزرسانی', 'city:refresh')
    .text('🏆 رتبه‌بندی', 'lb:group:money:0')
    .row()
    .text('❓ راهنمای شهر', 'help:topic:city')
    .text('بستن', 'panel:close')
}

/** کارت‌های روزانه: فقط کارت‌های تکمیل‌شدهٔ دریافت‌نشده دکمه می‌گیرند. */
export function buildQuestKeyboard(
  cards: Array<{ key: string; title: string; done: boolean; claimed: boolean }>,
  chestReady: boolean,
  chestClaimed: boolean
) {
  const keyboard = new InlineKeyboard()
  for (const card of cards) {
    if (card.done && !card.claimed) {
      keyboard.add({
        text: `🎁 دریافت پاداش ${card.title}`,
        callback_data: `quest:claim:${card.key}`,
        style: 'success'
      }).row()
    }
  }
  if (chestReady && !chestClaimed) {
    keyboard.add({
      text: '🧰 باز کردن صندوق هفته',
      callback_data: 'quest:chest',
      style: 'success'
    }).row()
  }
  keyboard.text('🔄 به‌روزرسانی', 'quest:main').text('🏅 نشان‌ها', 'ach:main')
  keyboard.row().text('بستن', 'panel:close')
  return keyboard
}

/** نشان‌ها: پنل خواندنی است و فقط مسیر رفت‌وبرگشت دارد. */
export function buildAchievementKeyboard() {
  return new InlineKeyboard()
    .text('🔄 به‌روزرسانی', 'ach:main')
    .text('🎯 کارت‌های روزانه', 'quest:main')
    .row()
    .text('بستن', 'panel:close')
}

/** شانس روزانه: دکمهٔ کشیدن فقط تا وقتی امروز کشیده نشده نمایش داده می‌شود. */
export function buildFortuneKeyboard(drawnToday: boolean) {
  const keyboard = new InlineKeyboard()
  if (!drawnToday) {
    keyboard.add({
      text: '🎲 کشیدن شانس امروز',
      callback_data: 'fortune:draw',
      style: 'success'
    }).row()
  }
  keyboard.text('🎯 کارت‌های روزانه', 'quest:main').text('🔄 به‌روزرسانی', 'fortune:main')
  keyboard.row().text('بستن', 'panel:close')
  return keyboard
}

/** سپرده‌های مدت‌دار: افتتاح پلن‌ها و شکست زودهنگام سپردهٔ جاری. */
export function buildDepositKeyboard(
  plans: Array<{ key: string; label: string; termDays: number }>,
  active: Array<{ id: string; planLabel: string; matured: boolean }>,
  capacityLeft: number
) {
  const keyboard = new InlineKeyboard()
  if (capacityLeft > 0) {
    for (const plan of plans) {
      keyboard.add({
        text: `📥 افتتاح سپردهٔ ${plan.label}`,
        callback_data: `dep:open:${plan.key}`,
        style: 'success'
      }).row()
    }
  }
  for (const deposit of active) {
    if (deposit.matured) continue
    keyboard.add({
      text: `🔓 شکست ${deposit.planLabel}`,
      callback_data: `dep:break:${deposit.id}`,
      style: 'danger'
    }).row()
  }
  keyboard.text('🔄 به‌روزرسانی', 'dep:main').text('🏦 بانک', 'bank:main')
  keyboard.row().text('بستن', 'panel:close')
  return keyboard
}

/** انصراف از وارد کردن مبلغ سپرده. */
export function buildDepositCancelKeyboard() {
  return new InlineKeyboard()
    .add({ text: 'انصراف', callback_data: 'dep:cancel', style: 'danger' })
}

/** بازگشت به تختهٔ سپرده‌ها پس از شکست زودهنگام؛ «انصراف» اینجا معنا ندارد. */
export function buildDepositBoardKeyboard() {
  return new InlineKeyboard()
    .text('🔄 سپرده‌های من', 'dep:main')
    .text('🏦 بانک', 'bank:main')
    .row()
    .text('بستن', 'panel:close')
}

/** درمانگاه: درمان و بیمه هر کدام تنها وقتی معنا دارند نمایش داده می‌شوند. */
export function buildClinicKeyboard(
  needsTreatment: boolean,
  insured: boolean,
  options: { canTreatFull?: boolean; emergencyUnits?: number } = {}
) {
  const keyboard = new InlineKeyboard()
  const canTreatFull = options.canTreatFull ?? true
  if (needsTreatment) {
    // درمان کامل کنشِ اصلی است؛ اگر موجودی کفایت نکند، دکمهٔ اضطراری
    // جای آن را می‌گیرد تا بازیکن هرگز در بن‌بست درمانی نماند.
    if (canTreatFull) {
      keyboard.add({
        text: '💉 درمان کامل',
        callback_data: 'clinic:treat',
        style: 'success'
      }).row()
    }
    if (!canTreatFull && (options.emergencyUnits ?? 0) > 0) {
      keyboard.add({
        text: '🚑 درمان اضطراری (به‌اندازهٔ موجودی)',
        callback_data: 'clinic:treat_emergency',
        style: 'primary'
      }).row()
    }
  }
  keyboard.add({
    text: insured ? '🛡️ تمدید بیمهٔ درمان' : '🛡️ خرید بیمهٔ درمان',
    callback_data: 'clinic:insure',
    style: 'primary'
  }).row()
  keyboard.row().text('❓ راهنمای درمانگاه', 'help:topic:clinic')
  keyboard.text('🔄 به‌روزرسانی', 'clinic:main').text('🏠 خانه', 'house:main')
  keyboard.row().text('بستن', 'panel:close')
  return keyboard
}

/** پنل مالک: عرضه، برداشتن از بازار و تعیین اجاره‌بها. */
export function buildRentalOwnerKeyboard(
  properties: Array<{ id: string; title: string; listedForRent: boolean; tenantName: string | null }>
) {
  const keyboard = new InlineKeyboard()
  for (const property of properties) {
    if (property.tenantName) continue
    keyboard.add({
      text: property.listedForRent ? `🚫 برداشتن ${property.title}` : `📣 عرضهٔ ${property.title}`,
      callback_data: `rent:toggle:${property.id}:${property.listedForRent ? '0' : '1'}`,
      style: property.listedForRent ? 'danger' : 'success'
    }).row()
    keyboard.text(`💰 اجاره‌بهای ${property.title}`, `rent:price:${property.id}`).row()
  }
  keyboard.text('🔎 آگهی‌های اجاره', 'rent:market').text('🔄 به‌روزرسانی', 'rent:main')
  keyboard.row().text('بستن', 'panel:close')
  return keyboard
}

/** پنل مستأجر: اجارهٔ ملک عرضه‌شده یا فسخ قرارداد فعال. */
export function buildRentalMarketKeyboard(
  offers: Array<{ propertyId: string; title: string }>,
  hasTenancy: boolean
) {
  const keyboard = new InlineKeyboard()
  if (!hasTenancy) {
    for (const offer of offers) {
      keyboard.add({
        text: `🔑 اجارهٔ ${offer.title}`,
        callback_data: `rent:take:${offer.propertyId}`,
        style: 'success'
      }).row()
    }
  } else {
    // تمدید = پرداخت اجارهٔ ماه بعد؛ عملیات اصلیِ یک مستأجرِ فعال
    keyboard.add({
      text: '💰 پرداخت اجاره (تمدید ۳۰ روز)',
      callback_data: 'rent:renew',
      style: 'success'
    }).row()
    keyboard.add({
      text: '🚪 فسخ قرارداد اجاره',
      callback_data: 'rent:end',
      style: 'danger'
    }).row()
  }
  keyboard.text('🏠 املاک من', 'rent:main').text('🔄 به‌روزرسانی', 'rent:market')
  keyboard.row().text('بستن', 'panel:close')
  return keyboard
}

/** انصراف از وارد کردن اجاره‌بها. */
export function buildRentalCancelKeyboard() {
  return new InlineKeyboard()
    .add({ text: 'انصراف', callback_data: 'rent:cancel', style: 'danger' })
}

/** گذرنامهٔ سفر: پنل خواندنی با مسیر بازگشت. */
export function buildPassportKeyboard() {
  return new InlineKeyboard()
    .text('🔄 به‌روزرسانی', 'passport:main')
    .text('🏅 نشان‌ها', 'ach:main')
    .row()
    .text('بستن', 'panel:close')
}

/** پنل خانواده؛ خواستگاری‌های دریافتی دکمهٔ پاسخ می‌گیرند. */
export function buildFamilyKeyboard(view: {
  hasSpouse: boolean
  bonusReady: boolean
  genderIsMale: boolean
  activityDoneToday?: boolean
  incomingProposals: Array<{ id: string; canAccept: boolean; canSetMahr: boolean }>
  outgoingProposals: Array<{ id: string; awaitingMyAnswer: boolean }>
}) {
  const keyboard = new InlineKeyboard()
  for (const proposal of view.incomingProposals) {
    if (proposal.canAccept) {
      keyboard.text('💍 قبول پیشنهاد', `fam:accept:${proposal.id}`)
    }
    if (proposal.canSetMahr) {
      keyboard.text('✍️ تعیین مهریه', `fam:mahr:${proposal.id}`)
    }
    keyboard.text('💔 رد', `fam:reject:${proposal.id}`).row()
  }
  for (const proposal of view.outgoingProposals) {
    if (proposal.awaitingMyAnswer) {
      keyboard.text('✅ تأیید مهریه و عقد', `fam:confirm:${proposal.id}`)
    }
    keyboard.text('انصراف', `fam:withdraw:${proposal.id}`).row()
  }
  if (!view.hasSpouse) {
    if (view.genderIsMale) {
      keyboard.text('💌 خواستگاری', 'fam:start_propose').row()
    }
  } else {
    if (view.bonusReady) {
      keyboard
        .add({ text: '💞 پاداش زوجین', callback_data: 'fam:bonus', style: 'success' })
        .row()
    }
    // زندگیِ روزانهٔ خانواده: دیدن وضعیت، وقت گذاشتن و هدیه‌دادن
    keyboard.text('👨‍👩‍👧 جزئیات خانواده', 'fam:detail').row()
    if (!view.activityDoneToday) {
      keyboard.text('🕯️ وقتِ مشترک', 'fam:activity').row()
    }
    keyboard.text('🎁 هدیه به همسر', 'fam:gift').row()
    keyboard.add({ text: '💔 طلاق', callback_data: 'fam:divorce', style: 'danger' }).row()
  }
  keyboard.row().text('❓ راهنمای خانواده', 'help:topic:family')
  keyboard.row().text('🔄 به‌روزرسانی', 'fam:main').text('بستن', 'panel:close')
  return keyboard
}

/** پنل جزئیات خانواده — بازگشت به خانواده یا بستن. */
export function buildFamilyDetailKeyboard() {
  return new InlineKeyboard()
    .text('🕯️ وقتِ مشترک', 'fam:activity')
    .text('🎁 هدیه به همسر', 'fam:gift')
    .row()
    .text('بازگشت به خانواده', 'fam:main')
    .text('بستن', 'panel:close')
}

/** جریان ورود مبلغ هدیه — فقط انصراف. */
export function buildFamilyGiftCancelKeyboard() {
  return new InlineKeyboard().add({
    text: 'انصراف',
    callback_data: 'fam:cancel_input',
    style: 'danger'
  })
}

/** پنل تمرین مهارت — برای هر مهارتِ غیرِ‌سقف یک دکمهٔ تمرین. */
export function buildSkillsTrainingKeyboard(overview: {
  canTrainMore: boolean
  skills: Array<{ id: string; name: string; level: number; maxed: boolean }>
}) {
  const keyboard = new InlineKeyboard()
  if (overview.canTrainMore) {
    for (const skill of overview.skills) {
      if (!skill.maxed) {
        keyboard.text(`🏋️ تمرین ${skill.name}`, `skill:train:${skill.id}`).row()
      }
    }
  }
  keyboard.text('🔄 به‌روزرسانی', 'skills:refresh').text('بستن', 'panel:close')
  return keyboard
}

/** تأییدیهٔ طلاق — یک پنل، دو دکمه. */
export function buildFamilyDivorceConfirmKeyboard() {
  return new InlineKeyboard()
    .add({ text: '✅ تأیید طلاق و پرداخت هزینه', callback_data: 'fam:divorce_confirm', style: 'danger' })
    .row()
    .text('بازگشت', 'fam:main')
}

/** انصراف از ورود مهریه. */
export function buildFamilyCancelKeyboard() {
  return new InlineKeyboard().add({
    text: 'انصراف',
    callback_data: 'fam:cancel_input',
    style: 'danger'
  })
}

/** انصراف از انتخاب نام حیوان. */
export function buildPetNameCancelKeyboard() {
  return new InlineKeyboard().add({
    text: 'انصراف',
    callback_data: 'pet:cancel_name',
    style: 'danger'
  })
}

/** انصراف از درخواست قرض. */
export function buildLoanRequestCancelKeyboard() {
  return new InlineKeyboard().add({
    text: 'انصراف',
    callback_data: 'loan:cancel_request',
    style: 'danger'
  })
}

/**
 * انتخاب نژاد حیوان در فروشگاه.
 * وقتی موجودی داده شود، نژادهای خارج از توانِ خرید با 💸 مشخص می‌شوند تا
 * بازیکن پیش از ورود به جریان، واقعیتِ حسابش را ببیند.
 */
export function buildPetAdoptKeyboard(
  kinds: Array<{ key: string; name: string; emoji: string; price: number }>,
  balance?: number
) {
  const keyboard = new InlineKeyboard()
  for (const kind of kinds) {
    const affordable = balance === undefined || balance >= kind.price
    const mark = affordable ? '' : ' 💸'
    keyboard.text(
      `${kind.emoji} ${kind.name} · ${kind.price.toLocaleString('fa-IR')}${mark}`,
      `pet:adopt:${kind.key}`
    ).row()
  }
  keyboard.text('بازگشت', 'pet:main').row().text('بستن', 'panel:close')
  keyboard.row().text('❓ شرایط نگهداری', 'help:topic:pets')
  return keyboard
}

/** صفحهٔ بازبینیِ سرپرستی: یک تأیید صریح، یا بازگشت به فروشگاه. */
export function buildPetReviewKeyboard(kindKey: string, affordable: boolean) {
  const keyboard = new InlineKeyboard()
  if (affordable) {
    keyboard
      .add({
        text: '✅ تأیید و انتخاب نام',
        callback_data: `pet:adopt_go:${kindKey}`,
        style: 'success'
      })
      .row()
  }
  keyboard.text('🛒 نژادهای دیگر', 'pet:shop').row().text('بستن', 'panel:close')
  return keyboard
}

/**
 * پنل حیوان خانگی.
 * `canPlay`: امروز بازی نکرده و بیمار نیست؛ `canFeed`: امروز سیر نشده.
 */
export function buildPetKeyboard(
  hasPet: boolean,
  canFeed: boolean,
  bonusReady: boolean,
  canPlay = false
) {
  const keyboard = new InlineKeyboard()
  if (!hasPet) {
    keyboard.text('🐾 فروشگاه حیوان', 'pet:shop').row()
  } else {
    if (canFeed) {
      keyboard.add({ text: '🍽️ غذا دادن', callback_data: 'pet:feed', style: 'primary' }).row()
    }
    if (canPlay) {
      keyboard.add({ text: '🎾 بازی کردن', callback_data: 'pet:play', style: 'primary' }).row()
    }
    if (bonusReady) {
      keyboard.add({ text: '🎁 هدیهٔ امروز', callback_data: 'pet:bonus', style: 'success' }).row()
    }
  }
  keyboard.text('🔄 به‌روزرسانی', 'pet:main').text('بستن', 'panel:close')
  keyboard.row().text('❓ راهنمای حیوان خانگی', 'help:topic:pets')
  return keyboard
}

/**
 * صفحهٔ بازیابی پس از شکستِ سرپرستی: راهِ برگشت به فروشگاه همیشه باز است.
 * پیش‌تر پس از خطا فقط دکمهٔ «انصراف» می‌آمد و بازیکن نمی‌دانست از کجا دوباره
 * شروع کند.
 */
export function buildPetRecoveryKeyboard() {
  return new InlineKeyboard()
    .add({ text: '🛒 بازگشت به فروشگاه حیوان', callback_data: 'pet:shop', style: 'primary' })
    .row()
    .text('🐾 پنل حیوان', 'pet:main')
    .text('❓ شرایط و قواعد', 'help:topic:pets')
    .row()
    .add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
}

/** حراجی منطقه. */
export function buildAuctionKeyboard(canBid: boolean, minNextBid: number) {
  const keyboard = new InlineKeyboard()
  if (canBid) {
    keyboard
      .add({ text: '🔨 ثبت پیشنهاد', callback_data: 'auc:start_bid', style: 'success' })
      .row()
  }
  keyboard.text('🔄 به‌روزرسانی', 'auc:main').row().text('بستن', 'panel:close')
  void minNextBid
  return keyboard
}

/** انصراف از ورود مبلغ پیشنهاد. */
export function buildAuctionCancelKeyboard() {
  return new InlineKeyboard().add({
    text: 'انصراف',
    callback_data: 'auc:cancel_bid',
    style: 'danger'
  })
}

/** باشگاه ورزشی. */
export function buildGymKeyboard(isActive: boolean) {
  const keyboard = new InlineKeyboard()
  keyboard
    .add({
      text: isActive ? '🛡️ تمدید عضویت' : '💪 خرید عضویت هفتگی',
      callback_data: 'gym:subscribe',
      style: 'success'
    })
    .row()
  keyboard.text('🏥 درمانگاه', 'clinic:main').text('🔄 به‌روزرسانی', 'gym:main')
  keyboard.row().text('بستن', 'panel:close')
  return keyboard
}

/** قرض بازیکنی: درخواست‌ها و اقساط. */
export function buildLoansKeyboard(
  requests: Array<{ id: string }>,
  activeBorrowings: Array<{ id: string }>
) {
  const keyboard = new InlineKeyboard()
  for (const request of requests) {
    keyboard
      .text('✅ پرداخت', `loan:accept:${request.id}`)
      .text('❌ رد', `loan:reject:${request.id}`)
      .row()
  }
  for (const loan of activeBorrowings) {
    keyboard.add({
      text: '💳 تسویهٔ قرض',
      callback_data: `loan:repay:${loan.id}`,
      style: 'primary'
    }).row()
  }
  keyboard
    .add({ text: '➕ درخواست قرض جدید', callback_data: 'loan:start_request', style: 'primary' })
    .row()
  keyboard.text('🔄 به‌روزرسانی', 'loan:main').row().text('بستن', 'panel:close')
  return keyboard
}

/** چالش جمعی منطقه. */
export function buildChallengeKeyboard(canClaim: boolean, inGroup: boolean) {
  const keyboard = new InlineKeyboard()
  if (canClaim) {
    keyboard.add({ text: '🎁 دریافت پاداش', callback_data: 'chal:claim', style: 'success' }).row()
  }
  if (inGroup) {
    keyboard.text('🔄 به‌روزرسانی', 'chal:main').row()
  }
  keyboard.text('بستن', 'panel:close')
  return keyboard
}

/** سیاست‌های شهردار. */
export function buildPolicyKeyboard(
  policies: Array<{ key: string; title: string; emoji: string }>,
  isMayor: boolean
) {
  const keyboard = new InlineKeyboard()
  if (isMayor) {
    for (const policy of policies) {
      keyboard.text(`${policy.emoji} ${policy.title}`, `pol:set:${policy.key}`).row()
    }
  }
  keyboard.text('🔄 به‌روزرسانی', 'pol:main').row().text('بستن', 'panel:close')
  return keyboard
}

/** شعب کسب‌وکار: افتتاح و برداشت درآمد. */
export function buildBranchKeyboard(
  branches: Array<{ id: string; regionTitle: string; pendingIncome: number }>,
  hasBusinesses: boolean,
  regions: Array<{ id: string; title: string }>
) {
  const keyboard = new InlineKeyboard()
  for (const branch of branches) {
    if (branch.pendingIncome > 0) {
      keyboard.add({
        text: `💰 برداشت از شعبهٔ ${branch.regionTitle}`,
        callback_data: `br:collect:${branch.id}`,
        style: 'success'
      }).row()
    }
  }
  if (hasBusinesses) {
    for (const region of regions.slice(0, 4)) {
      keyboard.text(`🏢 شعبه در ${region.title}`, `br:open:${region.id}`).row()
    }
  }
  keyboard.text('🔄 به‌روزرسانی', 'br:main').row().text('بستن', 'panel:close')
  return keyboard
}

/** انتخاب کسب‌وکار برای افتتاح شعبه وقتی چند کسب‌وکار فعال است. */
export function buildBranchBusinessKeyboard(
  regionId: string,
  businesses: Array<{ id: string; name: string }>
) {
  const keyboard = new InlineKeyboard()
  for (const business of businesses.slice(0, 8)) {
    keyboard.text(`🏢 ${business.name}`, `br:pick:${regionId}:${business.id}`).row()
  }
  keyboard.text('بازگشت', 'br:main').row().text('بستن', 'panel:close')
  return keyboard
}

/** آگهی همگانی: شروع نوشتن متن. */
export function buildAdsKeyboard() {
  return new InlineKeyboard()
    .add({ text: '📣 انتشار آگهی', callback_data: 'ad:start', style: 'primary' })
    .row()
    .text('🔄 به‌روزرسانی', 'ad:main')
    .row()
    .text('بستن', 'panel:close')
}

/** انصراف از نوشتن آگهی. */
export function buildAdsCancelKeyboard() {
  return new InlineKeyboard().add({
    text: 'انصراف',
    callback_data: 'ad:cancel',
    style: 'danger'
  })
}

/**
 * پنل پشتیبانی: انتخاب دستهٔ گزارش + به‌روزرسانی + بستن.
 *
 * چرا اول دسته؟ با یک کلیک، ادمین می‌فهمد گزارش فنی است یا مالی یا رفتاری؛
 * بازیکن هم مجبور نیست در متن توضیح بدهد «مشکل از کدام نوع است».
 * اگر سقف گزارش‌های بی‌پاسخ پر شده باشد، دکمه‌های ثبت ساخته *نمی‌شوند* —
 * دکمه‌ای که می‌داند رد می‌شود نباید وجود داشته باشد.
 */
export function buildSupportKeyboard(view: { canOpenNew: boolean }) {
  const keyboard = new InlineKeyboard()
  if (view.canOpenNew) {
    keyboard
      .add({ text: '🐞 ایراد فنی', callback_data: 'sup:new:BUG', style: 'primary' })
      .text('💸 مشکل مالی', 'sup:new:MONEY')
      .row()
      .add({ text: '🙋 رفتار بازیکن', callback_data: 'sup:new:BEHAVIOR' })
      .text('🗂️ سایر موارد', 'sup:new:OTHER')
      .row()
  }
  keyboard.text('🔄 به‌روزرسانی', 'sup:main').row().text('بستن', 'panel:close').row()
  return keyboard
}

/** انصراف از نوشتن گزارش (پیش از ذخیره). */
export function buildSupportCancelKeyboard() {
  return new InlineKeyboard().add({
    text: 'انصراف',
    callback_data: 'sup:cancel',
    style: 'danger'
  })
}


// ---------- 📜 وصیت و میراث ----------

/**
 * کیبورد وصیت.
 *
 * سلسله‌مراتب دکمه‌ها عمدی است: عملِ اصلی (انتخاب/تغییر وارث) تنها دکمهٔ
 * سبز است، «لغو وصیت» قرمز است چون برگشت‌ناپذیر است و بقیه خنثی می‌مانند.
 * وقتی وارثِ فعلی نامعتبر شده (فوت/محرومیت)، دکمه دوباره «انتخاب وارث»
 * می‌شود تا بازیکن در بن‌بست نماند.
 */
export function buildWillKeyboard(view: {
  isDead: boolean
  hasWill: boolean
  heirInvalidReason: string | null
  note: string | null
}) {
  const keyboard = new InlineKeyboard()
  if (view.isDead) {
    return keyboard.text('بستن', 'panel:close')
  }

  if (!view.hasWill || view.heirInvalidReason) {
    keyboard.add({ text: '👤 انتخاب وارث', callback_data: 'will:set', style: 'success' })
  } else {
    keyboard.add({ text: '👤 تغییر وارث', callback_data: 'will:set' })
    keyboard.text(view.note ? '✍️ ویرایش یادداشت' : '✍️ یادداشت وصیت', 'will:note').row()
    keyboard.add({ text: '🗑️ لغو وصیت', callback_data: 'will:cancel', style: 'danger' })
  }

  keyboard.row().text('⚖️ قوانین میراث', 'will:rules').text('بستن', 'panel:close')
  return keyboard
}

/** دکمهٔ انصراف جریان‌های ورودیِ وصیت (ریپلای/یوزرنیم/یادداشت). */
export function buildWillInputCancelKeyboard() {
  return new InlineKeyboard().text('↩️ انصراف', 'will:main')
}

/**
 * دکمه‌های صندوق اعلان.
 *
 * تنها کنشِ نوشتاری «خواندم» است، و همان یک کنش کل چرخهٔ خوانده‌شدن را
 * می‌بندد: نشان‌گذاری ناخوانده‌ها، و اینکه سیاست نگهداری بتواند اعلان‌های
 * خوانده‌شده را زودتر پاک کند. بدون این دکمه، وضعیتِ اعلان‌ها برای همیشه
 * «در انتظار» می‌ماند.
 *
 * دکمه فقط وقتی می‌آید که واقعاً چیزی برای خواندن باشد؛ دکمهٔ بی‌اثر
 * صفحه را شلوغ می‌کند.
 */
export function buildNotificationsKeyboard(unreadCount: number) {
  const keyboard = new InlineKeyboard()
  if (unreadCount > 0) {
    keyboard.add({
      text: `✅ همه را خواندم (${fa(unreadCount)})`,
      callback_data: 'notif:read_all',
      style: 'success'
    })
    keyboard.row()
  }
  keyboard.text('🔄 به‌روزرسانی', 'notif:refresh').text('بستن', 'panel:close')
  return keyboard
}

/** دکمه‌های پنل «زندگی من» — ورودی کشفِ وصیت برای بازیکنی که دنبالش نمی‌گردد. */
export function buildLifeMenuKeyboard() {
  return new InlineKeyboard()
    .add({ text: '📜 وصیت و میراث', callback_data: 'will:main' })
    .row()
    .text('بستن', 'panel:close')
}
