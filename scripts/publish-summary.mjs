#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig, requireBotToken } from './load-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CONFIG = loadConfig(ROOT);
const status = JSON.parse(fs.readFileSync(path.join(DATA, 'status.json'), 'utf8'));
const s = status.summary;
const checked = new Date(status.checkedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
const incMs = Date.now() - new Date(status.incidentStart).getTime();
const days = Math.floor(incMs / 864e5);
const hrs = Math.floor(incMs % 864e5 / 36e5);

const text = `<b>📊 Сводка по инциденту VDSina</b>
<i>11.06.2026 · данные на ${checked} МСК</i>

<b>🔗 Мониторинг</b>
<a href="https://vdsina-status.github.io">vdsina-status.github.io</a> · бот @VdsinaINFO
Обновление каждые 5 мин · инцидент <b>${days}д ${hrs}ч</b>

<b>🏢 VDSina — официально</b>
🟡 <b>cp.vdsina.com</b> — без изменений с 10.06
«DC3 серверы запущены», HDD/бэкапы ограничены, панель .com в работе
🔴 <b>api.vdsina.com</b> — 403 Blocked (WAF, раньше 504)
🔴 <b>userapi.vdsina.com</b> — 504, в ЛК войти нельзя

<b>📡 Мониторинг сейчас</b>
🌐 Эндпоинты: <b>${s.endpointsUp}/${s.endpointsTotal}</b> UP
📡 DNS: <b>${s.dnsResolved}/${s.dnsTotal}</b>
🗺 Диапазоны SSH: <b>${s.rangesAlive}/${s.rangesTotal}</b>
⚠️ DC3 нестабилен — часть диапазонов то оживает, то падает

<b>🔀 Параллельно: МакХost</b>
<i>Тот же апстрим MIRhosting — косвенный сигнал для всей цепочки</i>

📅 <b>09.06</b> — NL DC: предварительно <b>возможна разблокировка</b> оборудования
📅 <b>11.06</b> — «восстановлены <b>почти все VDS</b> из бэкапов в <b>новом ДЦ</b>»
⚖️ Старый ДЦ — юристы · «есть надежда?» → <b>«Есть»</b>
🖥 cp.mchost.ru — «заработает скоро»
📦 Shared — после включения <b>старого</b> ДЦ
💰 Компенсация за простой — <b>обязательно</b>

<b>💡 Что это значит</b>
✅ DC3 частично жив — SSH/RDP у части серверов
❌ Панель и API .com — лежат
❌ DC2 — мёртв (оборудование изъято/обесточено)
ℹ️ Прямого апдейта VDSina после 10.06 — <b>нет</b>

<b>😤 Боли из чатов (09–11.06)</b>
• DNS без доступа к панели
• Бэкапы на том же сервере — потеряны
• Поддержка: «смотрите cp.vdsina.com»

<b>🛠 Полезное</b>
Проверить DC/IP → <a href="https://vdsina-status.github.io">панель</a>
Команды: <code>/status</code> · <code>/check IP</code> · <code>/ip IP</code>

<i>Неофициальный мониторинг сообщества · не VDSina support</i>`;

const { chatId } = CONFIG.telegram;
const botToken = requireBotToken(CONFIG);
console.log('Sending to', chatId, 'length:', text.length);

const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
});
const result = await resp.json();
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
