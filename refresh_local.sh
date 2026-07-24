#!/usr/bin/env bash
# Local (residential-IP) refresh of the itorrents-igruha download source.
#
# itorrents-igruha.org 403s datacenter IPs (confirmed 2026-07-25 from a GitHub
# Actions runner; full counts from a home IP), so the scrape MUST run locally.
# Chained after the localization refresh by refresh_all.sh, which the "Hydra
# localization refresh" Scheduled Task invokes.
#
# Incremental: the generator keeps data/itorrents-igruha.state.json on disk and
# only (re)fetches pages whose sitemap <lastmod> changed. First run (no state)
# is a full ~1.5h rebuild; later runs touch a few hundred pages.
#
# Output is teed to refresh_local.log (gitignored). Start/finish are announced
# as Windows toasts via notify.ps1 (best-effort — never fail the refresh).
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

count() { # entries in a feed file, 0 if missing/broken
  node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).downloads.length)}catch{console.log(0)}' "$1" 2>/dev/null
}

FEED="data/itorrents-igruha.json"

echo ""
echo "######## igruha refresh $(date '+%Y-%m-%d %H:%M:%S %z') ########"
notify "Игруха refresh — старт" "Обновляю источник itorrents-igruha…"

# 1. Sync first so the push at the end fast-forwards.
echo "=== 1. git pull --rebase ==="
if ! git pull --rebase --autostash origin main; then
  git rebase --abort 2>/dev/null
  echo "  !! git pull --rebase failed — aborting"
  notify "Игруха refresh — ОШИБКА" "git pull не прошёл, повтор в следующий запуск"
  exit 1
fi

before=$(count "$FEED")

# 2. Regenerate (incremental via the on-disk state file).
echo "=== 2. generate ==="
RATE=10 POOL=4 node generators/itorrents-igruha.mjs
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "  !! generator exited $rc"
  notify "Игруха refresh — ОШИБКА" "генератор упал (код $rc)"
  exit 1
fi
after=$(count "$FEED")

# Guard: a blocked/throttled run must not gut a good feed.
if [ "$before" -gt 0 ] && [ "$after" -lt $((before / 2)) ]; then
  echo "  !! feed collapsed ($after < 50% of $before) — not committing"
  git checkout -- "$FEED" 2>/dev/null
  notify "Игруха refresh — ОШИБКА" "фид схлопнулся ($after < 50% от $before), откат"
  exit 1
fi

# 3. Commit & push only the feed (state is gitignored).
echo "=== 3. commit & push ==="
git add "$FEED"
if git diff --staged --quiet; then
  echo "  no change ($after games)"
  notify "Игруха refresh — готово" "без изменений · $after игр"
else
  delta=$((after - before))
  sign=$([ "$delta" -ge 0 ] && echo "+")
  if git commit -m "data: local refresh itorrents-igruha [skip ci]" && git push origin main; then
    echo "  pushed ($after games, ${sign}${delta})"
    notify "Игруха refresh — готово" "$after игр (${sign}${delta}) · запушено"
  else
    echo "  !! commit/push failed"
    notify "Игруха refresh — ОШИБКА" "push не прошёл"
    exit 1
  fi
fi

echo "######## DONE $(date '+%Y-%m-%d %H:%M:%S') ########"
