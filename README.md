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
node scripts/checker.mjs           # полная проверка + Telegram
node scripts/checker.mjs --dry-run  # тест без отправки в Telegram
```

## GitHub Actions

Автоматическая проверка каждые 5 минут через `.github/workflows/check.yml`.

## Структура

```
├── index.html           # Публичный дашборд
├── scripts/checker.mjs  # Чекер (zero dependencies, Node 20+)
├── data/
│   ├── config.json      # Конфигурация (эндпоинты, Telegram, DC-маппинг)
│   ├── status.json      # Текущий статус (генерируется чекером)
│   ├── history.json     # История проверок
│   └── cp-content.json  # Парсинг cp.vdsina.com
└── .github/workflows/
    └── check.yml        # GitHub Action
```
