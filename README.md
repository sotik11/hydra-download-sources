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
  "name": "Торрент Игруха",
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
node generators/torrent-igruha.mjs        # полный прогон
LIMIT=40 node generators/torrent-igruha.mjs   # срез в 40 игр (тест)
POOL=6  node generators/torrent-igruha.mjs    # число параллельных воркеров
```

## Источники

| источник | файл | сайт | заметки |
|---|---|---|---|
| Торрент Игруха | `torrent-igruha.mjs` | itorrents-igruha.org | windows-1251; magnet собираем из `.torrent`; ~23k игр, 2 запроса на игру |

### Торрент Игруха — как устроено

1. `sitemap.xml` → ~23 000 страниц игр (`/{id}-slug.html`).
2. Страница игры → `title` (`<h1>`), `fileSize` («Размер:»), `uploadDate`
   (`<time datetime>`), и **download id** из `?do=download&id=N`.
3. `engine/download.php?id=N` → `.torrent` → magnet.

Игры без раздачи («Нет раздачи») не имеют download id и пропускаются — без
magnet запись всё равно неработоспособна. Полный прогон — это ~46k запросов
(2 на игру), поэтому его лучше гонять в фоне; инкрементальные обновления можно
делать по `<lastmod>` из sitemap.

## Лицензия / оговорка

Инструмент только агрегирует публично доступные ссылки, ничего не хостит.
