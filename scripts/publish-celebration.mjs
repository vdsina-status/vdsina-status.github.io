#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig, requireBotToken } from './load-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CONFIG = loadConfig(ROOT);

const text = `<b>🎆🎉 РАДОСТНАЯ НОСТЬ!</b>

<b>Панель управления VDSina снова работает!</b>

✅ <b>cp.vdsina.com</b> — доступен
✅ Можно войти в <b>личный кабинет</b>
✅ API отвечает — авторизация работает

После более чем 9 дней простоя панель .com снова с нами. Проверяйте серверы, тикеты, бэкапы — добро пожаловать обратно! 🚀

⚠️ <i>Напоминание:</i> DC2 по-прежнему недоступен (оборудование изъято). DC3 — частично восстановлен.

🌐 Мониторинг: <a href="https://vdsina-status.github.io">vdsina-status.github.io</a>
📡 Канал: @VdsinaINFO · бот: @VDSINA_INFOBOT

<i>Неофициальный мониторинг сообщества · не VDSina support</i>`;

const { chatId } = CONFIG.telegram;
const botToken = requireBotToken(CONFIG);
console.log('Sending celebration to', chatId);

const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false })
});
const result = await resp.json();
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
