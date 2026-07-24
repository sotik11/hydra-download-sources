# hydra-download-sources

Генераторы, собирающие JSON-фиды в формате **download-source** для
[Hydra Launcher](https://github.com/hydralauncher/hydra). Каждый источник —
модуль в `generators/`, вывод — `data/<src>.json`, который раздаётся как сырой
файл (`raw.githubusercontent.com/.../data/<src>.json`) и добавляется в Hydra
через **Настройки → Источники загрузок**.

Родственный репозиторий с фан-локализациями —
[hydra-localization-sources](https://github.com/sotik11/hydra-localization-sources);
здесь та же инфраструктура (`lib/net.mjs`), но другой формат фида и другой
раздел Hydra.

## Формат фида (что ждёт Hydra)

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

Ровно два поля верхнего уровня (`name`, `downloads`) и ровно четыре поля в
записи (`title`, `uris`, `uploadDate`, `fileSize`) — всё обязательное. Hydra
сама сопоставляет игру со своим каталогом по `title`, Steam appid не нужен.

**Важно про `uris`.** Hydra включает загрузчик Torrent **только для ссылок,
начинающихся с `magnet:`** (см. `getDownloadersForUri` в `src/shared/index.ts`
лаунчера). Прямой `.torrent`-URL даёт пустой список загрузчиков. Поэтому
генераторы обязаны отдавать `magnet:`-ссылки; если сайт публикует только
`.torrent`-файл, magnet собирается на лету (`lib/torrent.mjs`: bencode-парсинг
→ SHA-1 от словаря `info` = infohash → `magnet:?xt=urn:btih:…&tr=…`).

## Запуск

```bash
node generators/itorrents-igruha.mjs        # полный прогон
LIMIT=40 node generators/itorrents-igruha.mjs   # срез в 40 игр (тест)
POOL=6  node generators/itorrents-igruha.mjs    # число параллельных воркеров
```

## Источники

| источник | файл | сайт | заметки |
|---|---|---|---|
| Torrent Igruha | `itorrents-igruha.mjs` | itorrents-igruha.org | windows-1251; magnet собираем из `.torrent`; ~23k игр, 2 запроса на игру |

### Torrent Igruha — как устроено

1. `sitemap.xml` → ~23 000 страниц игр (`/{id}-slug.html`).
2. Страница игры → `title` (`<h1>`), `fileSize` («Размер:»), `uploadDate`
   (`<time datetime>`), и **download id** из `?do=download&id=N`.
3. `engine/download.php?id=N` → `.torrent` → magnet.

Игры без раздачи («Нет раздачи») не имеют download id и пропускаются — без
magnet запись всё равно неработоспособна (проверено: срез на 800 игр по всему
sitemap дал 0 транзиентных фейлов, все скипы — genuine).

## Инкремент и автоматика

Полный прогон — ~46k запросов (2 на игру, ~1.5 ч на вежливых 8-12 req/s).
Чтобы не гонять это каждый день, генератор **инкрементальный**:

- держит `data/itorrents-igruha.state.json` — карту `url → { lastmod, entry }`
  (gitignored);
- на каждом прогоне переиспользует записи, у которых `<lastmod>` в sitemap не
  изменился, и **фетчит только новые/изменённые** страницы; снятые с сайта
  игры выпадают сами;
- страницы «Нет раздачи» тоже кэшируются (как `null`), чтобы не долбить их
  каждый раз.

**Запуск только локальный.** `itorrents-igruha.org` отдаёт **403 на IP
дата-центров** (проверено 2026-07-25: с раннера GitHub Actions — 403, с
домашнего IP — полные данные). Поэтому облачный крон невозможен; скрейп гоняется
на резидентном IP через `refresh_local.sh`, который цепляется к общей
Windows-задаче «Hydra localization refresh» (обёртка `C:\temp\claude\refresh_all.sh`:
сначала локализации, потом этот источник). Скрипт делает pull → генератор
(инкремент) → commit/push в `main` → Windows-toast. State (`*.state.json`)
лежит локально между прогонами.

```bash
bash refresh_local.sh                          # то, что гонит Scheduled Task
FULL=1 node generators/itorrents-igruha.mjs    # игнорировать state, полный ребилд
```

(`.github/workflows/notify-test.yml` — dispatch-only, проверка Telegram-секретов;
скрейп в CI не запускается, он бы упёрся в 403.)

## Лицензия / оговорка

Инструмент только агрегирует публично доступные ссылки, ничего не хостит.
