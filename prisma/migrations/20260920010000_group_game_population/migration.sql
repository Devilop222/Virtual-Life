-- جمعیتِ بازی از «شمارِ اعضای تلگرام» جدا شد.
--
-- چرا؟ سطحِ محیط (روستا/شهر/استان/کشور) از روی `real_member_count` حساب
-- می‌شد؛ یعنی شمارِ اعضای *تلگرام* منهای ربات‌های مدیر. آن عدد در بازی معنایی
-- ندارد: عضوی که هرگز شخصیت نساخته، هرگز کلیدواژه‌ای نفرستاده و هیچ‌جای اقتصاد
-- بازی نیست، منطقه را یک پله ارتقا می‌داد. ربات‌هایی هم که مدیر نبودند در
-- شمارش می‌ماندند.
--
-- ستونِ تازه `game_population` تنها معیارِ سطح است: شمارِ *بازیکنان* دارای
-- عضویتِ فعال در همان منطقه (`player_groups.status = 'ACTIVE'`).
-- `real_member_count` می‌مانَد، ولی فقط برای نمایش (اعضای تلگرام).

ALTER TABLE "groups" ADD COLUMN "game_population" INTEGER NOT NULL DEFAULT 0;

-- پُرکردن از دادهٔ موجود تا پنل‌ها بعد از مهاجرت «۰ شهروند» نشان ندهند.
UPDATE "groups" g
SET "game_population" = (
  SELECT COUNT(*)::int
  FROM "player_groups" pg
  WHERE pg."group_id" = g."id" AND pg."status" = 'ACTIVE'
);

-- سطحِ محیط باید با معیارِ تازه بازمحاسبه شود؛ وگرنه منطقه‌ای که با شمارِ
-- اعضای تلگرام «شهر» شده بود با همان سطحِ قدیمی می‌ماند.
UPDATE "groups" SET "environment_level" = (CASE
  WHEN "game_population" <= 14 THEN 'VILLAGE'
  WHEN "game_population" <= 30 THEN 'CITY'
  WHEN "game_population" <= 50 THEN 'PROVINCE'
  ELSE 'COUNTRY'
END)::"GroupEnvironmentLevel";
