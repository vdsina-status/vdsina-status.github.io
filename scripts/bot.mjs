#!/usr/bin/env node
/**
 * Telegram bot for @VdsinaINFO — responds to /status, /check IP, /ip IP
 * Run: node scripts/bot.mjs
 * Uses long-polling (no webhook needed)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
const { botToken } = CONFIG.telegram;
const API = `https://api.telegram.org/bot${botToken}`;

const FOLK_DC = {
  dc2: ['89.110','212.34','91.84','77.238','87.199','80.85','77.105',
        '141.163','144.124','178.130','178.217','185.121','185.157','185.21',
        '185.245','193.178','194.164','194.246','194.60','195.200','195.26','212.111',
        '91.246','93.183'],
  dc3: ['109.107','109.234','46.151','46.149','77.246','89.124','91.201','78.40',
        '88.210','62.84','212.118','195.2','193.33','94.103','146.103'],
  mixed: ['5.35','195.63']
};

function findDC(ip) {
  const prefix = ip.split('.').slice(0, 2).join('.');
  if (FOLK_DC.dc3.includes(prefix)) return { dc: 'DC3', label: 'DC3 (восстанавливается)', emoji: '🟡' };
  if (FOLK_DC.dc2.includes(prefix)) return { dc: 'DC2', label: 'DC2 (мёртв — оборудование изъято)', emoji: '🔴' };
  if (FOLK_DC.mixed?.includes(prefix)) return { dc: 'mixed', label: 'Смешанный (частично работает)', emoji: '🟡' };
  return { dc: 'unknown', label: 'AS216071 — DC не определён', emoji: '⚪' };
}

function sshCheck(ip, timeout = 5000) {
  return new Promise(resolve => {
    const sock = net.createConnection({ host: ip, port: 22 });
    let banner = '';
    const timer = setTimeout(() => { sock.destroy(); resolve({ alive: false, banner: '' }); }, timeout);
    sock.on('data', d => { banner += d.toString(); sock.destroy(); });
    sock.on('close', () => { clearTimeout(timer); resolve({ alive: banner.startsWith('SSH-'), banner: banner.trim().slice(0, 60) }); });
    sock.on('error', () => { clearTimeout(timer); resolve({ alive: false, banner: '' }); });
  });
}

async function send(chatId, text) {
  await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
}

async function handleStatus(chatId) {
  let status;
  try { status = JSON.parse(fs.readFileSync(path.join(DATA, 'status.json'), 'utf8')); } catch {
    return send(chatId, '❌ Данные ещё не собраны. Запустите checker.mjs.');
  }
  const s = status.summary;
  const incMs = Date.now() - new Date(status.incidentStart).getTime();
  const days = Math.floor(incMs / 864e5);
  const hrs = Math.floor(incMs % 864e5 / 36e5);

  let text = `<b>📊 VDSina Status</b>\n<i>${new Date(status.checkedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}</i>\n\n`;
  text += `⏱ Инцидент: <b>${days}д ${hrs}ч</b>\n`;
  text += `🌐 Эндпоинты: <b>${s.endpointsUp}/${s.endpointsTotal}</b> UP\n`;
  text += `📡 DNS: <b>${s.dnsResolved}/${s.dnsTotal}</b>\n`;
  text += `📊 BGP v4: <b>${s.bgpV4Prefixes}</b> pfx\n`;
  text += `📡 Диапазоны: <b>${s.rangesAlive || '?'}/${s.rangesTotal || '?'}</b> живых\n`;

  if (status.cpContent?.updates?.length) {
    text += `\n📋 <b>cp.vdsina.com:</b>\n`;
    for (const u of status.cpContent.updates.slice(0, 2)) {
      text += `  ${u.text.slice(0, 120)}\n`;
    }
  }

  text += `\n🌐 https://vdsina-status.github.io`;
  await send(chatId, text);
}

async function handleCheck(chatId, ip) {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    return send(chatId, '❌ Неверный формат IP. Пример: /check 89.110.70.5');
  }

  const dc = findDC(ip);
  await send(chatId, `🔍 Проверяю <code>${ip}</code>...\n${dc.emoji} Предполагаемый DC: <b>${dc.label}</b>\nSSH-проверка запущена...`);

  const ssh = await sshCheck(ip);
  let result = `<b>Результат для ${ip}:</b>\n`;
  result += `${dc.emoji} DC: <b>${dc.label}</b>\n`;
  if (ssh.alive) {
    result += `✅ SSH: <b>ALIVE</b>\n`;
    result += `📝 Banner: <code>${ssh.banner}</code>`;
  } else {
    result += `🔴 SSH: <b>НЕТ ОТВЕТА</b> (нет SSH-баннера)\n`;
    result += `⚠️ TCP-порт может быть открыт через StormWall прокси, но VM не отвечает`;
  }
  await send(chatId, result);
}

async function handleIP(chatId, ip) {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    return send(chatId, '❌ Неверный формат IP. Пример: /ip 89.110.70.5');
  }
  const dc = findDC(ip);
  let text = `${dc.emoji} <b>${ip}</b> → <b>${dc.label}</b>\n\n`;
  if (dc.dc === 'dc2' || dc.dc === 'DC2') {
    text += '⚠️ DC2 серверы недоступны с 2 июня 2026.\nОборудование изъято nLighten/FIOD в Нидерландах.\nВосстановление маловероятно.';
  } else if (dc.dc === 'dc3' || dc.dc === 'DC3') {
    text += '🔄 DC3 частично восстановлен после переезда.\nПроверьте SSH: /check ' + ip;
  } else {
    text += 'DC не определён по народной базе.\nПроверьте SSH: /check ' + ip;
  }
  await send(chatId, text);
}

async function handleHelp(chatId) {
  await send(chatId, `<b>VDSina Status Bot</b> — команды:\n\n` +
    `/status — текущий статус всех сервисов\n` +
    `/check 89.110.70.5 — проверить IP (SSH-баннер)\n` +
    `/ip 89.110.70.5 — определить DC по IP\n` +
    `/help — эта справка\n\n` +
    `🌐 Дашборд: https://vdsina-status.github.io\n` +
    `📡 Автоуведомления приходят при изменении статуса.`);
}

// ─── Long polling ────────────────────────────────────────────
let offset = 0;

async function poll() {
  try {
    const resp = await fetch(`${API}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message"]`);
    const data = await resp.json();
    if (!data.ok) { console.error('Poll error:', data); return; }

    for (const upd of data.result || []) {
      offset = upd.update_id + 1;
      const msg = upd.message;
      if (!msg?.text) continue;

      const chatId = msg.chat.id;
      const text = msg.text.trim();
      const parts = text.split(/\s+/);
      const cmd = parts[0].toLowerCase().replace(/@\w+$/, '');
      const arg = parts[1] || '';

      console.log(`[${new Date().toISOString()}] ${msg.from?.username || msg.from?.id}: ${text}`);

      try {
        if (cmd === '/status' || cmd === '/start') await handleStatus(chatId);
        else if (cmd === '/check') await handleCheck(chatId, arg);
        else if (cmd === '/ip') await handleIP(chatId, arg);
        else if (cmd === '/help') await handleHelp(chatId);
      } catch (err) {
        console.error('Handler error:', err.message);
        await send(chatId, `❌ Ошибка: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('Poll error:', err.message);
    await new Promise(r => setTimeout(r, 5000));
  }
}

console.log('VDSina Status Bot started. Waiting for messages...');
while (true) { await poll(); }
