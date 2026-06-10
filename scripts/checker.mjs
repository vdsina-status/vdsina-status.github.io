#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
const DRY_RUN = process.argv.includes('--dry-run');
const STATUS_FILE = path.join(DATA, 'status.json');
const HISTORY_FILE = path.join(DATA, 'history.json');
const CP_CONTENT_FILE = path.join(DATA, 'cp-content.json');

const TIMEOUT_MS = 10000;
const now = () => new Date().toISOString();

// ─── HTTP check ──────────────────────────────────────────────
async function checkEndpoint(ep) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const resp = await fetch(ep.url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'VDSina-Status-Monitor/1.0' }
    });
    clearTimeout(timer);
    const elapsed = Date.now() - start;
    const status = resp.status;
    let bodySnippet = '';
    try { bodySnippet = (await resp.text()).slice(0, 500); } catch {}
    return {
      id: ep.id,
      url: ep.url,
      label: ep.label,
      category: ep.category,
      httpCode: status,
      responseMs: elapsed,
      up: status >= 200 && status < 400,
      redirect: resp.headers.get('location') || null,
      bodySnippet,
      error: null,
      checkedAt: now()
    };
  } catch (err) {
    return {
      id: ep.id,
      url: ep.url,
      label: ep.label,
      category: ep.category,
      httpCode: 0,
      responseMs: Date.now() - start,
      up: false,
      redirect: null,
      bodySnippet: '',
      error: err.code || err.message || 'unknown',
      checkedAt: now()
    };
  }
}

// ─── DNS check ───────────────────────────────────────────────
function checkDNS(domain) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Resolve-DnsName '${domain}' -Type A -ErrorAction Stop | Where-Object { $_.Type -eq 'A' } | Select-Object -ExpandProperty IPAddress"`,
      { timeout: 8000, encoding: 'utf8' }
    ).trim();
    const ips = out.split(/\r?\n/).filter(Boolean);
    return { domain, resolved: true, ips, error: null };
  } catch {
    return { domain, resolved: false, ips: [], error: 'NXDOMAIN or timeout' };
  }
}

// ─── BGP prefix count (RIPE Stat) ───────────────────────────
async function checkBGP(asn) {
  const asnNum = asn.replace(/^AS/i, '');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(
      `https://stat.ripe.net/data/routing-status/data.json?resource=AS${asnNum}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    const json = await resp.json();
    const d = json.data || {};
    return {
      asn,
      v4Prefixes: d.announced_space?.v4?.prefixes || 0,
      v6Prefixes: d.announced_space?.v6?.prefixes || 0,
      v4Ips: d.announced_space?.v4?.ips || 0,
      visibility: d.visibility?.v4?.ris_peers_seeing || 0,
      totalPeers: d.visibility?.v4?.total_ris_peers || 0,
      checkedAt: now(),
      error: null
    };
  } catch (err) {
    return { asn, v4Prefixes: 0, v6Prefixes: 0, v4Ips: 0, visibility: 0, totalPeers: 0, checkedAt: now(), error: err.message };
  }
}

// ─── TCP ping (sample IPs per DC) ────────────────────────────
function tcpPing(ip, port = 80) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "$r = Test-NetConnection '${ip}' -Port ${port} -WarningAction SilentlyContinue; Write-Host $r.TcpTestSucceeded"`,
      { timeout: 12000, encoding: 'utf8' }
    ).trim();
    return out === 'True';
  } catch {
    return false;
  }
}

function checkDCHealth() {
  const results = {};
  for (const [dc, ips] of Object.entries(CONFIG.sampleIPs)) {
    results[dc] = {};
    for (const ip of ips) {
      results[dc][ip] = tcpPing(ip, 80);
    }
  }
  return results;
}

// ─── cp.vdsina.com content parser ────────────────────────────
function parseCpContent(bodySnippet, fullBody) {
  const html = fullBody || bodySnippet;
  const result = { raw: '', updates: [], lastParsed: now() };

  const translationsMatch = html.match(/const\s+translations\s*=\s*(\{[\s\S]*?\});\s*\n\s*function/);
  if (translationsMatch) {
    try {
      const transStr = translationsMatch[1];
      const ruTitleMatch = transStr.match(/title:\s*['"]([^'"]+?серверы[^'"]*?запущены[^'"]*?)['"]/i)
        || transStr.match(/title:\s*['"]([^'"]+?)['"]/);
      const ruTextMatch = transStr.match(/text:\s*['"]([^'"]{50,}?)['"]/);
      if (ruTitleMatch) result.updates.push({ type: 'title', text: ruTitleMatch[1] });
      if (ruTextMatch) result.updates.push({ type: 'detail', text: ruTextMatch[1] });
    } catch {}
  }

  const titleMatch = html.match(/<title[^>]*>([^<]+)/i);
  if (titleMatch) result.raw = titleMatch[1].trim();

  return result;
}

async function fetchCpFullBody() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const resp = await fetch('https://cp.vdsina.com/', {
      signal: controller.signal,
      headers: { 'User-Agent': 'VDSina-Status-Monitor/1.0' }
    });
    clearTimeout(timer);
    return await resp.text();
  } catch {
    return '';
  }
}

// ─── Telegram notification ───────────────────────────────────
async function sendTelegram(text) {
  if (DRY_RUN) { console.log('[DRY-RUN TG]', text); return; }
  const { botToken, chatId } = CONFIG.telegram;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
  } catch (err) {
    console.error('Telegram send failed:', err.message);
  }
}

// ─── Diff detection ─────────────────────────────────────────
function detectChanges(prev, curr) {
  const changes = [];
  if (!prev || !prev.endpoints) return changes;

  const prevMap = {};
  for (const e of (prev.endpoints || [])) prevMap[e.id] = e;

  for (const e of (curr.endpoints || [])) {
    const p = prevMap[e.id];
    if (!p) continue;
    if (p.up !== e.up) {
      changes.push({
        type: e.up ? 'recovery' : 'down',
        id: e.id,
        label: e.label,
        url: e.url,
        prevCode: p.httpCode,
        newCode: e.httpCode,
        prevError: p.error,
        newError: e.error
      });
    }
  }

  if (prev.dns && curr.dns) {
    const prevDns = {};
    for (const d of prev.dns) prevDns[d.domain] = d;
    for (const d of curr.dns) {
      const pd = prevDns[d.domain];
      if (pd && !pd.resolved && d.resolved) {
        changes.push({ type: 'dns_restored', domain: d.domain, ips: d.ips });
      } else if (pd && pd.resolved && !d.resolved) {
        changes.push({ type: 'dns_lost', domain: d.domain });
      }
    }
  }

  return changes;
}

function detectCpChanges(prev, curr) {
  if (!prev || !curr) return null;
  if (prev.raw !== curr.raw) return { type: 'title_changed', from: prev.raw, to: curr.raw };
  const prevTexts = (prev.updates || []).map(u => u.text).join('|');
  const currTexts = (curr.updates || []).map(u => u.text).join('|');
  if (prevTexts !== currTexts) return { type: 'content_changed', prev: prev.updates, curr: curr.updates };
  return null;
}

function formatChanges(changes, cpChange, bgpPrev, bgpCurr) {
  const lines = [];
  lines.push(`<b>🔔 VDSina Status Update</b>`);
  lines.push(`<i>${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}</i>\n`);

  for (const c of changes) {
    if (c.type === 'recovery') {
      lines.push(`✅ <b>${c.label}</b> — восстановлен (HTTP ${c.newCode})`);
    } else if (c.type === 'down') {
      lines.push(`🔴 <b>${c.label}</b> — недоступен (${c.newError || 'HTTP ' + c.newCode})`);
    } else if (c.type === 'dns_restored') {
      lines.push(`📡 DNS: <b>${c.domain}</b> снова резолвится → ${c.ips.join(', ')}`);
    } else if (c.type === 'dns_lost') {
      lines.push(`⚠️ DNS: <b>${c.domain}</b> — записи пропали`);
    }
  }

  if (cpChange) {
    if (cpChange.type === 'title_changed') {
      lines.push(`\n📋 <b>cp.vdsina.com обновлён</b>`);
      lines.push(`Было: ${cpChange.from}`);
      lines.push(`Стало: ${cpChange.to}`);
    } else if (cpChange.type === 'content_changed') {
      lines.push(`\n📋 <b>cp.vdsina.com — текст обновлён</b>`);
      for (const u of (cpChange.curr || [])) {
        lines.push(`  ${u.type}: ${u.text.slice(0, 200)}`);
      }
    }
  }

  if (bgpPrev && bgpCurr && bgpPrev.v4Prefixes && bgpCurr.v4Prefixes) {
    const diff = bgpCurr.v4Prefixes - bgpPrev.v4Prefixes;
    if (Math.abs(diff) >= 2) {
      const arrow = diff > 0 ? '📈' : '📉';
      lines.push(`\n${arrow} BGP AS216071: ${bgpPrev.v4Prefixes}→${bgpCurr.v4Prefixes} IPv4 pfx (${diff > 0 ? '+' : ''}${diff})`);
    }
  }

  return lines.join('\n');
}

// ─── MAIN ────────────────────────────────────────────────────
async function main() {
  console.log(`[${now()}] Starting VDSina status check...`);

  let prevStatus = null;
  let prevCpContent = null;
  try { prevStatus = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch {}
  try { prevCpContent = JSON.parse(fs.readFileSync(CP_CONTENT_FILE, 'utf8')); } catch {}

  // 1. HTTP endpoint checks (parallel)
  console.log('  Checking endpoints...');
  const endpoints = await Promise.all(CONFIG.endpoints.map(checkEndpoint));
  const upCount = endpoints.filter(e => e.up).length;
  console.log(`  ${upCount}/${endpoints.length} endpoints up`);

  // 2. DNS checks
  console.log('  Checking DNS...');
  const dns = CONFIG.dnsChecks.map(checkDNS);
  const dnsUp = dns.filter(d => d.resolved).length;
  console.log(`  ${dnsUp}/${dns.length} DNS records resolved`);

  // 3. BGP check
  console.log('  Checking BGP...');
  const bgp = await checkBGP(CONFIG.asn);
  console.log(`  BGP: ${bgp.v4Prefixes} v4 pfx, ${bgp.v6Prefixes} v6 pfx`);

  // 4. cp.vdsina.com content parse
  console.log('  Parsing cp.vdsina.com content...');
  const cpBody = await fetchCpFullBody();
  const cpContent = parseCpContent('', cpBody);
  console.log(`  CP title: "${cpContent.raw}", updates: ${cpContent.updates.length}`);

  // 5. DC health (TCP pings)
  console.log('  Checking DC health...');
  const dcHealth = checkDCHealth();
  for (const [dc, results] of Object.entries(dcHealth)) {
    const alive = Object.values(results).filter(Boolean).length;
    console.log(`  ${dc}: ${alive}/${Object.keys(results).length} reachable`);
  }

  // 6. Build status object
  const status = {
    checkedAt: now(),
    incidentStart: CONFIG.incidentStart,
    summary: {
      endpointsUp: upCount,
      endpointsTotal: endpoints.length,
      dnsResolved: dnsUp,
      dnsTotal: dns.length,
      bgpV4Prefixes: bgp.v4Prefixes,
      bgpV6Prefixes: bgp.v6Prefixes
    },
    endpoints,
    dns,
    bgp,
    dcHealth,
    cpContent
  };

  // 7. Detect changes
  const changes = detectChanges(prevStatus, status);
  const cpChange = detectCpChanges(prevCpContent, cpContent);
  const hasChanges = changes.length > 0 || cpChange;

  if (hasChanges) {
    console.log(`  🔔 ${changes.length} endpoint changes, CP changed: ${!!cpChange}`);
    const msg = formatChanges(changes, cpChange, prevStatus?.bgp, bgp);
    await sendTelegram(msg);
  } else {
    console.log('  No changes detected.');
  }

  // 8. Save status
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  fs.writeFileSync(CP_CONTENT_FILE, JSON.stringify(cpContent, null, 2));

  // 9. Append to history
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch {}
  history.push({
    t: now(),
    up: upCount,
    total: endpoints.length,
    dns: dnsUp,
    bgpV4: bgp.v4Prefixes,
    dc2: Object.values(dcHealth.dc2 || {}).filter(Boolean).length,
    dc3: Object.values(dcHealth.dc3 || {}).filter(Boolean).length
  });
  // Keep last 30 days at 5-min intervals (~8640 entries)
  if (history.length > 8640) history = history.slice(-8640);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));

  console.log(`[${now()}] Done.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
