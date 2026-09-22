#!/usr/bin/env bash
# ============================================================================
# 🎮 میراث (Legacy Game) — نصب‌کنندهٔ آفلاین برای سرور سندباکس (Daytona و هر لینوکسی)
# ----------------------------------------------------------------------------
# همهٔ پیش‌نیازها (Node.js، وابستگی‌های برنامه، PostgreSQL) از همین پوشه
# offline-deps برداشته می‌شوند — نیازی به دانلود از اینترنت نیست.
#
# استفاده:
#   bash offline-deps/install.sh            # نصب کامل + راه‌اندازی ربات
#   bash offline-deps/install.sh start      # فقط استارت ربات
#   bash offline-deps/install.sh stop       # فقط استاپ ربات
#   bash offline-deps/install.sh status     # وضعیت ربات و دیتابیس
#   bash offline-deps/install.sh update     # اعمال آپدیت کدها + مهاجرت + رستارت
#   bash offline-deps/install.sh reset --yes  # پاکسازیِ کاملِ وضعیتِ ربات (نصبِ از صفر)
#   bash offline-deps/install.sh restore ID # بازگرداندن دادهٔ بازی از یک بکاپ
#   bash offline-deps/install.sh --url=postgresql://…   # هدف‌گرفتنِ دیتابیسِ خارجی
# ----------------------------------------------------------------------------
# «کدام دیتابیس؟» یک قاعده دارد: `--url=…` > `.env`. متغیرِ محیطیِ شل هدف را
# عوض نمی‌کند (اگر بگذاری، فقط هشدار می‌گیری) — چون یک `export` جامانده
# در ترمینال، نصب را روی دیتابیسِ اشتباه می‌برد.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOLS_DIR="$REPO_ROOT/.tools"
# همان دو مسیری که `DeployService` می‌سازد/می‌خواند.
UPDATE_STATE="$TOOLS_DIR/update.state.json"
UPDATE_LOCK="$TOOLS_DIR/update.lock"
ENV_FILE="$REPO_ROOT/.env"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ARCH_KEY="x64" ;;
  aarch64|arm64) ARCH_KEY="arm64" ;;
  *) echo "❌ معماری پردازندهٔ ناشناخته: $ARCH (فقط x64 و arm64 پشتیبانی می‌شود)"; exit 1 ;;
esac

# ── «کدام دیتابیس؟» — یک ورودیِ صریح، ثبت‌شده پیش از هر کار ──────────────────
# متغیرِ محیطیِ شل در کل این اسکریپت *هدف را تعیین نمی‌کند* (دلیلِ کامل در
# `resolve_db_target`). ولی مقدارش حفظ می‌شود تا اگر با هدف فرق داشت، اپراتور
# بفهمد یک `export` جامانده در همین ترمینال داشته است.
DATABASE_URL_AMBIENT="${DATABASE_URL:-}"
DB_URL_ARG=""
for _arg in "$@"; do
  case "$_arg" in
    --url=*) DB_URL_ARG="${_arg#--url=}" ;;
    --url)   echo "✘ --url باید با «=» بیاید:  --url=postgresql://user@host:5432/dbname"; exit 1 ;;
  esac
done

DB_NAME="virtual_life"
DB_USER="virtual_life"
# اگر کاربر PG_PORT را صریحاً گذاشته، همان محترم است (اشغال بودنش خطا می‌شود).
# وگرنه اسکریپت پورت آزاد پیدا می‌کند و در .tools/.pgport به خاطر می‌سپارد.
if [ -n "${PG_PORT:-}" ]; then
  PG_PORT_EXPLICIT=1
else
  PG_PORT_EXPLICIT=0
  PG_PORT="5432"
fi
NODE_VERSION="v22.22.3"

info() { echo -e "\n\033[1;34m»»»\033[0m $*"; }
ok()   { echo -e "\033[1;32m✔\033[0m $*"; }
warn() { echo -e "\033[1;33m▲\033[0m $*"; }
die()  { echo -e "\033[1;31m✘ $*\033[0m"; exit 1; }

# وضعیتِ عملیاتِ بکاپ/بازیابی را در همان قالبی می‌نویسد که
# `src/modules/ops/ops-state.ts` می‌خواند. مقادیر از متغیر محیطی می‌آیند تا
# هیچ رشته‌ای داخل کد sh جا نشود؛ نقل‌قول‌گذاریِ شل اگر مستقیم در JSON بنشیند،
# قالبی می‌سازد که پارسر نمی‌تواند بخواند و مالک هیچ نتیجه‌ای نمی‌بیند.
set_ops_state() {
  local phase="$1" message="$2" backup_id="${3:-}"
  mkdir -p "$TOOLS_DIR"
  OPS_PHASE="$phase" OPS_MESSAGE="$message" OPS_BACKUP_ID="$backup_id" \
    OPS_STATE_PATH="$TOOLS_DIR/ops.state.json" \
    "$NODE_BIN" -e '
      const fs = require("fs");
      let prev = {};
      try { prev = JSON.parse(fs.readFileSync(process.env.OPS_STATE_PATH, "utf8")); } catch (e) { prev = {}; }
      fs.writeFileSync(process.env.OPS_STATE_PATH, JSON.stringify({
        phase: process.env.OPS_PHASE,
        operation: "restore",
        startedAt: prev.startedAt || new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        message: process.env.OPS_MESSAGE,
        backupId: process.env.OPS_BACKUP_ID || null,
        actorId: process.env.OPS_ACTOR_ID || prev.actorId || null
      }, null, 2));
    ' >/dev/null 2>&1 || warn "نوشتن وضعیت ممکن نشد"
}

# وضعیتِ استقرار را در همان قالبی می‌نویسد که
# `src/modules/deploy/deploy.service.ts` می‌خواند.
#
# چرا خودِ اسکریپت باید بنویسد؟ چون فرآیندِ استقرار **detached** است: ربات
# فقط «شروع شد» را می‌نویسد و بعد می‌میرد. اگر نتیجهٔ پایانی را کسی ننویسد،
# حالت تا ابد «در حال اجرا» می‌ماند و رباتِ تازه بالا آمده به مالک می‌گوید
# «اجرا نیمه‌کاره ماند» — حتی وقتی همه‌چیز موفق بوده. یعنی مالک هیچ‌وقت
# نتیجهٔ واقعی را نمی‌دید.
set_deploy_state() {
  local phase="$1" message="$2" finished="true"
  [ "$phase" = "running" ] && finished="false"
  mkdir -p "$TOOLS_DIR"
  DEPLOY_PHASE="$phase" DEPLOY_MESSAGE="$message" DEPLOY_FINISHED="$finished" \
    DEPLOY_STATE_PATH="$UPDATE_STATE" \
    "$NODE_BIN" -e '
      const fs = require("fs");
      const p = process.env.DEPLOY_STATE_PATH;
      let prev = {};
      try { prev = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { prev = {}; }
      const running = process.env.DEPLOY_PHASE === "running";
      fs.writeFileSync(p, JSON.stringify({
        phase: process.env.DEPLOY_PHASE,
        startedAt: running ? new Date().toISOString() : (prev.startedAt || new Date().toISOString()),
        finishedAt: running ? null : new Date().toISOString(),
        message: process.env.DEPLOY_MESSAGE,
        targetCommit: prev.targetCommit || null,
        remoteReachable: prev.remoteReachable === undefined ? null : prev.remoteReachable,
        actorId: prev.actorId || null
      }, null, 2));
    ' >/dev/null 2>&1 || warn "نوشتن وضعیت استقرار ممکن نشد"
}

# آزادکردنِ قفلِ استقرار که ربات پیش از پرتابِ همین فرآیند ساخته است.
# بدون این، قفلِ کهنه تا انقضای زمانی (۲۰ دقیقه) می‌ماند و پنل به مالک
# می‌گوید «یک به‌روزرسانی در جریان است»، در حالی که تمام شده.
release_deploy_lock() {
  rm -f "$UPDATE_LOCK" 2>/dev/null || true
}

get_env() {
  grep -E "^[[:space:]]*$1[[:space:]]*=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" || true
}
set_env() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  grep -vE "^[[:space:]]*$key[[:space:]]*=" "$ENV_FILE" > "$tmp" || true
  echo "$key=$val" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# ══════════════════ هدفِ دیتابیس — تنها قاعدهٔ «کدام دیتابیس؟» ══════════════════
# ریشهٔ یک باگِ واقعی: نصب‌کننده دیتابیسِ داخلی را روی ۵۴۳۲ می‌ساخت و در `.env`
# ثبت می‌کرد، ولی گامِ بعد (`db-setup.js`) آدرس را از *متغیرِ محیطیِ شل* می‌خواند.
# یک `export DATABASE_URL=…5433…` جامانده در ترمینالِ اپراتور کافی بود تا نصب با
# «خطا در ساخت دیتابیس: connect ECONNREFUSED 127.0.0.1:5433» بمیرد — در حالی که
# دیتابیسِ درست چند لحظه قبل روی ۵۴۳۲ بالا آمده بود. عددِ ۵۴۳۳ هیچ‌جای کد نبود.
#
# قاعدهٔ نهایی: برای install/update/start/restore، هدف همان چیزی است که در `.env`
# ثبت شده (قراردادِ استقرار)؛ `--url=…` تنها راهِ صریحِ رد کردنِ آن است. متغیرِ
# محیطیِ شل هرگز هدف را عوض نمی‌کند — فقط اگر با هدف فرق داشت، یک‌بار گفته می‌شود.
DB_TARGET_URL=""
DB_TARGET_SOURCE=""
DB_TARGET_WARNED=0

# آدرسِ بی‌رمز برای پیام‌ها: رمز هرگز چاپ نمی‌شود (ترمینال و لاگ اپراتور).
redact_url() {
  printf '%s' "$1" | sed -E 's#(://[^:/@]*):[^@/]*@#\1@#'
}

resolve_db_target() {
  local from_file
  from_file="$(get_env DATABASE_URL)"
  if [ -n "$DB_URL_ARG" ]; then
    DB_TARGET_URL="$DB_URL_ARG"
    DB_TARGET_SOURCE="آرگومان --url"
  elif [ -n "$from_file" ]; then
    DB_TARGET_URL="$from_file"
    DB_TARGET_SOURCE="فایل .env"
  else
    DB_TARGET_URL=""
    DB_TARGET_SOURCE=""
  fi
  # از این لحظه، هر فرآیندِ فرزند (node، prisma، seed) همین آدرس را می‌بیند.
  export DATABASE_URL="$DB_TARGET_URL"

  if [ "$DB_TARGET_WARNED" -eq 0 ] && [ -n "${DATABASE_URL_AMBIENT:-}" ] && [ "$DATABASE_URL_AMBIENT" != "$DB_TARGET_URL" ]; then
    DB_TARGET_WARNED=1
    warn "متغیرِ محیطیِ DATABASE_URL در این ترمینال با هدفِ نصب فرق دارد و نادیده گرفته می‌شود:"
    warn "   محیط: $(redact_url "$DATABASE_URL_AMBIENT")"
    warn "   هدف:  $(redact_url "$DB_TARGET_URL")"
    warn "   برای هدف‌گرفتنِ عمدی: آدرس را در .env بگذارید، یا --url=postgresql://… بدهید."
  fi
  if [ -n "$DB_TARGET_URL" ]; then
    info "دیتابیسِ هدف: $(redact_url "$DB_TARGET_URL") — از $DB_TARGET_SOURCE"
  fi
}

# ---------------------------------------------------------------- Node.js
resolve_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "${major:-0}" -ge 18 ]; then
      NODE_BIN="$(command -v node)"
      ok "Node.js سیستمی پیدا شد: $("${NODE_BIN}" --version) — از همان استفاده می‌شود"
      return 0
    fi
    echo "⚠ Node.js سیستمی خیلی قدیمی است؛ نسخهٔ آفلاین استفاده می‌شود"
  fi
  local tarball="$SCRIPT_DIR/node-$NODE_VERSION-linux-$ARCH_KEY.tar.xz"
  if [ -f "$tarball" ]; then
    local prefix="$TOOLS_DIR/node-$NODE_VERSION-linux-$ARCH_KEY"
    if [ ! -x "$prefix/bin/node" ]; then
      mkdir -p "$TOOLS_DIR"
      info "نصب Node.js آفلاین ($NODE_VERSION / $ARCH_KEY) ..."
      # --no-same-owner: tarball‌ها ممکن است با uid/gid دستگاهِ سازنده ساخته شده باشند؛
      # فایل‌ها باید مالِ کاربرِ اجرای اسکریپت باشند (وگرنه chown با «Invalid argument» می‌افتد)
      tar --no-same-owner -xJf "$tarball" -C "$TOOLS_DIR"
    fi
    NODE_BIN="$prefix/bin/node"
    ok "Node.js آفلاین آماده: $("${NODE_BIN}" --version)"
    return 0
  fi
  # arm64 و بدون بستهٔ آفلاین: آخرین راه‌حل — apt (به اینترنت نیاز دارد)
  if command -v apt-get >/dev/null 2>&1; then
    info "بستهٔ آفلاین Node برای $ARCH_KEY موجود نیست؛ تلاش برای نصب با apt (به اینترنت نیاز دارد)..."
    if [ "$(id -u)" -eq 0 ]; then
      apt-get install -y nodejs || true
    else
      sudo apt-get update -qq && sudo apt-get install -y -qq nodejs
    fi
    if command -v node >/dev/null 2>&1; then
      local major ver
      major="$(node -p 'process.versions.node.split(".")[0]')"
      ver="$(node --version)"
      if [ "$major" -ge 18 ]; then
        NODE_BIN="$(command -v node)"
        ok "Node.js با apt نصب شد: $ver"
        return 0
      fi
    fi
  fi
  die "Node.js در دسترس نیست و بستهٔ آفلاین مناسبی هم وجود ندارد.
      راه‌حل: سندباکس را از روی تصویر (image) Node.js بساز، یا این خطا را برای پشتیبانی بفرست."
}

# ------------------------------------------------------------ PostgreSQL
port_busy() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&-; return 0; } || return 1
}

# پورت داخل DATABASE_URL (فقط اگر میزبان محلی باشد)
extract_local_url_port() {
  local url="$1"
  case "$url" in
    postgresql://*127.0.0.1:*|postgresql://*localhost:*|postgres://*127.0.0.1:*|postgres://*localhost:*)
      printf '%s' "$url" | sed -nE 's#^postgres(ql)?://[^/]*@[^/:]*:([0-9]+)/.*#\2#p'
      ;;
  esac
}

remembered_pg_port() {
  local p=""
  [ -f "$TOOLS_DIR/.pgport" ] && p="$(tr -d '[:space:]' < "$TOOLS_DIR/.pgport" 2>/dev/null || true)"
  case "$p" in
    ''|*[!0-9]*) ;;
    *) printf '%s' "$p" ;;
  esac
}

# خط ۴ فایل postmaster.pid شمارهٔ پورت واقعی نمونهٔ در حال اجراست
running_pg_port() {
  local pidfile="$TOOLS_DIR/pgdata/postmaster.pid" p=""
  [ -f "$pidfile" ] && p="$(sed -n '4p' "$pidfile" | tr -d '[:space:]')"
  case "$p" in
    ''|*[!0-9]*) ;;
    *) printf '%s' "$p" ;;
  esac
}

persist_pg_port() {
  mkdir -p "$TOOLS_DIR"
  printf '%s\n' "$1" > "$TOOLS_DIR/.pgport"
  PG_PORT="$1"
}

# پورت مؤثر برای status/start: نمونهٔ زنده > URL محلی > فایل ثبت‌شده > پیش‌فرض
effective_pg_port() {
  if [ "${PG_PORT_EXPLICIT:-0}" -eq 1 ]; then
    printf '%s' "$PG_PORT"
    return 0
  fi
  local u r live
  live="$(running_pg_port)"
  [ -n "$live" ] && { printf '%s' "$live"; return 0; }
  u="$(extract_local_url_port "$(get_env DATABASE_URL)")"
  [ -n "$u" ] && { printf '%s' "$u"; return 0; }
  r="$(remembered_pg_port)"
  [ -n "$r" ] && { printf '%s' "$r"; return 0; }
  printf '%s' "$PG_PORT"
}

# اگر preferred آزاد باشد همان؛ وگرنه اولین آزاد در 5432..5532
pick_free_pg_port() {
  local preferred="$1" p=5432
  if ! port_busy "$preferred"; then
    printf '%s' "$preferred"
    return 0
  fi
  while [ "$p" -le 5532 ]; do
    if [ "$p" -ne "$preferred" ] && ! port_busy "$p"; then
      printf '%s' "$p"
      return 0
    fi
    p=$((p + 1))
  done
  return 1
}

# ------------------------------------------------------------------ pg user
# PostgreSQL به‌عنوان root اجرا نمی‌شود. وقتی اسکریپت root باشد، فقط «بخش
# دیتابیس» با یک کاربر اختصاصی اجرا می‌شود؛ انتخاب کاربر به این ترتیب است:
#   ۱) کاربر ثبت‌شده در .tools/.pguser از نصب قبلی (اگر هنوز وجود دارد)
#      → نصب‌های در حال کار هرگز شکسته نمی‌شوند
#   ۲) غیر-root → خود کاربر جاری
#   ۳) root → کاربر سرویس موجود «postgres» (در توزیع‌ها/کانتینرها)
#   ۴) root → ساخت «حساب سرویس سیستمی» با نام استاندارد postgres:
#      useradd -r (سیستمی، UID پایین) + بدون شل ورودی (nologin) و بدون
#      ساخت خانه در /home (دادهٔ واقعی در .tools/pgdata است).
#      نگرانی‌ای نیست: نه runuser و نه شاخهٔ جایگزینِ su -s /bin/sh برای
#      اجرای initdb/pg_ctl به شل ورودی کاربر نیازی ندارند.
pg_user() {
  local recorded=""
  [ -f "$TOOLS_DIR/.pguser" ] && recorded="$(cat "$TOOLS_DIR/.pguser" 2>/dev/null || true)"
  if [ -n "$recorded" ] && id "$recorded" >/dev/null 2>&1; then
    echo "$recorded"
    return 0
  fi
  if [ "$(id -u)" -ne 0 ]; then
    whoami
    return 0
  fi
  if id postgres >/dev/null 2>&1; then
    info "کاربر سرویس «postgres» از قبل در سیستم موجود است — از همان استفاده می‌شود" >&2
    echo "postgres"
    return 0
  fi
  command -v useradd >/dev/null 2>&1 || die "ابزار useradd برای ساخت خودکار کاربر سرویس دیتابیس پیدا نشد"
  info "ساخت کاربر سرویس سیستمی «postgres» برای دیتابیس (فقط بار اول) ..." >&2
  local nologin="" s
  for s in /usr/sbin/nologin /sbin/nologin /usr/bin/false /bin/false; do
    [ -x "$s" ] && { nologin="$s"; break; }
  done
  [ -n "$nologin" ] || nologin="/usr/sbin/nologin"
  useradd -r -M -d /nonexistent -s "$nologin" postgres \
    || die "ساخت کاربر سرویس «postgres» ناموفق بود"
  ok "کاربر سرویس «postgres» ساخته شد (حساب سیستمی، بدون شل ورودی و بدون خانه در /home)" >&2
  echo "postgres"
}

# ------------------------------------------------------------------- pg run
# اجرای یک دستور با کاربر دیتابیس:
#   غیر-root → مستقیم |  root → ترجیحاً runuser و در نبودش:
#   su -s /bin/sh (پوستهٔ موقت؛ شل ورودی کاربر سرویس مهم نیست)
PG_OS_USER=""
PG_RUNNER=""
pg_run() {
  if [ "$(id -u)" -ne 0 ]; then
    "$@"
    return
  fi
  local u="${PG_OS_USER:-}"
  [ -n "$u" ] || u="$(cat "$TOOLS_DIR/.pguser" 2>/dev/null || true)"
  [ -n "$u" ] || die "کاربر سرویس دیتابیس مشخص نیست — ابتدا نصب کامل را اجرا کنید: bash offline-deps/install.sh"
  if [ -z "$PG_RUNNER" ]; then
    if command -v runuser >/dev/null 2>&1 && runuser -u "$u" -- true >/dev/null 2>&1; then
      PG_RUNNER="runuser"
    else
      PG_RUNNER="su"
    fi
  fi
  if [ "$PG_RUNNER" = "runuser" ]; then
    runuser -u "$u" -- "$@"
  else
    su -s /bin/sh "$u" -c "$(printf '%q ' "$@")"
  fi
}

ensure_local_postgres() {
  local pgroot="$TOOLS_DIR/postgres-linux-$ARCH_KEY"
  local bin="$pgroot/package/native/bin"
  local pgdata="$TOOLS_DIR/pgdata"

  if [ ! -x "$bin/postgres" ]; then
    [ -f "$SCRIPT_DIR/postgres-linux-$ARCH_KEY.tar.gz" ] || die "بستهٔ PostgreSQL برای $ARCH_KEY در offline-deps پیدا نشد"
    mkdir -p "$pgroot"
    info "آماده‌سازی PostgreSQL آفلاین ($ARCH_KEY) ..."
    tar --no-same-owner -xzf "$SCRIPT_DIR/postgres-linux-$ARCH_KEY.tar.gz" -C "$pgroot"
    if [ -f "$pgroot/package/scripts/hydrate-symlinks.js" ]; then
      (cd "$pgroot/package" && "$NODE_BIN" scripts/hydrate-symlinks.js) >/dev/null 2>&1 || true
    fi
  fi

  # آیا باینری اصلاً با این سیستم‌عامل سازگار است؟ (نیازمند glibc)
  "$bin/postgres" --version >/dev/null 2>&1 || die "باینری داخلی PostgreSQL روی این سیستم اجرا نشد.
      این باینری به glibc نیاز دارد (مثلاً روی Alpine کار نمی‌کند) — از تصویر مبتنی بر Ubuntu/Debian استفاده کنید."

  # کاربر سرویس دیتابیس را مشخص کن و برای اجراهای بعدی ثبت کن
  local pu
  pu="$(pg_user)"
  PG_OS_USER="$pu"
  mkdir -p "$TOOLS_DIR"
  echo "$pu" > "$TOOLS_DIR/.pguser"

  local already_running=0
  if [ -d "$pgdata" ] && pg_run "$bin/pg_ctl" -D "$pgdata" status >/dev/null 2>&1; then
    already_running=1
  fi

  # پورت هدف: صریح > نمونهٔ در حال اجرا > URL محلی > ثبت قبلی > پیش‌فرض
  local desired="$PG_PORT"
  if [ "$PG_PORT_EXPLICIT" -eq 0 ]; then
    local live urlp remembered
    live="$(running_pg_port)"
    urlp="$(extract_local_url_port "$(get_env DATABASE_URL)")"
    remembered="$(remembered_pg_port)"
    if [ -n "$live" ]; then
      desired="$live"
    elif [ -n "$urlp" ]; then
      desired="$urlp"
    elif [ -n "$remembered" ]; then
      desired="$remembered"
    fi
  fi

  if [ "$already_running" -eq 1 ]; then
    persist_pg_port "$desired"
    ok "PostgreSQL از قبل در حال اجرا بود (127.0.0.1:$PG_PORT)"
  else
    if port_busy "$desired"; then
      if [ "$PG_PORT_EXPLICIT" -eq 1 ]; then
        die "پورت $desired پیش‌تر در حال استفاده است.
        یا سرویس دیگری که روی این پورت اجراست را متوقف کنید،
        یا پورت دیگری بدهید:  PG_PORT=5433 bash offline-deps/install.sh
        یا بدون PG_PORT اجرا کنید تا اسکریپت خودش پورت آزاد پیدا کند."
      fi
      local alt=""
      alt="$(pick_free_pg_port "$desired")" || die "هیچ پورت آزادی در بازهٔ 5432–5532 برای PostgreSQL پیدا نشد.
        سرویس اشغال‌کننده را متوقف کنید یا PG_PORT را دستی بگذارید."
      if [ "$alt" != "$desired" ]; then
        warn "پورت $desired اشغال بود — دیتابیس داخلی روی 127.0.0.1:$alt راه‌اندازی می‌شود"
      fi
      desired="$alt"
    fi
    persist_pg_port "$desired"

    if [ ! -d "$pgdata" ]; then
      info "ساخت دیتابیس (initdb) — فقط بار اول ..."
      if [ "$(id -u)" -eq 0 ]; then
        mkdir -p "$pgdata"
        # pg.log و فایل سوکت یونیکس داخل .tools ساخته می‌شوند → مالکیت پوشه لازم است
        chown "$pu" "$TOOLS_DIR"
        chown -R "$pu" "$pgdata"
      fi
      pg_run "$bin/initdb" -D "$pgdata" -U "$DB_USER" -A trust --locale=C.UTF-8 >/dev/null
    fi

    info "راه‌اندازی PostgreSQL روی 127.0.0.1:$PG_PORT (با کاربر سرویس «$pu») ..."
    pg_run "$bin/pg_ctl" -D "$pgdata" -l "$TOOLS_DIR/pg.log" \
      -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$TOOLS_DIR" \
      -w start >/dev/null
    pg_run "$bin/pg_ctl" -D "$pgdata" status >/dev/null 2>&1 || die "PostgreSQL بعد از استارت بالا نیامد — لاگ: $TOOLS_DIR/pg.log"
    ok "PostgreSQL در حال اجرا است (127.0.0.1:$PG_PORT)"
  fi

  # آدرس اتصال را ثبت کن، بعد دیتابیس را (در صورت نبود) بساز
  set_env DATABASE_URL "postgresql://$DB_USER@127.0.0.1:$PG_PORT/$DB_NAME"
  ok "DATABASE_URL در .env ثبت شد (پورت $PG_PORT)"
  # هدف یک‌بار خوانده و **صریح** به db-setup داده می‌شود: گام‌های بعدی هیچ‌وقت
  # آدرس را از محیطِ شل حدس نمی‌زنند (همان باگی که این تابع از آن متولد شد).
  resolve_db_target
  "$NODE_BIN" "$SCRIPT_DIR/scripts/db-setup.js" "$REPO_ROOT" --url="$DB_TARGET_URL"
}

# قفلِ چرخهٔ بازیابی (خاموش/روشن کردن ربات).
# چرا جدا از قفلِ خودِ عملیات؟ دو لایه دو چیز را محافظت می‌کنند: این قفل
# نمی‌گذارد دو *چرخهٔ فرآیندی* هم‌زمان شوند (یکی ربات را خاموش کند و دیگری
# وسطِ کار روشنش کند)، و قفلِ درونِ برنامه نمی‌گذارد دو *عملیاتِ دیتابیس*
# هم‌زمان شوند. `mkdir` انتخاب شده چون اتمی است و در هر شلِ POSIX هست.
RESTORE_LOCK_DIR="$TOOLS_DIR/restore.lock"

acquire_restore_lock() {
  mkdir -p "$TOOLS_DIR"
  if mkdir "$RESTORE_LOCK_DIR" 2>/dev/null; then
    return 0
  fi
  # قفلِ رهاشده (فرآیندی که مُرد) پس از نیم‌ساعت خودش باز می‌شود؛ وگرنه یک
  # crash، بازیابی را تا ابد قفل می‌کرد.
  if [ -n "$(find "$RESTORE_LOCK_DIR" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
    rm -rf "$RESTORE_LOCK_DIR"
    mkdir "$RESTORE_LOCK_DIR" 2>/dev/null && return 0
  fi
  return 1
}

release_restore_lock() {
  rm -rf "$RESTORE_LOCK_DIR" 2>/dev/null || true
}

stop_postgres() {
  local pgroot="$TOOLS_DIR/postgres-linux-$ARCH_KEY"
  local bin="$pgroot/package/native/bin"
  if [ -x "$bin/postgres" ] && [ -d "$TOOLS_DIR/pgdata" ]; then
    pg_run "$bin/pg_ctl" -D "$TOOLS_DIR/pgdata" -m fast stop >/dev/null 2>&1 || true
    ok "PostgreSQL متوقف شد"
  fi
}

# ------------------------------------------------------------ deploy code
deploy_runtime() {
  info "استقرار وابستگی‌ها و کدهای آماده ..."
  # پیش از نابودکردنِ نصبِ فعلی، وجودِ بسته‌ها سنجیده می‌شود. گیرکردنِ `tar`
  # وسطِ کار (دیسکِ پر، آرشیوِ ناقص) یعنی `node_modules` نصفه و رباتِ خاموش؛
  # با این بررسی، نسخهٔ فعلی دست‌نخورده می‌ماند و خطا صریح است.
  [ -f "$SCRIPT_DIR/node_modules-linux.tar.gz" ] || die "بستهٔ node_modules-linux.tar.gz در offline-deps نیست — نسخهٔ فعلی دست‌نخورده ماند."
  [ -f "$SCRIPT_DIR/dist.tar.gz" ] || die "بستهٔ dist.tar.gz در offline-deps نیست — نسخهٔ فعلی دست‌نخورده ماند."
  rm -rf "$REPO_ROOT/node_modules"
  # --no-same-owner: tarball‌ها روی دستگاه دیگری ساخته می‌شوند و uid/gid آن دستگاه
  # (مثلاً 197609/197121) در سرور مقصد — یا کانتینر با user namespace محدود — وجود
  # ندارد؛ tar بدون این پرچم هنگام chown با «Invalid argument» خطا می‌دهد.
  # با این پرچم همهٔ فایل‌ها به مالکیتِ کاربرِ اجرای اسکریپت می‌افتند.
  tar --no-same-owner -xzf "$SCRIPT_DIR/node_modules-linux.tar.gz" -C "$REPO_ROOT"
  tar --no-same-owner -xzf "$SCRIPT_DIR/dist.tar.gz" -C "$REPO_ROOT"
  "$NODE_BIN" -e "require('@prisma/client');require('@prisma/adapter-pg');require('pg');require('grammy');console.log('   بررسی ماژول‌ها: سالم')" || die "بستهٔ وابستگی‌ها سالم نیست"
  check_prisma_client_parity
  check_artifact_freshness
  ok "استقرار کامل شد"
}

# --------------------------------------------- هم‌خوانیِ کلاینتِ Prisma با سکیما
# `install.sh` کلاینتِ Prisma را بازتولید **نمی‌کند**؛ همان چیزی را باز می‌کند
# که داخل `node_modules-linux.tar.gz` است. بررسیِ موجود (`require('@prisma/client')`)
# فقط می‌سنجد ماژول *بار می‌شود*، نه اینکه با اسکیما بخواند.
#
# اگر بسته با اسکیمای کهنه ساخته شده باشد، نصب بی‌هیچ خطایی تمام می‌شود، ربات هم
# بالا می‌آید، ولی مسیرهایی مثل پروژهٔ شهری، نکول و تملک وثیقه، پیریِ طبیعی و
# «زندگی تازه» در زمان اجرا «مدلِ ناشناخته / Unknown argument» می‌دهند —
# بی‌صدا و فقط وقتی بازیکن به آن مسیر برسد.
#
# کلاینتِ تولیدشده یک نسخهٔ واژه‌به‌واژه از سکیما را کنار خود نگه می‌دارد، پس
# هم‌خوانی با یک مقایسهٔ فایل قابل سنجش است؛ بدون دیتابیس، بدون اینترنت.
# فقط هشدار می‌دهد: نصب آفلاین باید در هر شرایطی کار کند.
check_prisma_client_parity() {
  local embedded="$REPO_ROOT/node_modules/.prisma/client/schema.prisma"
  local source="$REPO_ROOT/prisma/schema.prisma"

  if [ ! -f "$embedded" ]; then
    warn "کلاینتِ Prisma در بسته اسکیمای جاسازی‌شده ندارد؛ بستهٔ node_modules ناقص است."
    return 0
  fi
  [ -f "$source" ] || return 0

  if cmp -s "$embedded" "$source"; then
    ok "کلاینتِ Prisma با اسکیمای مخزن هم‌خوان است"
    return 0
  fi

  warn "کلاینتِ Prisma داخل بسته با prisma/schema.prisma هم‌خوان نیست."
  warn "ربات بالا می‌آید، ولی مسیرهایی مثل پروژهٔ شهری، نکولِ وام، پیریِ طبیعی و «زندگی تازه» خطای Prisma می‌دهند."
  warn "برای اصلاح: روی دستگاهی با npm دستور «bash offline-deps/packaging.sh» را اجرا و بسته‌ها را commit/push کنید."
}

# --------------------------------------------------- تازگی کدِ منتشرشده
# install.sh هرگز کامپایل نمی‌کند؛ همان `dist.tar.gz` را باز می‌کند. پس اگر
# بسته در کامیتی قدیمی‌تر از کد مخزن ساخته شده باشد، سرور بی‌صدا کدِ کهنه را
# اجرا می‌کند: هیچ خطایی در لاگ نمی‌آید، فقط رفتارِ قدیمی می‌ماند. این تابع
# فقط *هشدار* می‌دهد (نصب را نمی‌شکند) و مهرِ ساخت را می‌خواند: `packaging.sh`
# فایل `dist/BUILD_INFO.json` را همراه کامیتِ سازنده می‌گذارد.
check_artifact_freshness() {
  local stamp="$REPO_ROOT/dist/BUILD_INFO.json"
  if [ ! -f "$stamp" ]; then
    warn "بستهٔ dist مهر ساخت ندارد (بستهٔ قدیمی). اگر همین حالا git pull کرده‌اید، روی دستگاهی با npm دستور «bash offline-deps/packaging.sh» را بزنید."
    return 0
  fi
  local head built
  head="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
  built="$(sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$stamp" | head -1)"
  [ -n "$head" ] || return 0
  if [ "$built" = "$head" ]; then
    ok "بستهٔ dist هم‌خوان با همین کامیت ساخته شده است"
    return 0
  fi
  # مهرِ کامیت هرگز نمی‌تواند کامیتِ خودش باشد: `packaging.sh` بسته را می‌سازد و
  # سپس در کامیتی جدا کامیت می‌شود. پس اگر تنها تغییرِ کامیتِ مهر تا HEAD، خودِ
  # پوشهٔ بسته باشد، کدِ اجرایی همان کدِ HEAD است و بسته کهنه نیست.
  if git -C "$REPO_ROOT" cat-file -e "${built}^{commit}" 2>/dev/null; then
    local changed
    # فقط چیزهایی که واقعاً در `dist` می‌نشینند معیار کهنگی‌اند: `tests`،
    # `docs`، `scripts` و مستندات هیچ‌وقت روی سرور اجرا نمی‌شوند، و شمردن‌شان
    # فقط هشدارِ بی‌مورد می‌ساخت — هشداری که همیشه بیاید، به‌زودی نادیده گرفته
    # می‌شود. (`scripts` ابزارهای نگه‌داریِ مخزن‌اند؛ `dist` فقط خروجیِ
    # کامپایلِ `src` و `prisma/seed.ts` است.)
    changed="$(git -C "$REPO_ROOT" diff --name-only "$built" "$head" 2>/dev/null \
      | grep -v '^offline-deps/' \
      | grep -v '^tests/' \
      | grep -v '^docs/' \
      | grep -v '^scripts/' \
      | grep -v '\.md$' || true)"
    if [ -z "$changed" ]; then
      ok "بستهٔ dist با کد همین کامیت هم‌خوان است (تنها تغییرِ پس از ساخت، خودِ بسته بود)"
      return 0
    fi
  fi
  warn "کد مخزن (${head:0:7}) با بستهٔ اجرایی (${built:0:7}) یکی نیست؛ ربات همان کد بستهٔ dist را اجرا می‌کند."
  warn "برای انتشار این کد: روی دستگاهی با npm «bash offline-deps/packaging.sh» را اجرا و بسته‌ها را commit/push کنید."
}

run_migrations() {
  info "اعمال مهاجرت‌های دیتابیس ..."
  # آدرسِ هدفِ همین اجرا صریح داده می‌شود (نه حدس از محیط).
  if [ -n "${DB_TARGET_URL:-}" ]; then
    "$NODE_BIN" "$SCRIPT_DIR/scripts/migrate.js" "$REPO_ROOT" --url="$DB_TARGET_URL"
  else
    "$NODE_BIN" "$SCRIPT_DIR/scripts/migrate.js" "$REPO_ROOT"
  fi
}

run_seed() {
  # `seed.js` جدا از `tsc` کامپایل می‌شود، پس ممکن است در بستهٔ منتشرشده جا
  # مانده باشد. بدون این بررسی، نصب با یک خطای مبهمِ Node شکست می‌خورد؛
  # علتِ واقعی و راه‌حل باید در پیام باشد.
  [ -f "$REPO_ROOT/dist/seed.js" ] || die "dist/seed.js در بستهٔ dist نیست (بستهٔ ناقص). روی دستگاهی با npm «bash offline-deps/packaging.sh» را اجرا و بستهٔ dist.tar.gz را دوباره commit/push کنید."
  info "آماده‌سازی داده‌های اولیه (شغل‌ها و مهارت‌ها) — فقط وقتی لازم باشد اثر دارد ..."
  "$NODE_BIN" "$REPO_ROOT/dist/seed.js"
}

# ------------------------------------------------------------------ bot
bot_pid() {
  local pid_file="$TOOLS_DIR/bot.pid"
  [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null && cat "$pid_file" || true
}

stop_bot() {
  local pid
  pid="$(bot_pid || true)"
  if [ -n "${pid:-}" ]; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    ok "ربات متوقف شد (pid $pid)"
  else
    echo "ربات در حال اجرا نبود"
  fi
}

check_db() {
  # `node -e` وابستگی‌ها را نسبت به *پوشهٔ جاری* پیدا می‌کند (نه نسبت به اسکریپت)،
  # پس اجرای اسکریپت از پوشه‌ای دیگر با «ماژول pg پیدا نشد» به پیامِ گمراه‌کنندهٔ
  # «اتصال برقرار نشد» می‌رسید. پس مسیر صریح است.
  ( cd "$REPO_ROOT" && "$NODE_BIN" -e "
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
    c.connect().then(() => c.query('SELECT 1')).then(() => c.end()).catch(e => { console.error(e.message); process.exit(1); });
  " ) >/dev/null 2>&1 || die "اتصال به دیتابیس برقرار نشد.
        هدف: $(redact_url "${DATABASE_URL:-}") (از .env)
        اگر از دیتابیس داخلی استفاده می‌کنید:  bash offline-deps/install.sh start
        اگر خارجی: آدرس DATABASE_URL در .env را بررسی کنید"
}

# --------------------------------------------------------- سلامت راه‌اندازی
# «فرآیند زنده است» با «ربات واقعاً وصل شده» یکی نیست: Node ممکن است بالا
# بیاید و بعد در اتصال به تلگرام یا دیتابیس گیر کند، یا بلافاصله بمیرد.
# این تابع پس از بالا آمدن، خطِ تأییدِ خودِ برنامه را در لاگ می‌جوید
# (`Bot @username started`) و اگر در مهلت پیدا نشد، صریح شکست می‌خورد —
# چون بیلد/مهاجرت/ری‌استارتِ نیمه‌موفق باید «ناموفق» گزارش شود، نه «موفق».
#
# پارامتر: آفستِ بایتیِ لاگ پیش از شروع (تا لاگِ قدیمی اشتباه خوانده نشود).
verify_bot_health() {
  local from_offset="${1:-0}"
  local deadline=$((SECONDS + 30))
  local fresh=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ -f "$TOOLS_DIR/bot.log" ]; then
      fresh="$(tail -c "+$((from_offset + 1))" "$TOOLS_DIR/bot.log" 2>/dev/null || true)"
      if printf '%s' "$fresh" | grep -q 'Bot @.* started'; then
        ok "ربات به تلگرام وصل شد"
        return 0
      fi
      if printf '%s' "$fresh" | grep -q 'Fatal error during startup'; then
        die "ربات هنگام راه‌اندازی خطای مهلک داد — لاگ:
$(printf '%s' "$fresh" | tail -n 15 | sed 's/^/   | /')"
      fi
    fi
    sleep 2
  done
  warn "خطِ تأییدِ اتصال ربات در لاگ دیده نشد (فرآیند زنده است ولی وصل شدن تأیید نشد)."
  echo "   آخری‌ترین خطوط لاگ:"
  tail -n 10 "$TOOLS_DIR/bot.log" | sed 's/^/   | /'
  # کدِ غیرصفر یعنی «تأیید نشد» — فراخوان‌ها آن را در `if` می‌گیرند، پس با
  # `set -e` در تضاد نیست.
  return 1
}

start_bot() {
  local pid
  pid="$(bot_pid || true)"
  if [ -n "${pid:-}" ]; then
    die "ربات از قبل در حال اجراست (pid $pid). برای شروع دوباره: bash offline-deps/install.sh stop && bash offline-deps/install.sh start"
  fi
  [ -f "$ENV_FILE" ] || die "فایل .env پیدا نشد — ابتدا نصب کامل را اجرا کنید"
  [ -n "$(get_env BOT_TOKEN)" ] || die "BOT_TOKEN در .env خالی است — در .env مقدارش را بگذارید"
  resolve_db_target
  [ -n "$DATABASE_URL" ] || die "DATABASE_URL در .env خالی است"
  check_db
  mkdir -p "$TOOLS_DIR"
  # اندازهٔ لاگ پیش از شروع؛ تا خطِ تأییدِ اجرای *قبلی* به‌اشتباه خوانده نشود.
  local log_offset=0
  if [ -f "$TOOLS_DIR/bot.log" ]; then
    log_offset="$(wc -c < "$TOOLS_DIR/bot.log" | tr -d ' ')"
  fi
  info "شروع ربات ..."
  (
    cd "$REPO_ROOT"
    nohup "$NODE_BIN" dist/app.js >> "$TOOLS_DIR/bot.log" 2>&1 &
    echo $! > "$TOOLS_DIR/bot.pid"
  )
  sleep 3
  pid="$(cat "$TOOLS_DIR/bot.pid")"
  if kill -0 "$pid" 2>/dev/null; then
    ok "ربات راه افتاد (pid $pid)"
    # نتیجهٔ بررسیِ سلامت ثبت می‌شود تا مسیرِ استقرار بتواند صادقانه گزارش
    # بدهد: «پروسه بالا آمد» با «به تلگرام وصل شد» یکی نیست.
    if verify_bot_health "$log_offset"; then
      HEALTH_CONFIRMED=1
    else
      HEALTH_CONFIRMED=0
    fi
  else
    die "ربات هنگام راه‌اندازی خطا داد — لاگ:
$(tail -n 15 "$TOOLS_DIR/bot.log" | sed 's/^/   | /')"
  fi
}

status_all() {
  echo "--- وضعیت ربات ---"
  local pid; pid="$(bot_pid || true)"
  if [ -n "${pid:-}" ]; then
    ok "ربات در حال اجراست (pid $pid)"
  else
    echo "ربات در حال اجرا نیست"
  fi
  echo "--- وضعیت PostgreSQL ---"
  local pgport
  pgport="$(effective_pg_port)"
  if port_busy "$pgport"; then
    ok "پورت $pgport پاسخ می‌دهد"
  else
    echo "پورت $pgport باز نیست"
  fi
  if [ -f "$TOOLS_DIR/bot.log" ]; then
    echo "--- آخری‌ترین لاگ ربات ---"
    tail -n 8 "$TOOLS_DIR/bot.log" | sed 's/^/   | /'
  fi
}

# ------------------------------------------------------------------ main
CMD="${1:-install}"

case "$CMD" in
  stop)
    stop_bot
    stop_postgres
    exit 0
    ;;
  start)
    resolve_node
    [ -f "$ENV_FILE" ] || die "فایل .env پیدا نشد — ابتدا نصب کامل را اجرا کنید"
    resolve_db_target
    [ -n "$DB_TARGET_URL" ] || die "در .env آدرسِ دیتابیس ثبت نشده — ابتدا نصب کامل را اجرا کنید"
    case "$DB_TARGET_URL" in
      postgres://*127.0.0.1*|postgres://*localhost*|postgresql://*127.0.0.1*|postgresql://*localhost*)
        ensure_local_postgres
        ;;
    esac
    start_bot
    exit 0
    ;;
  status)
    status_all
    exit 0
    ;;
  restore)
    # بازگرداندنِ دادهٔ بازی از یک بکاپ. مسیرِ فرآیندی این‌جاست (خاموش/روشن)،
    # کارِ دیتابیس در `dist/modules/ops/restore-cli.js` انجام می‌شود تا منطقِ
    # بازیابی فقط یک نسخه داشته باشد و همان چیزی باشد که آزمون‌ها می‌سنجند.
    BACKUP_ID="${2:-}"
    [ -n "$BACKUP_ID" ] || die "شناسهٔ بکاپ لازم است: bash offline-deps/install.sh restore <id>"
    resolve_node
    [ -f "$ENV_FILE" ] || die "فایل .env پیدا نشد"
    if ! acquire_restore_lock; then
      warn "یک بازیابی همین حالا در جریان است؛ این درخواست انجام نشد."
      exit 1
    fi
    trap 'release_restore_lock' EXIT

    set_ops_state running "ربات خاموش می‌شود تا دادهٔ بازی از بکاپ بازسازی شود."
    warn "بازیابی از بکاپ $BACKUP_ID آغاز شد"
    # اول ربات خاموش می‌شود: بازیابی نباید با نویسندهٔ زندهٔ دیتابیس هم‌زمان شود.
    stop_bot || true

    # بازیابی، خطرناک‌ترین عملیاتِ دیتابیس است: هدف را صریح از .env می‌گیریم
    # تا یک متغیرِ جامانده در محیط، داده را روی دیتابیسِ اشتباهی بازنگرداند.
    resolve_db_target
    [ -n "$DB_TARGET_URL" ] || die "در .env آدرسِ دیتابیس ثبت نشده"
    RESTORE_RC=0
    ( cd "$REPO_ROOT" && "$NODE_BIN" dist/modules/ops/restore-cli.js "$BACKUP_ID" "$REPO_ROOT" ) || RESTORE_RC=$?
    if [ "$RESTORE_RC" -ne 0 ]; then
      # وضعیت را کلاینت نوشته (دقیق‌ترین منبع)؛ فقط اگر ننوشته باشد بازنویسی می‌کنیم.
      set_ops_state failed "بازیابی انجام نشد؛ دادهٔ فعلی دست‌نخورده ماند."
      warn "ربات دوباره روشن می‌شود با همان دادهٔ قبلی"
      ( start_bot ) || true
      exit 1
    fi

    # `start_bot` در نبودِ سلامت با `die` خارج می‌شود؛ در زیرپوسته اجرا می‌شود تا
    # خروج آن کل اسکریپت را نکشد و بتوانیم شکستِ سلامت را در وضعیت بنویسیم.
    if ( start_bot ); then
      ok "بازیابی کامل شد"
      exit 0
    fi
    set_ops_state failed "دادهٔ بازی از بکاپ بازگشت، ولی ربات بالا نیامد؛ لاگ سرور را ببین."
    exit 1
    ;;
  update)
    # استقرارِ نسخهٔ تازه از داخلِ خودِ سرور. همین مسیری است که فرمانِ
    # `/botupdate` هم پشت‌صحنه صدا می‌زند (هیچ منطقِ موازی‌ای وجود ندارد).
    #
    # تفاوت مهم با `install`: اینجا **وضعیت** نوشته می‌شود. رباتی که فرمان را
    # اجرا کرده، چند لحظه بعد خاموش می‌شود؛ پس تنها کسی که می‌تواند نتیجهٔ
    # واقعی را بنویسد همین فرآیند است.
    resolve_node

    # هر شکست — از جمله `die` که خودش `exit` می‌کند — از همین تله رد می‌شود.
    # بدون این، مرگِ وسطِ کار همان حالتِ «در حال اجرا» را روی دیسک می‌گذاشت و
    # مالک هیچ‌وقت نمی‌فهمید چه شد. قفل هم در هر مسیر آزاد می‌شود.
    finish_deploy() {
      local rc=$?
      if [ "$rc" -ne 0 ] && [ "${DEPLOY_DONE:-0}" != "1" ]; then
        set_deploy_state failed "${DEPLOY_FAIL_NOTE:-استقرار کامل نشد؛ وضعیت سرور را یک بار دیگر ببین.}"
      fi
      release_deploy_lock
    }
    trap finish_deploy EXIT

    [ -f "$ENV_FILE" ] || die "فایل .env پیدا نشد"
    set_deploy_state running "استقرارِ نسخهٔ تازه در جریان است."

    DEPLOY_FAIL_NOTE="استقرارِ بستهٔ تازه انجام نشد؛ نسخهٔ قبلی دست‌نخورده ماند."
    deploy_runtime

    # هدفِ دیتابیس پیش از هر گامِ مخرب روشن می‌شود: آپدیت روی دیتابیسِ درست
    # مهاجرت می‌زند، نه روی آن‌چه در محیطِ شل جامانده است.
    resolve_db_target
    [ -n "$DB_TARGET_URL" ] || die "در .env آدرسِ دیتابیس ثبت نشده — ابتدا نصب کامل را اجرا کنید"
    case "$DB_TARGET_URL" in
      postgres://*127.0.0.1*|postgres://*localhost*|postgresql://*127.0.0.1*|postgresql://*localhost*)
        ensure_local_postgres
        ;;
    esac

    DEPLOY_FAIL_NOTE="مهاجرتِ دیتابیس انجام نشد؛ ربات با نسخهٔ قبلی بالا می‌آید."
    run_migrations
    DEPLOY_FAIL_NOTE="داده‌های اولیه آماده نشد؛ ربات بالا نمی‌آید."
    run_seed

    stop_bot || true
    DEPLOY_FAIL_NOTE="کد و دیتابیس به‌روز شد، ولی ربات بالا نیامد؛ لاگ سرور را ببین."
    start_bot

    if [ "${HEALTH_CONFIRMED:-0}" = "1" ]; then
      set_deploy_state success "نسخهٔ تازه مستقر شد و ربات سالم به تلگرام وصل شد."
    else
      set_deploy_state success "نسخهٔ تازه مستقر شد و ربات بالا آمد، ولی تأییدِ اتصال در لاگ دیده نشد؛ یک بار دیگر وضعیت را ببین."
    fi
    DEPLOY_DONE=1
    exit 0
    ;;
  reset|clean)
    # ── پاکسازیِ کاملِ همین نصب — و فقط چیزهایی که خودِ ربات ساخته ─────────────
    # چرا یک زیرفرمان و نه دستورِ دستیِ README؟ دستورِ قدیمی `rm -rf VirtualLife`
    # بود؛ یعنی بازیکن باید کلِ مخزن را (که فقط بخشی از آن وضعیتِ ربات است) نابود
    # می‌کرد و بعد از صفر clone می‌گرفت. آن‌جا دو مرز مبهم بود: «چه چیزی "وضعیتِ
    # ربات" است؟» و «چه چیزی متعلق به سیستم است؟». اینجا هر دو صریح می‌شوند.
    #
    # دامنهٔ حذف:  .tools (دیتابیس داخلی، لاگ، PID، قفل، بکاپ، وضعیتِ استقرار) و
    #              dist (بستهٔ اجراییِ بازشده).
    # خارج از دامنه: مخزنِ کد، prisma/، offline-deps/*.tar.gz و هر PostgreSQL یا
    #              دیتابیسِ دیگری روی این ماشین. `--purge` هم node_modules و .env
    #              را برمی‌دارد (ریستِ کارخانه‌ای).
    #
    # نصبِ دوم باید دقیقاً مثل نصبِ اول کار کند؛ به همین دلیل در پایان صریحاً
    # سنجیده می‌شود که هر سه چیزی که install لازم دارد (اسکریپت، دو آرشیو، نمونهٔ
    # env) سر جایشان هستند.
    RESET_YES=0
    RESET_PURGE=0
    for _a in "$@"; do
      case "$_a" in
        --yes|-y) RESET_YES=1 ;;
        --purge)  RESET_PURGE=1 ;;
      esac
    done

    RESET_HAD_DB="-"
    if [ -d "$TOOLS_DIR/pgdata" ]; then
      RESET_HAD_DB="$(du -sh "$TOOLS_DIR/pgdata" 2>/dev/null | cut -f1 || echo '?')"
    fi

    if [ "$RESET_YES" -eq 0 ]; then
      if [ -t 0 ]; then
        echo "⚠ پاکسازیِ کامل: دیتابیسِ داخلیِ بازی ($RESET_HAD_DB)، لاگ‌ها، بکاپ‌ها، PID و قفل‌ها"
        echo "   پاک می‌شوند. مخزنِ کد و بسته‌های آفلاین می‌مانند؛ دادهٔ بازی برنمی‌گردد."
        read -r -p "   برای ادامه دقیقاً بنویس «پاک کن»: " RESET_CONFIRM
        [ "$RESET_CONFIRM" = "پاک کن" ] || die "لغو شد — هیچ چیزی پاک نشد."
      else
        die "برای اجرای غیرتعاملی، تاییدِ صریح لازم است:\n        bash offline-deps/install.sh reset --yes"
      fi
    fi

    # کاربرِ سرویسِ دیتابیس پیش از حذفِ .tools خوانده می‌شود (تنها جای ثبتش همان‌جاست).
    RESET_SERVICE_USER=""
    if [ -f "$TOOLS_DIR/.pguser" ]; then
      RESET_SERVICE_USER="$(tr -d '[:space:]' < "$TOOLS_DIR/.pguser" 2>/dev/null || true)"
    fi

    # عمداً `resolve_node` صدا زده نمی‌شود: پاکسازی باید حتی روی ماشینی که
    # Node ندارد هم کار کند (وگرنه Nodeِ نبوده، پاکسازی را می‌کشت). هر دو
    # تابعِ پایین بدون Node کار می‌کنند.
    info "توقف ربات و دیتابیس ..."
    stop_bot || true
    stop_postgres || true

    info "حذف وضعیتِ زمانِ اجرا (.tools) ..."
    rm -rf "$TOOLS_DIR"
    info "حذف بستهٔ اجراییِ بازشده (dist) ..."
    rm -rf "$REPO_ROOT/dist"
    if [ "$RESET_PURGE" -eq 1 ]; then
      info "--purge: حذف node_modules و .env ..."
      rm -rf "$REPO_ROOT/node_modules" "$ENV_FILE"
    fi

    ok "پاکسازی کامل شد (دیتابیسِ داخلی: $RESET_HAD_DB پاک شد)"
    if [ "$RESET_PURGE" -eq 1 ]; then
      echo "   نگه‌داشته شد: مخزنِ کد، prisma/، offline-deps/ (همراه دو آرشیو)"
    else
      echo "   نگه‌داشته شد: مخزنِ کد، prisma/، offline-deps/، node_modules/، .env"
    fi

    # حذفِ کاربرِ سرویس فقط اگر همین نصب ساخته باشد و فقط با دسترسی root؛
    # هیچ‌وقت sudo خودکار اجرا نمی‌شود (این اسکریپت رمز نمی‌پرسد).
    if [ -n "$RESET_SERVICE_USER" ] && [ "$RESET_SERVICE_USER" != "$(id -un)" ]; then
      if [ "$(id -u)" -eq 0 ] && id -u "$RESET_SERVICE_USER" >/dev/null 2>&1; then
        userdel "$RESET_SERVICE_USER" 2>/dev/null \
          && ok "کاربرِ سرویسِ دیتابیس «$RESET_SERVICE_USER» هم حذف شد" \
          || warn "کاربرِ سرویس «$RESET_SERVICE_USER» حذف نشد (ممکن است جای دیگری هم استفاده شود)"
      else
        echo "   کاربرِ سرویسِ دیتابیس «$RESET_SERVICE_USER» ساختِ همین نصب بود؛ اگر می‌خواهی حذفش کنی:"
        echo "     sudo userdel $RESET_SERVICE_USER"
      fi
    fi

    # دروازهٔ نصبِ دوباره: بدون این‌ها، نصبِ بعدی با پیامِ مبهم می‌افتد.
    RESET_BLOCKERS=""
    [ -f "$SCRIPT_DIR/install.sh" ] || RESET_BLOCKERS="$RESET_BLOCKERS\n        - خودِ offline-deps/install.sh پیدا نشد"
    [ -f "$SCRIPT_DIR/dist.tar.gz" ] || RESET_BLOCKERS="$RESET_BLOCKERS\n        - offline-deps/dist.tar.gz پیدا نشد"
    [ -f "$SCRIPT_DIR/node_modules-linux.tar.gz" ] || RESET_BLOCKERS="$RESET_BLOCKERS\n        - offline-deps/node_modules-linux.tar.gz پیدا نشد"
    [ -f "$REPO_ROOT/.env.example" ] || RESET_BLOCKERS="$RESET_BLOCKERS\n        - .env.example پیدا نشد"
    if [ -n "$RESET_BLOCKERS" ]; then
      die "پاکسازی انجام شد، ولی نصبِ دوباره الان ممکن نیست:""$RESET_BLOCKERS""\n        این موارد را با git برنگردان:  git checkout -- ."
    fi

    echo
    echo "   نصب دوباره:  bash offline-deps/install.sh"
    exit 0
    ;;
  install)
    ;;
  *)
    echo "دستور نامعتبر: $CMD"
    echo "دستورها: install (پیش‌فرض) | start | stop | status | update | restore <id> | reset [--yes] [--purge]"
    exit 1
    ;;
esac

echo "╔══════════════════════════════════════════════════╗"
echo "║   🎮 نصب آفلاین — میراث (Legacy Game)           ║"
echo "╚══════════════════════════════════════════════════╝"
echo "   معماری: $ARCH_KEY | نسخهٔ Node هدف: $NODE_VERSION"

resolve_node

info "بررسی/ساخت فایل .env ..."
if [ ! -f "$ENV_FILE" ]; then
  cp "$REPO_ROOT/.env.example" "$ENV_FILE"
  # DATABASE_URL نمونه یک مقدار فرضی است؛ خالی شود تا دیتابیس داخلی ساخته شود
  # (اگر دیتابیس خارجی دارید، قبل از اجرای اسکریپت مقدار واقعی را در .env بگذارید)
  set_env DATABASE_URL ""
  ok "فایل .env از نمونه ساخته شد"
fi
set_env NODE_ENV production

if [ -z "$(get_env BOT_TOKEN)" ]; then
  echo
  read -r -p "   توکن ربات را از @BotFather بگیرید و اینجا بجوید: " BOT_TOKEN_INPUT
  [ -n "$BOT_TOKEN_INPUT" ] || die "توکن خالی بود — نصب متوقف شد"
  set_env BOT_TOKEN "$BOT_TOKEN_INPUT"
  ok "BOT_TOKEN ثبت شد"
else
  ok "BOT_TOKEN از قبل تنظیم بود"
fi

deploy_runtime

# هدفِ نصب یک‌بار و پیش از هر گام روشن می‌شود: `.env` (یا `--url`) تعیین
# می‌کند و متغیرِ محیطیِ شل هدف را عوض نمی‌کند. اگر `.env` خالی باشد، همان
# دیتابیسِ داخلی ساخته می‌شود.
resolve_db_target
if [ -n "$DB_TARGET_URL" ]; then
  if [ -n "$DB_URL_ARG" ]; then
    ok "دیتابیس از --url گرفته شد — دیتابیس داخلی ساخته نمی‌شود"
  else
    ok "DATABASE_URL از قبل در .env تنظیم بود (دیتابیس خارجی یا قبلی) — همان استفاده می‌شود"
  fi
else
  ensure_local_postgres
fi

run_migrations
run_seed
stop_bot || true
start_bot

echo
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║  ✅ همه‌چیز آماده است! ربات روی سرور شما اجرا می‌شود      ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo
echo "   دستورات روزمره (همه از داخل پوشهٔ پروژه):"
echo "     bash offline-deps/install.sh status   ← وضعیت"
echo "     bash offline-deps/install.sh stop     ← خاموش کردن"
echo "     bash offline-deps/install.sh start    ← روشن کردن"
echo "     tail -f .tools/bot.log                ← مشاهدهٔ زندهٔ لاگ"
echo
echo "   💡 با تلگرام به ربات پیام /start بدهید تا مطمئن شوید آنلاین است."
echo "   🔒 هشدار: توکن‌های .env و توکن گیت‌هاب را با کسی به اشتراک نگذارید."
