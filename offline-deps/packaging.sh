#!/usr/bin/env bash
# ============================================================================
# ساخت دوبارهٔ بستهٔ آفلاین (فقط روی دستگاهی با اینترنت و دسترسی به npm)
# Rebuilds the offline deployment bundle from the repo root.
#
# خروجی:
#   offline-deps/node_modules-linux.tar.gz   (وابستگی‌های زمان اجرا — x64 و arm64)
#   offline-deps/dist.tar.gz                 (خروجی کامپایل — مستقل از پلتفرم)
# ============================================================================
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || dirname "$0")"
ROOT="$(pwd)"

echo "==> [1/6] fresh full install (npm registry required)"
rm -rf node_modules
npm ci --registry=https://registry.npmjs.org --no-audit --no-fund

echo "==> [2/6] build (prisma generate + tsc + seed compile)"
# `tsc` خروجیِ فایل‌های حذف‌شده را پاک نمی‌کند. بدون این خط، یک بازسازی روی
# درختِ کاریِ آلوده، ماژول‌های مردهٔ قابلیت‌های حذف‌شده را داخل بسته می‌فرستد
# (کدِ کامپایل‌شده‌ای که کلاینتِ تازه دیگر مدل‌هایش را نمی‌شناسد).
rm -rf dist
export DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
# موتور اسکیمای Prisma در خود مخزن موجود است (prisma-engines) — نصب آفلاین.
# git بیت اجرا را روی برخی checkoutها نگه نمی‌دارد و Prisma این فایل را spawn می‌کند،
# پس یک کپی اجرایی در مسیر موقت ساخته می‌شود تا ساختِ بسته به EACCES نخورد.
SCHEMA_ENGINE="$(mktemp -d)/schema-engine"
cp "$ROOT/prisma-engines/schema-engine.gz" "$SCHEMA_ENGINE"
chmod +x "$SCHEMA_ENGINE"
export PRISMA_SCHEMA_ENGINE_BINARY="$SCHEMA_ENGINE"
node node_modules/prisma/build/index.js generate
node node_modules/typescript/bin/tsc
node node_modules/typescript/bin/tsc prisma/seed.ts --outDir dist \
  --target ES2022 --module CommonJS --moduleResolution node --esModuleInterop --skipLibCheck --strict
# `dist/seed.js` از خروجیِ `tsc` اصلی نمی‌آید (جدا کامپایل می‌شود)، پس یک
# بازسازیِ دستی که فقط `tsc` را بزند آن را جا می‌گذارد و بستهٔ ناقص بی‌صدا
# منتشر می‌شود؛ آن‌وقت نصبِ تازه در گام `run_seed` می‌افتد. ساخت همین‌جا
# قطعی می‌شود تا هرگز تاربالِ ناقص ساخته نشود.
[ -f dist/seed.js ] || { echo "ERROR: dist/seed.js ساخته نشد — کامپایل seed شکست خورد" >&2; exit 1; }

echo "==> [3/6] trim to production-only runtime"
npm prune --omit=dev --no-audit --no-fund
# CLI و وابستگی‌های اختصاصی آن در سرور مقصد استفاده نمی‌شوند
# (مهاجرت‌ها با offline-deps/scripts/migrate.js انجام می‌شود)
rm -rf node_modules/prisma node_modules/typescript \
       node_modules/@prisma/config node_modules/@prisma/engines \
       node_modules/@prisma/fetch-engine node_modules/@prisma/get-platform \
       node_modules/@prisma/engines-version
# زمان‌های اجرای WASM برای دیتابیس‌های دیگر هرگز استفاده نمی‌شوند (provider ثابت postgresql است)
cd node_modules/@prisma/client/runtime
rm -f query_engine_bg.mysql.* query_engine_bg.sqlite.* query_engine_bg.sqlserver.* query_engine_bg.cockroachdb.* \
      query_compiler_bg.mysql.* query_compiler_bg.sqlite.* query_compiler_bg.sqlserver.* query_compiler_bg.cockroachdb.*
cd "$ROOT"

echo "==> [4/6] sanity check"
node -e "require('@prisma/client'); require('@prisma/adapter-pg'); require('pg'); require('grammy'); console.log('requires OK')"
if find node_modules -name "*.so.node" | grep -q .; then
  echo "ERROR: native engine present in bundle" >&2
  exit 1
fi
du -sh node_modules dist

echo "==> [4.5/6] build stamp (so install.sh can detect a stale dist)"
# مهر ساخت: کامیت و زمانِ ساختِ همین بسته. `install.sh` این فایل را می‌خواند و
# اگر با کامیتِ مخزن نخواند، هشدار می‌دهد — چون اسکریپت نصب هیچ‌وقت کامپایل
# نمی‌کند و بستهٔ کهنه بی‌صدا اجرا می‌شود.
BUILD_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > dist/BUILD_INFO.json <<EOF
{
  "commit": "$BUILD_COMMIT",
  "builtAt": "$BUILD_TIME",
  "node": "$(node -v)"
}
EOF
cat dist/BUILD_INFO.json

echo "==> [5/6] tarballs (owner normalized to 0/0 so target machines never chown to a user that does not exist there)"
rm -rf node_modules/.cache
tar --owner=0 --group=0 --numeric-owner -czf offline-deps/node_modules-linux.tar.gz -C . node_modules
tar --owner=0 --group=0 --numeric-owner -czf offline-deps/dist.tar.gz -C . dist
ls -la offline-deps/node_modules-linux.tar.gz offline-deps/dist.tar.gz

echo "==> [5.5/6] client/schema parity gate"
# دروازهٔ سخت: اگر کلاینتِ Prismaِ داخل بسته با prisma/schema.prisma نخواند،
# بسته هرگز نباید ساخته/کامیت شود. سرورِ بدون اینترنت کلاینت را بازتولید
# نمی‌کند، پس ناسازگاری در آن‌جا فقط با خطای زمان اجرا خودش را نشان می‌دهد.
node scripts/offline-client-parity-check.cjs

echo "==> [6/6] done"
