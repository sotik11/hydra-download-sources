# hydra-download-sources

Генератори, що збирають JSON-фіди у форматі **download-source** для
[Hydra Launcher](https://github.com/hydralauncher/hydra). Кожне джерело —
модуль у `generators/`, вивід — `data/<src>.json`, який роздається як сирий
файл (`raw.githubusercontent.com/.../data/<src>.json`) і додається в Hydra
через **Налаштування → Джерела завантажень**.

Споріднений репозиторій із фан-локалізаціями —
[hydra-localization-sources](https://github.com/sotik11/hydra-localization-sources);
тут та сама інфраструктура (`lib/net.mjs`), але інший формат фіда й інший
розділ Hydra.

## Формат фіда (що очікує Hydra)

```json
{
  "name": "Torrent Igruha",
  "downloads": [
    {
      "title": "Solateria",
      "uris": ["magnet:?xt=urn:btih:0f563dc4…&tr=…"],
      "uploadDate": "2026-07-13T09:01:55.000Z",
      "fileSize": "1.50 GB"
    }
  ]
}
```

<details>
<summary>Деталі формату та важливе про <code>uris</code></summary>

Рівно два поля верхнього рівня (`name`, `downloads`) і рівно чотири поля в
записі (`title`, `uris`, `uploadDate`, `fileSize`) — усе обов'язкове. Hydra
сама зіставляє гру зі своїм каталогом за `title`, Steam appid не потрібен.

**Важливо про `uris`.** Hydra вмикає завантажувач Torrent **лише для посилань,
що починаються з `magnet:`** (див. `getDownloadersForUri` у `src/shared/index.ts`
лаунчера). Прямий `.torrent`-URL дає порожній список завантажувачів. Тому
генератори зобов'язані віддавати `magnet:`-посилання; якщо сайт публікує лише
`.torrent`-файл, magnet збирається на льоту (`lib/torrent.mjs`: bencode-парсинг
→ SHA-1 від словника `info` = infohash → `magnet:?xt=urn:btih:…&tr=…`).

</details>

## Запуск

```bash
node generators/itorrents-igruha.mjs            # повний прогін
LIMIT=40 node generators/itorrents-igruha.mjs   # зріз у 40 ігор (тест)
POOL=6  node generators/itorrents-igruha.mjs    # кількість паралельних воркерів
```

## Джерела

| джерело | файл | сайт | нотатки |
|---|---|---|---|
| Torrent Igruha | `itorrents-igruha.mjs` | itorrents-igruha.org | windows-1251; magnet із `.torrent`; ~23k ігор |
| Repack Igruha | `repack-igruha.mjs` | repack-igruha.net | UTF-8; sitemap-індекс → `news_pages.xml`; торент `index.php?do=download` **з `Referer`**; ~13k ігор |

<details>
<summary>Як влаштовані джерела</summary>

Обидва сайти — один оператор (byigruha), обидва **403 на IP дата-центрів** →
скрейп лише локально (див. нижче).

**Torrent Igruha:**

1. `sitemap.xml` → ~23 000 сторінок ігор (`/{id}-slug.html`).
2. Сторінка гри → `title` (`<h1>`), `fileSize` («Размер:»), `uploadDate`
   (`<time datetime>`), і **download id** з `?do=download&id=N`.
3. `engine/download.php?id=N` → `.torrent` → magnet.

**Repack Igruha:** те саме, але UTF-8, двоступеневий sitemap
(індекс → `news_pages.xml`) і торент-посилання `index.php?do=download&id=N`
віддає `.torrent` **напряму, але потребує `Referer`** сторінки гри.

Ігри без роздачі («Нет раздачи») не мають download id і пропускаються — без
magnet запис усе одно непрацездатний (перевірено: зріз на 800 ігор по всьому
sitemap дав 0 транзієнтних фейлів, усі скіпи — genuine).

</details>

## Інкремент та автоматика

Повний прогін — ~46k запитів (2 на гру, ~1.5 год на ввічливих 8-12 req/s). Щоб
не ганяти це щодня, генератор **інкрементальний**:

<details>
<summary>Інкремент, локальний запуск, failsafe</summary>

- тримає `data/<src>.state.json` — карту `url → { lastmod, entry }` (gitignored);
- на кожному прогоні перевикористовує записи, у яких `<lastmod>` у sitemap не
  змінився, і **фетчить лише нові/змінені** сторінки; зняті з сайту ігри
  випадають самі;
- сторінки «Нет раздачи» теж кешуються (як `null`), щоб не довбати їх щоразу.

**Запуск лише локальний.** Обидва сайти віддають **403 на IP дата-центрів**, тому
хмарний крон для скрейпу неможливий — `refresh_local.sh` ганяє **обидва джерела**
на резидентному IP (Windows Scheduled Task). Скрипт: pull → кожен генератор
(інкремент, з guard «<50% → відкат») → один commit/push у `main`.

```bash
bash refresh_local.sh                          # те, що ганяє Scheduled Task (обидва)
FULL=1 node generators/repack-igruha.mjs       # ігнорувати state, повний ребілд
```

**Failsafe (`main` = live, `snapshot` = бекап).** `main` — те, що читають
клієнти. `.github/workflows/failsafe-snapshot.yml` раз на 2 тижні копіює
`main → snapshot`, **лише якщо пройшов** `sanity-check.mjs` (валідний JSON,
`downloads` непорожній, ≥95% `uris` — magnet, count ≥90% і розмір ≥50% від
snapshot). Ця джоба **не скрейпить сайти** (лише порівнює закомічений JSON), тому
403 у CI їй не заважає. Break-glass бекап-URL: `.../snapshot/data/<src>.json`.

(`.github/workflows/notify-test.yml` — dispatch-only, перевірка Telegram-секретів;
скрейп у CI не запускається — 403.)

</details>

## Ліцензія / застереження

Інструмент лише агрегує публічно доступні посилання, нічого не хостить.
