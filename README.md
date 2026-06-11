# VDSina Status Monitor

Публичный мониторинг доступности сервисов VDSina.com во время инцидента с DC2/DC3.

## Возможности

- **19 эндпоинтов** — HTTP-проверка API, панели, биллинга, поддержки
- **DNS-мониторинг** — отслеживание появления/исчезновения A-записей
- **BGP (AS216071)** — количество анонсируемых префиксов через RIPE Stat API
- **cp.vdsina.com парсер** — детект изменений текста на заглушке
- **DC Health** — TCP-пинги sample IP по датацентрам (DC2/DC3/mixed)
- **IP → DC Lookup** — определение датацентра по IP-адресу сервера
- **Telegram-уведомления** — алерты в @VdsinaINFO при изменениях
- **Таймер простоя** — счётчик с начала инцидента (2 июня 2026)

## Запуск

```bash
cp .env.example .env   # добавить TELEGRAM_BOT_TOKEN (не коммитить!)
node scripts/checker.mjs           # полная проверка + Telegram
node scripts/checker.mjs --dry-run  # тест без отправки в Telegram
node scripts/bot.mjs                # интерактивный бот (long-polling)
```

**Секреты:** токен бота только в `.env` (локально) или GitHub Secret `TELEGRAM_BOT_TOKEN`. В `data/config.json` его нет.

## GitHub Actions

Автоматическая проверка каждые 5 минут через `.github/workflows/check.yml`.
В Settings → Secrets → Actions добавьте `TELEGRAM_BOT_TOKEN`.

## Структура

```
├── index.html           # Публичный дашборд
├── scripts/checker.mjs  # Чекер (zero dependencies, Node 20+)
├── data/
│   ├── config.json      # Конфигурация (эндпоинты, chatId, DC-маппинг)
│   ├── .env             # TELEGRAM_BOT_TOKEN (локально, в .gitignore)
│   ├── status.json      # Текущий статус (генерируется чекером)
│   ├── history.json     # История проверок
│   └── cp-content.json  # Парсинг cp.vdsina.com
└── .github/workflows/
    └── check.yml        # GitHub Action
```
