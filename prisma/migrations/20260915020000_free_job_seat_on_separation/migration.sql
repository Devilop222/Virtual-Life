-- صندلیِ آگهی هرگز آزاد نمی‌شد: `hired_count` فقط زیاد می‌شد و آگهیِ پُر
-- خودکار بسته می‌ماند. در نتیجه کارفرما پس از هر اخراج/استعفا مجبور بود
-- آگهیِ تازه بزند و شمارندهٔ ظرفیت برای همیشه مصرف می‌شد.
--
-- برای آزادکردنِ صندلیِ درست، باید بدانیم هر استخدام از کدام آگهی آمده است.
ALTER TABLE "business_employees" ADD COLUMN "job_posting_id" TEXT;

-- بسته‌شدنِ دستی از بسته‌شدنِ خودکار تفکیک می‌شود تا آگهیِ دستی‌بسته
-- با خالی‌شدنِ صندلی دوباره باز نشود.
ALTER TABLE "job_postings" ADD COLUMN "closed_by_owner" BOOLEAN NOT NULL DEFAULT false;

-- آگهی‌هایی که تا امروز پُر شده و بسته شده‌اند، دستی فرض نمی‌شوند؛
-- ولی چون شمارِ واقعیِ کارمندان‌شان معلوم نیست، دست‌نخورده می‌مانند.

ALTER TABLE "business_employees"
  ADD CONSTRAINT "business_employees_job_posting_id_fkey"
  FOREIGN KEY ("job_posting_id") REFERENCES "job_postings"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "business_employees_job_posting_id_idx" ON "business_employees"("job_posting_id");
