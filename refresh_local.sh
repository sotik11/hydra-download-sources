#!/usr/bin/env bash
# Local (residential-IP) refresh of the game download sources.
#
# Both sites (itorrents-igruha.org, repack-igruha.net — same operator) 403
# datacenter IPs, so the scrape MUST run locally. Chained after the localization
# refresh by refresh_all.sh, which the "Hydra localization refresh" Scheduled
# Task invokes.
#
# Each generator is incremental (keeps data/<src>.state.json on disk): first run
# is a full rebuild, later runs touch a few hundred pages. Per source there is a
# <50%-collapse guard so a blocked/throttled run never guts a good feed. Both
# feeds go in one commit / one push.
#
# Output teed to refresh_local.log (gitignored). Start/finish as Windows toasts
# via notify.ps1 (best-effort — never fail the refresh).
set -u
cd "$(dirname "$0")"

DIR="$(pwd)"
LOG="refresh_local.log"
exec > >(tee -a "$LOG") 2>&1

PS_NOTIFY="$(cygpath -w "$DIR/notify.ps1" 2>/dev/null || echo "")"
notify() { # $1=title $2=message — best-effort, must never abort the run
  [ -n "$PS_NOTIFY" ] && powershell.exe -NoProfile -ExecutionPolicy Bypass \
    -File "$PS_NOTIFY" -Title "$1" -Message "$2" >/dev/null 2>&1
  return 0
}

# Telegram — final result only (like the cloud regenerate.yml), best-effort,
# never aborts the run. Creds live in a shared, gitignored file outside any repo;
# if they are empty/absent, tg() is a silent no-op.
[ -f "/c/temp/claude/.telegram.env" ] && . "/c/temp/claude/.telegram.env"
NL=$'\n'
tg() { # $1 = HTML text — piped via stdin (text@-) on purpose: MSYS mangles
       # non-ASCII bytes in a command-line arg, so inline --data-urlencode
       # "text=…" reaches Telegram as invalid UTF-8; stdin preserves raw bytes.
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] || return 0
  printf '%s' "$1" | curl -s -m 15 -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "parse_mode=HTML" \
    --data-urlencode "disable_web_page_preview=true" \
    --data-urlencode "text@-" >/dev/null 2>&1
  return 0
}

count() { # entries in a feed file, 0 if missing/broken
  node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).downloads.length)}catch{console.log(0)}' "$1" 2>/dev/null
}

# source name == generator file == feed file (data/<name>.json)
SOURCES="itorrents-igruha repack-igruha"

echo ""
echo "######## download-sources refresh $(date '+%Y-%m-%d %H:%M:%S %z') ########"
notify "Игрухи refresh — старт" "Обновляю: $SOURCES"

# 1. Sync first so the push at the end fast-forwards.
echo "=== 1. git pull --rebase ==="
if ! git pull --rebase --autostash origin main; then
  git rebase --abort 2>/dev/null
  echo "  !! git pull --rebase failed — aborting"
  notify "Игрухи refresh — ОШИБКА" "git pull не прошёл, повтор в следующий запуск"
  tg $'⚠️ <b>Игрухи (локально)</b>\ngit pull не прошёл — повтор в следующий запуск.'
  exit 1
fi

# 2. Regenerate each source (incremental), guarding against a collapse.
TOAST=""; TG=""; SEP=""   # TG: one source per line, "<u>name</u> — +N (was → now)"
for src in $SOURCES; do
  feed="data/$src.json"
  before=$(count "$feed")
  echo "=== 2. generate: $src (was $before) ==="
  RATE=10 POOL=4 node "generators/$src.mjs"
  rc=$?
  after=$(count "$feed")

  if [ "$rc" -ne 0 ]; then
    echo "  !! $src exited $rc — reverting its feed"
    git checkout -- "$feed" 2>/dev/null
    TOAST="$TOAST${SEP}$src: ошибка ($rc)"; SEP=" · "
    TG="${TG:+$TG$NL}<u>$src</u> — ошибка ($rc)"
    continue
  fi
  if [ "$before" -gt 0 ] && [ "$after" -lt $((before / 2)) ]; then
    echo "  !! $src collapsed ($after < 50% of $before) — reverting"
    git checkout -- "$feed" 2>/dev/null
    TOAST="$TOAST${SEP}$src: обвал ($after<50%), откат"; SEP=" · "
    TG="${TG:+$TG$NL}<u>$src</u> — обвал ($after), откат"
    continue
  fi

  delta=$((after - before))
  sign=$([ "$delta" -ge 0 ] && echo "+")
  git add "$feed"
  TOAST="$TOAST${SEP}$src: $after (${sign}${delta})"; SEP=" · "
  TG="${TG:+$TG$NL}<u>$src</u> — ${sign}${delta} ($before → $after)"
done

# 3. One commit for whatever changed, one push.
echo "=== 3. commit & push ==="
if git diff --staged --quiet; then
  echo "  no changes"
  notify "Игрухи refresh — готово" "без изменений · $TOAST"
  tg "$(printf '✅ <b>Игрухи (локально)</b> — без изменений\n\n%s' "$TG")"
else
  if git commit -m "data: local refresh game sources [skip ci]" && git push origin main; then
    echo "  pushed"
    notify "Игрухи refresh — готово" "$TOAST · запушено"
    tg "$(printf '✅ <b>Игрухи (локально)</b> — запушено\n\n%s' "$TG")"
  else
    echo "  !! commit/push failed"
    notify "Игрухи refresh — ОШИБКА" "push не прошёл"
    tg "$(printf '⚠️ <b>Игрухи (локально)</b> — push не прошёл\n\n%s' "$TG")"
    exit 1
  fi
fi

echo "######## DONE $(date '+%Y-%m-%d %H:%M:%S') ########"
