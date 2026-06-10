#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import crypto from 'crypto';
import dnsLib from 'dns/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
const DRY_RUN = process.argv.includes('--dry-run');
const STATUS_FILE = path.join(DATA, 'status.json');
const HISTORY_FILE = path.join(DATA, 'history.json');
const CP_CONTENT_FILE = path.join(DATA, 'cp-content.json');
const CP_SNAPSHOTS_DIR = path.join(DATA, 'snapshots');
const RANGES_FILE = path.join(DATA, 'ranges-status.json');

const TIMEOUT_MS = 16000;
const SSH_TIMEOUT = 5000;
const PROBE_OFFSETS = [5, 10, 50, 100];
const now = () => new Date().toISOString();

// Folk DC mapping — based on community reports from t.me/vdsina_chat
const FOLK_DC_MAP = {
  dc2_dead:  ['89.110','212.34','91.84','94.103','77.238','87.199','195.63','80.85','77.105',
              '141.163','144.124','146.103','178.130','178.217','185.121','185.157','185.21',
              '185.245','193.178','194.164','194.246','194.60','195.200','195.26','212.111',
              '91.246','93.183','5.35'],
  dc3_alive: ['109.107','109.234','46.151','46.149','77.246','89.124','91.201','78.40',
              '88.210','62.84','212.118','195.2','193.33','94.103']
};

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
    let bodySnippet = '';
    try { bodySnippet = (await resp.text()).slice(0, 500); } catch {}
    return {
      id: ep.id, url: ep.url, label: ep.label, category: ep.category,
      httpCode: resp.status, responseMs: elapsed,
      up: resp.status >= 200 && resp.status < 400,
      redirect: resp.headers.get('location') || null,
      bodySnippet, error: null, checkedAt: now()
    };
  } catch (err) {
    return {
      id: ep.id, url: ep.url, label: ep.label, category: ep.category,
      httpCode: 0, responseMs: Date.now() - start, up: false,
      redirect: null, bodySnippet: '',
      error: err.code || err.message || 'unknown', checkedAt: now()
    };
  }
}

// ─── DNS check (cross-platform via Node.js dns) ─────────────
async function checkDNS(domain) {
  try {
    const result = await dnsLib.resolve4(domain);
    return { domain, resolved: true, ips: result, error: null };
  } catch (err) {
    return { domain, resolved: false, ips: [], error: err.code || 'NXDOMAIN' };
  }
}

// ─── BGP prefix count (RIPE Stat) ───────────────────────────
async function checkBGP(asn) {
  const asnNum = asn.replace(/^AS/i, '');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
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
      checkedAt: now(), error: null
    };
  } catch (err) {
    return { asn, v4Prefixes: 0, v6Prefixes: 0, v4Ips: 0, visibility: 0, totalPeers: 0, checkedAt: now(), error: err.message };
  }
}

// ─── SSH banner check ────────────────────────────────────────
function sshBannerCheck(ip, timeoutMs = SSH_TIMEOUT) {
  return new Promise(resolve => {
    const sock = net.createConnection({ host: ip, port: 22 });
    let banner = '';
    const timer = setTimeout(() => { sock.destroy(); resolve({ ip, alive: false, banner: '' }); }, timeoutMs);
    sock.on('data', d => { banner += d.toString(); sock.destroy(); });
    sock.on('close', () => { clearTimeout(timer); resolve({ ip, alive: banner.startsWith('SSH-'), banner: banner.trim().slice(0, 80) }); });
    sock.on('error', () => { clearTimeout(timer); resolve({ ip, alive: false, banner: '' }); });
  });
}

// ─── Extended range scan ─────────────────────────────────────
async function fetchPrefixes() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const resp = await fetch(
      'https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS216071',
      { signal: controller.signal }
    );
    clearTimeout(timer);
    const json = await resp.json();
    return json.data?.prefixes?.map(p => p.prefix) || [];
  } catch { return []; }
}

function classifyDC(rangeKey, alive, total) {
  for (const key of FOLK_DC_MAP.dc3_alive) {
    if (rangeKey.startsWith(key)) return alive > 0 ? 'DC3' : 'DC3 (down)';
  }
  for (const key of FOLK_DC_MAP.dc2_dead) {
    if (rangeKey.startsWith(key)) return alive > 0 ? 'DC2 (partial)' : 'DC2';
  }
  if (alive === total) return 'OK';
  if (alive > 0) return 'partial';
  return 'unknown';
}

async function scanRanges() {
  const prefixes = await fetchPrefixes();
  if (!prefixes.length) return null;

  const groups = {};
  for (const pfx of prefixes) {
    const m = pfx.match(/^(\d+\.\d+)\./);
    if (m) {
      if (!groups[m[1]]) groups[m[1]] = [];
      groups[m[1]].push(pfx);
    }
  }

  const results = [];
  const sortedKeys = Object.keys(groups).sort();

  for (let i = 0; i < sortedKeys.length; i += 10) {
    const batch = sortedKeys.slice(i, i + 10);
    const batchPromises = batch.map(async key => {
      const firstPfx = groups[key][0];
      const base = firstPfx.replace(/\/\d+$/, '').split('.');

      const probes = PROBE_OFFSETS.map(off =>
        sshBannerCheck(`${base[0]}.${base[1]}.${base[2]}.${off}`)
      );
      const checks = await Promise.all(probes);
      const alive = checks.filter(c => c.alive).length;
      const banners = checks.filter(c => c.banner).map(c => c.banner);

      return {
        range: `${key}.x.x`,
        prefixCount: groups[key].length,
        probes: PROBE_OFFSETS.map((off, idx) => ({
          ip: `${base[0]}.${base[1]}.${base[2]}.${off}`,
          alive: checks[idx].alive,
          banner: checks[idx].banner
        })),
        alive,
        total: PROBE_OFFSETS.length,
        percent: Math.round(alive / PROBE_OFFSETS.length * 100),
        dc: classifyDC(key, alive, PROBE_OFFSETS.length),
        banner: banners[0] || '',
        status: alive === 0 ? 'DEAD' : alive < PROBE_OFFSETS.length ? 'PARTIAL' : 'ALIVE'
      };
    });
    results.push(...await Promise.all(batchPromises));
  }

  return results;
}

// ─── cp.vdsina.com parser + snapshot ─────────────────────────
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
  } catch { return ''; }
}

function parseCpContent(html) {
  const result = { raw: '', updates: [], hash: '', lastParsed: now() };
  if (!html) return result;

  result.hash = crypto.createHash('sha256').update(html).digest('hex').slice(0, 16);

  const titleMatch = html.match(/<title[^>]*>([^<]+)/i);
  if (titleMatch) result.raw = titleMatch[1].trim();

  // Extract Russian "ru" block — stops before "en:" block
  const ruBlock = html.match(/ru:\s*\{([\s\S]*?)\n\s*\},?\s*\n\s*en:\s*\{/);
  if (ruBlock) {
    try {
      const ru = ruBlock[1];
      const updateSection = ru.match(/update:\s*\{([\s\S]*?)\n\s{8}\}/);
      if (updateSection) {
        const us = updateSection[1];
        const t = us.match(/title:\s*'([^']+)'/);
        const x = us.match(/text:\s*'([^']+)'/);
        if (t) result.updates.push({ type: 'title', text: t[1] });
        if (x) result.updates.push({ type: 'detail', text: x[1] });
      }
      const mainSection = ru.match(/main:\s*\{([\s\S]*?)\n\s{8}\}/);
      if (mainSection) {
        const ms = mainSection[1];
        const lead = ms.match(/lead:\s*'([^']+)'/);
        if (lead) result.updates.push({ type: 'lead', text: lead[1] });
      }
    } catch {}
  }

  return result;
}

function saveCpSnapshot(html, hash) {
  if (!html || !hash) return;
  try {
    fs.mkdirSync(CP_SNAPSHOTS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(CP_SNAPSHOTS_DIR, `cp-${ts}-${hash}.html`);
    const existing = fs.readdirSync(CP_SNAPSHOTS_DIR).filter(f => f.includes(hash));
    if (existing.length === 0) {
      fs.writeFileSync(file, html);
      console.log(`  Snapshot saved: cp-${ts}-${hash}.html`);
      return true;
    }
  } catch (err) { console.error('  Snapshot save error:', err.message); }
  return false;
}

// ─── Telegram ────────────────────────────────────────────────
async function sendTelegram(text) {
  if (DRY_RUN) { console.log('[DRY-RUN TG]', text); return; }
  const { botToken, chatId } = CONFIG.telegram;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
  } catch (err) { console.error('Telegram send failed:', err.message); }
}

// ─── Change detection ────────────────────────────────────────
function detectChanges(prev, curr) {
  const changes = [];
  if (!prev?.endpoints) return changes;
  const prevMap = {};
  for (const e of prev.endpoints) prevMap[e.id] = e;
  for (const e of curr.endpoints) {
    const p = prevMap[e.id];
    if (p && p.up !== e.up) {
      changes.push({
        type: e.up ? 'recovery' : 'down',
        label: e.label, url: e.url,
        prevCode: p.httpCode, newCode: e.httpCode,
        newError: e.error
      });
    }
  }
  if (prev.dns && curr.dns) {
    const pd = {}; for (const d of prev.dns) pd[d.domain] = d;
    for (const d of curr.dns) {
      const p = pd[d.domain];
      if (p && !p.resolved && d.resolved) changes.push({ type: 'dns_restored', domain: d.domain, ips: d.ips });
      else if (p && p.resolved && !d.resolved) changes.push({ type: 'dns_lost', domain: d.domain });
    }
  }
  return changes;
}

function detectRangeChanges(prev, curr) {
  if (!prev?.length || !curr?.length) return [];
  const changes = [];
  const prevMap = {}; for (const r of prev) prevMap[r.range] = r;
  for (const r of curr) {
    const p = prevMap[r.range];
    if (!p) continue;
    if (p.status === 'DEAD' && r.status !== 'DEAD') changes.push({ type: 'range_up', range: r.range, dc: r.dc, alive: r.alive, total: r.total });
    else if (p.status !== 'DEAD' && r.status === 'DEAD') changes.push({ type: 'range_down', range: r.range, dc: r.dc });
  }
  return changes;
}

function formatNotification(changes, cpChange, rangeChanges, bgpPrev, bgpCurr) {
  const lines = [`<b>🔔 VDSina Status Update</b>`, `<i>${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}</i>\n`];
  for (const c of changes) {
    if (c.type === 'recovery') lines.push(`✅ <b>${c.label}</b> — восстановлен (HTTP ${c.newCode})`);
    else if (c.type === 'down') lines.push(`🔴 <b>${c.label}</b> — недоступен (${c.newError || 'HTTP ' + c.newCode})`);
    else if (c.type === 'dns_restored') lines.push(`📡 DNS: <b>${c.domain}</b> → ${c.ips.join(', ')}`);
    else if (c.type === 'dns_lost') lines.push(`⚠️ DNS: <b>${c.domain}</b> — пропал`);
  }
  for (const c of rangeChanges) {
    if (c.type === 'range_up') lines.push(`🟢 Диапазон <b>${c.range}</b> (${c.dc}) — ожил (${c.alive}/${c.total} SSH)`);
    else if (c.type === 'range_down') lines.push(`🔴 Диапазон <b>${c.range}</b> (${c.dc}) — упал`);
  }
  if (cpChange) {
    if (cpChange.type === 'hash_changed') {
      lines.push(`\n📋 <b>cp.vdsina.com обновлён!</b>`);
      lines.push(`Hash: ${cpChange.from} → ${cpChange.to}`);
      if (cpChange.newUpdates?.length) {
        for (const u of cpChange.newUpdates.slice(0, 3)) lines.push(`  ${u.type}: ${u.text.slice(0, 150)}`);
      }
    }
  }
  if (bgpPrev?.v4Prefixes && bgpCurr?.v4Prefixes) {
    const diff = bgpCurr.v4Prefixes - bgpPrev.v4Prefixes;
    if (Math.abs(diff) >= 2) lines.push(`\n${diff > 0 ? '📈' : '📉'} BGP: ${bgpPrev.v4Prefixes}→${bgpCurr.v4Prefixes} pfx (${diff > 0 ? '+' : ''}${diff})`);
  }
  lines.push(`\n🌐 https://vdsina-status.github.io`);
  return lines.join('\n');
}

// ─── MAIN ────────────────────────────────────────────────────
async function main() {
  console.log(`[${now()}] VDSina status check starting...`);

  let prevStatus = null, prevCpContent = null;
  try { prevStatus = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch {}
  try { prevCpContent = JSON.parse(fs.readFileSync(CP_CONTENT_FILE, 'utf8')); } catch {}

  // 1. HTTP endpoints (parallel)
  console.log('  [1/6] Endpoints...');
  const endpoints = await Promise.all(CONFIG.endpoints.map(checkEndpoint));
  const upCount = endpoints.filter(e => e.up).length;
  console.log(`    ${upCount}/${endpoints.length} UP`);

  // 2. DNS (parallel)
  console.log('  [2/6] DNS...');
  const dnsResults = await Promise.all(CONFIG.dnsChecks.map(checkDNS));
  const dnsUp = dnsResults.filter(d => d.resolved).length;
  console.log(`    ${dnsUp}/${dnsResults.length} resolved`);

  // 3. BGP
  console.log('  [3/6] BGP...');
  const bgp = await checkBGP(CONFIG.asn);
  console.log(`    ${bgp.v4Prefixes} v4, ${bgp.v6Prefixes} v6 prefixes`);

  // 4. cp.vdsina.com parse + snapshot
  console.log('  [4/6] cp.vdsina.com...');
  const cpBody = await fetchCpFullBody();
  const cpContent = parseCpContent(cpBody);
  console.log(`    title="${cpContent.raw}" hash=${cpContent.hash} updates=${cpContent.updates.length}`);
  const isNewSnapshot = saveCpSnapshot(cpBody, cpContent.hash);

  // 5. Extended range scan (SSH banners, 4 probes per range)
  console.log('  [5/6] IP ranges (extended SSH scan)...');
  const rangeStatus = await scanRanges();
  if (rangeStatus) {
    const rAlive = rangeStatus.filter(r => r.status === 'ALIVE').length;
    const rPartial = rangeStatus.filter(r => r.status === 'PARTIAL').length;
    const rDead = rangeStatus.filter(r => r.status === 'DEAD').length;
    console.log(`    ${rAlive} ALIVE, ${rPartial} PARTIAL, ${rDead} DEAD (${rangeStatus.length} ranges)`);
    fs.writeFileSync(RANGES_FILE, JSON.stringify(rangeStatus, null, 2));

    // Auto-classify DC
    const dcSummary = { DC2: { alive: 0, dead: 0, ranges: [] }, DC3: { alive: 0, dead: 0, ranges: [] }, other: { alive: 0, dead: 0, ranges: [] } };
    for (const r of rangeStatus) {
      const bucket = r.dc.startsWith('DC2') ? 'DC2' : r.dc.startsWith('DC3') ? 'DC3' : 'other';
      if (r.status !== 'DEAD') dcSummary[bucket].alive++;
      else dcSummary[bucket].dead++;
      dcSummary[bucket].ranges.push(r.range);
    }
    for (const [dc, s] of Object.entries(dcSummary)) {
      if (s.ranges.length) console.log(`    ${dc}: ${s.alive} alive / ${s.dead} dead (${s.ranges.length} ranges)`);
    }
  }

  // 6. Build status
  console.log('  [6/6] Building status...');
  const status = {
    checkedAt: now(),
    incidentStart: CONFIG.incidentStart,
    summary: {
      endpointsUp: upCount, endpointsTotal: endpoints.length,
      dnsResolved: dnsUp, dnsTotal: dnsResults.length,
      bgpV4Prefixes: bgp.v4Prefixes, bgpV6Prefixes: bgp.v6Prefixes,
      rangesAlive: rangeStatus?.filter(r => r.status !== 'DEAD').length || 0,
      rangesTotal: rangeStatus?.length || 0
    },
    endpoints, dns: dnsResults, bgp, rangeStatus, cpContent
  };

  // Detect changes
  const changes = detectChanges(prevStatus, status);
  const rangeChanges = detectRangeChanges(prevStatus?.rangeStatus, rangeStatus);
  let cpChange = null;
  if (prevCpContent?.hash && cpContent.hash && prevCpContent.hash !== cpContent.hash) {
    cpChange = { type: 'hash_changed', from: prevCpContent.hash, to: cpContent.hash, newUpdates: cpContent.updates };
  }

  const hasChanges = changes.length > 0 || rangeChanges.length > 0 || cpChange;
  if (hasChanges) {
    console.log(`  🔔 Changes: ${changes.length} endpoints, ${rangeChanges.length} ranges, CP: ${!!cpChange}`);
    const msg = formatNotification(changes, cpChange, rangeChanges, prevStatus?.bgp, bgp);
    await sendTelegram(msg);
  } else {
    console.log('  No changes.');
  }

  // Periodic summary every 6 hours
  const SUMMARY_FILE = path.join(DATA, 'last-summary.json');
  let lastSummary = 0;
  try { lastSummary = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8')).t || 0; } catch {}
  const hoursSince = (Date.now() - lastSummary) / 3600000;
  if (hoursSince >= 6) {
    console.log(`  📊 Sending 6h periodic summary (last: ${hoursSince.toFixed(1)}h ago)...`);
    const incMs = Date.now() - new Date(CONFIG.incidentStart).getTime();
    const days = Math.floor(incMs / 864e5);
    const hrs = Math.floor(incMs % 864e5 / 36e5);

    // Compute deltas from history
    let h6ago = null, h24ago = null;
    let hist = [];
    try { hist = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch {}
    const h6idx = hist.length > 72 ? hist.length - 73 : 0;
    const h24idx = hist.length > 288 ? hist.length - 289 : 0;
    h6ago = hist[h6idx] || null;
    h24ago = hist[h24idx] || null;
    const latest = hist[hist.length - 1] || {};

    const d = (label, prev, curr) => {
      if (prev === undefined || curr === undefined) return '';
      const diff = curr - prev;
      if (diff === 0) return `${label}: ${curr} (=)`;
      return `${label}: ${prev}→${curr} (${diff > 0 ? '+' : ''}${diff})`;
    };

    const dc2a = rangeStatus?.filter(r => r.dc?.startsWith('DC2') && r.status !== 'DEAD').length || 0;
    const dc2t = rangeStatus?.filter(r => r.dc?.startsWith('DC2')).length || 0;
    const dc3a = rangeStatus?.filter(r => r.dc?.startsWith('DC3') && r.status !== 'DEAD').length || 0;
    const dc3t = rangeStatus?.filter(r => r.dc?.startsWith('DC3')).length || 0;

    let summary = `<b>📊 VDSina — сводка каждые 6ч</b>\n`;
    summary += `<i>${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}</i>\n\n`;
    summary += `⏱ Инцидент: <b>${days}д ${hrs}ч</b>\n\n`;
    summary += `🌐 Эндпоинты: <b>${upCount}/${endpoints.length}</b> UP\n`;
    summary += `📡 DNS: <b>${dnsUp}/${dnsResults.length}</b>\n`;
    summary += `📊 BGP v4: <b>${bgp.v4Prefixes}</b> pfx\n`;
    summary += `📡 Диапазоны: <b>${status.summary.rangesAlive}/${status.summary.rangesTotal}</b>\n`;
    summary += `🔴 DC2: ${dc2a}/${dc2t} живых | 🟡 DC3: ${dc3a}/${dc3t} живых\n`;

    if (h6ago) {
      summary += `\n<b>Δ за 6ч:</b> `;
      summary += [d('UP', h6ago.up, latest.up), d('DNS', h6ago.dns, latest.dns), d('BGP', h6ago.bgpV4, latest.bgpV4), d('Ranges', h6ago.rangesAlive, latest.rangesAlive)].filter(Boolean).join(' · ');
    }
    if (h24ago) {
      summary += `\n<b>Δ за 24ч:</b> `;
      summary += [d('UP', h24ago.up, latest.up), d('DNS', h24ago.dns, latest.dns), d('BGP', h24ago.bgpV4, latest.bgpV4), d('Ranges', h24ago.rangesAlive, latest.rangesAlive)].filter(Boolean).join(' · ');
    }

    const cpTitle = cpContent.updates?.find(u => u.type === 'title');
    if (cpTitle) summary += `\n\n📋 cp.vdsina.com: <i>${cpTitle.text}</i>`;

    summary += `\n\n🌐 https://vdsina-status.github.io`;
    await sendTelegram(summary);
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify({ t: Date.now() }));
    console.log('  Summary sent.');
  }

  // Save
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  fs.writeFileSync(CP_CONTENT_FILE, JSON.stringify(cpContent, null, 2));

  // History
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch {}
  history.push({
    t: now(),
    up: upCount,
    total: endpoints.length,
    dns: dnsUp,
    bgpV4: bgp.v4Prefixes,
    rangesAlive: status.summary.rangesAlive,
    rangesTotal: status.summary.rangesTotal
  });
  if (history.length > 8640) history = history.slice(-8640);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));

  console.log(`[${now()}] Done.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
