const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const pino = require('pino');

const log = pino({ transport: { target: 'pino-pretty' } });

const GROUPS_FILE = path.join(__dirname, 'groups.json');
const REPORTED_FILE = path.join(__dirname, 'reported.json');

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK_URL;
if (!DISCORD_WEBHOOK) {
  log.error('DISCORD_WEBHOOK environment variable is not set. Set it in Render environment variables.');
  process.exit(1);
}

// Config via environment variables (kolay değiştirmek için)
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS) || 2 * 60 * 1000; // default 2 dakika
const RATE_DELAY_MS = Number(process.env.RATE_DELAY_MS) || 900; // her Roblox sorgusu arası ms (0.9s) - nazik davran
const MAX_RETRIES = Number(process.env.MAX_RETRIES) || 2;
const ENABLE_DISCOVERY = (process.env.ENABLE_DISCOVERY || 'true') === 'true';
const DISCOVERY_PAGES = Number(process.env.DISCOVERY_PAGES) || 3; // discovery için kaç sayfa çeksin
const DISCOVERY_LIMIT = Number(process.env.DISCOVERY_LIMIT) || 100; // sayfa başına eleman

const ROBLOX_GROUP_API = 'https://groups.roblox.com/v1/groups/';
const ROBLOX_GROUP_SEARCH = 'https://groups.roblox.com/v1/groups/search';

const app = express();
app.use(express.json());

function readJSON(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    log.warn({ err: e }, `Failed to read ${filePath}`);
  }
  return fallback;
}
function writeJSON(filePath, obj) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    log.error({ err: e }, `Failed to write ${filePath}`);
  }
}

function extractGroupId(text) {
  if (!text) return null;
  text = String(text).trim();
  if (/^\d+$/.test(text)) return text;
  const m = text.match(/groups[\/\?].*?(\d{4,})|groupId=(\d{4,})|\/groups\/(\d{4,})/i);
  if (m) {
    for (let i = 1; i < m.length; i++) if (m[i]) return m[i];
  }
  try {
    const url = new URL(text);
    for (const p of url.pathname.split('/')) if (/^\d+$/.test(p)) return p;
  } catch (e) {}
  const m2 = text.match(/(\d{4,})/);
  return m2 ? m2[1] : null;
}

async function robloxGetGroup(groupId) {
  const url = `${ROBLOX_GROUP_API}${encodeURIComponent(groupId)}`;
  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    try {
      const res = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'RobloxUnclaimedChecker/1.0' }});
      return res.data;
    } catch (err) {
      attempt++;
      if (err.response && (err.response.status === 429 || err.response.status === 503)) {
        // backoff
        const wait = 1000 * Math.pow(2, attempt);
        log.warn({ groupId, status: err.response.status }, `Rate limited or service unavailable. Backing off ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (attempt > MAX_RETRIES) {
        log.error({ err: err.message, groupId }, 'Failed to fetch group after retries');
        return null;
      }
      await sleep(500 * attempt);
    }
  }
  return null;
}

async function discoverCandidateGroupIds(pages = 2, limit = 100) {
  // Güvenli discovery: boş keyword ile birkaç sayfa çek (Roblox dökümantasyonuna göre)
  const ids = new Set();
  for (let page = 1; page <= pages; page++) {
    try {
      const res = await axios.get(ROBLOX_GROUP_SEARCH, {
        params: { keyword: '', limit, page },
        timeout: 8000,
        headers: { 'User-Agent': 'RobloxUnclaimedChecker/1.0' }
      });
      const list = res.data?.data || res.data?.groups || []; // fallback
      for (const g of list) {
        if (g?.id) ids.add(String(g.id));
      }
    } catch (e) {
      log.warn({ err: e.message, page }, 'Discovery page fetch failed, continuing');
      // çok hata olursa break etme, sonraki döngüye devam
    }
    await sleep(500); // discovery aralarında kısa bekle
  }
  return Array.from(ids);
}

async function notifyDiscord(groupInfo) {
  const groupId = groupInfo.id;
  const groupUrl = `https://www.roblox.com/groups/${groupId}`;
  const embed = {
    title: groupInfo.name || `Group ${groupId}`,
    url: groupUrl,
    description: (groupInfo.description || '').slice(0, 190) || 'No description',
    fields: [
      { name: 'Group ID', value: String(groupId), inline: true },
      { name: 'Public Entry', value: String(groupInfo.publicEntryAllowed || false), inline: true },
      { name: 'Checked at (UTC)', value: new Date().toISOString(), inline: false }
    ]
  };
  const payload = {
    content: `⚠️ **Unclaimed group detected**\n**${embed.title}** (ID: ${groupId}) appears to be **unclaimed**.\n${groupUrl}`,
    embeds: [embed]
  };
  try {
    const res = await axios.post(DISCORD_WEBHOOK, payload, { timeout: 8000, headers: { 'Content-Type': 'application/json' }});
    log.info({ status: res.status, groupId }, 'Notified Discord');
    return true;
  } catch (e) {
    log.error({ err: e.message, groupId }, 'Failed to notify Discord');
    return false;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function checkAndReportGroup(groupId, reportedSet) {
  const info = await robloxGetGroup(groupId);
  if (!info) return; // hata zaten loglandı
  if (!info.owner) {
    if (reportedSet.has(String(groupId))) {
      log.info({ groupId }, 'Already reported, skipping');
    } else {
      const notified = await notifyDiscord(info);
      if (notified) {
        reportedSet.add(String(groupId));
        writeJSON(REPORTED_FILE, Array.from(reportedSet));
      }
    }
  } else {
    log.debug({ groupId, owner: info.owner?.name || info.owner }, 'Has owner');
  }
}

async function runScanOnce() {
  log.info('Starting scan cycle');
  // read groups.json
  const raw = readJSON(GROUPS_FILE, []);
  const groupIds = new Set();
  for (const g of raw) {
    const id = extractGroupId(g);
    if (id) groupIds.add(id);
  }

  // optional discovery
  if (ENABLE_DISCOVERY) {
    const discovered = await discoverCandidateGroupIds(DISCOVERY_PAGES, DISCOVERY_LIMIT);
    for (const id of discovered) groupIds.add(id);
    log.info({ discoveredCount: discovered.length }, 'Discovery added candidates');
  }

  // read reported
  const reportedArr = readJSON(REPORTED_FILE, []);
  const reportedSet = new Set(reportedArr.map(String));

  // iterate with gentle rate limiting
  for (const gid of Array.from(groupIds)) {
    try {
      await checkAndReportGroup(gid, reportedSet);
    } catch (e) {
      log.warn({ err: e.message, gid }, 'Error checking group');
    }
    await sleep(RATE_DELAY_MS);
  }
  log.info('Scan cycle finished');
}

// automatic periodic scanner
let intervalHandle = null;
function startPeriodicScanner() {
  if (intervalHandle) return;
  runScanOnce().catch(e => log.error({ err: e.message }, 'Initial run failed'));
  intervalHandle = setInterval(() => {
    runScanOnce().catch(e => log.error({ err: e.message }, 'Scheduled run failed'));
  }, CHECK_INTERVAL_MS);
  log.info({ CHECK_INTERVAL_MS, RATE_DELAY_MS }, 'Periodic scanner started');
}

// express endpoints for control & quick checks
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.post('/scan-now', async (req, res) => {
  try {
    await runScanOnce();
    return res.json({ ok: true, msg: 'Scan triggered' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});
app.post('/add', (req, res) => {
  const input = (req.body.input || req.query.input || '').toString();
  const id = extractGroupId(input);
  if (!id) return res.status(400).json({ ok: false, error: 'Geçerli grup ID/linki gerekli' });
  const arr = readJSON(GROUPS_FILE, []);
  if (arr.find(x => String(x) === String(id))) return res.json({ ok: true, msg: 'Zaten listede' });
  arr.push(String(id));
  writeJSON(GROUPS_FILE, arr);
  return res.json({ ok: true, added: id });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  log.info(`Server listening on port ${PORT}`);
  startPeriodicScanner();
});
