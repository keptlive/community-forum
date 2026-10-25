#!/usr/bin/env node
// Polis API proxy + WhatsApp voting handler
// Proxies requests through Polis's own REST API with proper JWT auth
// Also handles programmatic WhatsApp voting flow via XID
// Listens on port 9876

const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const petitions = require('./petitions');
const push = require('./push');

const PORT = parseInt(process.env.PORT || '9876', 10);

// --- Branding / endpoints (single place to change for a rebrand) ---
// PUBLIC_URL: what users see in links. POLIS_URL: where API calls actually go
// (local HTTP to the docker-published server port, so an expired/renamed public
// cert can never silently break voting again).
const BRAND_NAME = process.env.BRAND_NAME || 'Community Forum';
const PUBLIC_URL = process.env.POLIS_PUBLIC_URL || 'https://forum.example.org';
const POLIS_URL = process.env.POLIS_API_URL || 'http://127.0.0.1:5000';
// JWT issuer must equal Polis's POLIS_JWT_ISSUER — a fixed internal value,
// independent of the public domain (which can change).
const JWT_ISS = process.env.POLIS_JWT_ISS || 'https://croton.kept.live/';
const KEY_PATH = process.env.POLIS_JWT_KEY || path.join(__dirname, 'jwt-private.pem');
const ADMIN_UID = parseInt(process.env.POLIS_ADMIN_UID || '2', 10);
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'voting-state.json');
// The WhatsApp bridge (server/whatsapp.js) is retired in favour of push
// notifications and stays switched off: POLIS_WHATSAPP=on brings it back,
// with its POLIS_WA_* settings. Off, nothing is queued for WhatsApp and no
// WhatsApp contact is used, but what it stored is kept.
const wa = process.env.POLIS_WHATSAPP === 'on' ? require('./whatsapp') : null;

// The bridge's own data, kept in the state file either way: DM sessions
// (phone -> { zinvite, token, pid, lastTid, lastStatement, phase, subscribed }),
// the outgoing queue WireClaw collects, and topic subgroups (zinvite -> JID).
let waData = { userState: {}, pendingNotifications: [], waTopicGroups: {} };

// Track last known comment count per conversation (for new-statement detection)
let conversationCommentCounts = {};

// Community-created topics (via the public web hub): zinvite -> { creatorKey, ip, created }
// The creatorKey lets the creator (and only them) close their own topic.
let communityTopics = {};

// Web hub accounts (lightweight, no passwords — an account is just a display
// name + a notification channel): accountId -> { name, channel: 'email'|'whatsapp',
// contact, subs: [zinvite], allTopics: bool, created }
// Each topic's "group" = the accounts whose subs include its zinvite.
let webAccounts = {};

// Human-readable URLs: slug -> zinvite (canonical share links /t/<slug>)
let topicSlugs = {};

// In-flight signup verifications: claimId -> { token?, code?, attempts,
// name, channel, contact, allTopics, previousAccountId, created, verified,
// accountId }. Accounts are only created/handed out after verification.
let pendingVerifications = {};

// Active topics we've seen (zinvite -> topic) — diffed each checker cycle to
// detect closes regardless of how they happened.
let knownActiveTopics = {};

// Statements that arrived while a recipient was cooling down accumulate here
// ("recipient|zinvite" -> count) and ride along with the next allowed alert.
let pendingCounts = {};

// Weekly unvoted-backlog nudges ("contact" -> ts of last nudge).
let nudgeLog = {};

// One-time codes that carry an account into an iPhone Home Screen app, which
// starts with storage of its own: code -> { accountId, created }.
let deviceCodes = {};
const DEVICE_CODE_TTL = 30 * 60000;      // it sits in the address bar, next to Share

// Short-lived cache for /public/results (zinvite -> { ts, body }).
const resultsCache = {};

// Per-account stats cache (accountId -> { ts, body })
const statsCache = {};

// Bug report throttle (hashed IP -> timestamps)
const bugReportLog = {};
// Push sign-ups and refreshes (hashed IP -> timestamps)
const pushLog = {};
const pushAccountLog = {};

function throttled(log, key, limit, windowMs) {
  const now = Date.now();
  const hits = (log[key] || []).filter(t => now - t < windowMs);
  log[key] = hits;
  if (hits.length >= limit) return true;
  hits.push(now);
  return false;
}
const BUG_EMAIL = process.env.POLIS_BUG_EMAIL || '';

// WhatsApp statement authors ("phone|zinvite" -> ts): skip their next
// new-statement alert — it's (at least partly) their own statement.
let recentAuthors = {};

// Per-recipient/topic notification cooldown ("recipient|zinvite" -> ts).
// Statement notifications for one topic reach any given person or group at
// most once an hour — an active topic must not turn into a ping firehose.
let notifyCooldown = {};
const NOTIFY_MIN_INTERVAL = 60 * 60000;
function notifyAllowed(recipient, zinvite) {
  const k = `${recipient}|${zinvite}`;
  if (Date.now() - (notifyCooldown[k] || 0) < NOTIFY_MIN_INTERVAL) return false;
  notifyCooldown[k] = Date.now();
  return true;
}

// Cooldown-aware count: returns 0 when suppressed (count accumulates for
// later), otherwise newCount plus anything accumulated during the cooldown.
// Recent statement authors skip one alert (it announces their own words).
function notifyCount(recipient, zinvite, newCount) {
  const k = `${recipient}|${zinvite}`;
  if (Date.now() - (recentAuthors[k] || 0) < 15 * 60000) {
    delete recentAuthors[k];
    return 0; // their own statement — no accumulation either
  }
  if (!notifyAllowed(recipient, zinvite)) {
    pendingCounts[k] = (pendingCounts[k] || 0) + newCount;
    return 0;
  }
  const total = newCount + (pendingCounts[k] || 0);
  delete pendingCounts[k];
  return total;
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      waData = {
        userState: data.userState || {},
        pendingNotifications: data.pendingNotifications || [],
        waTopicGroups: data.waTopicGroups || {},
      };
      conversationCommentCounts = data.conversationCommentCounts || {};
      communityTopics = data.communityTopics || {};
      webAccounts = data.webAccounts || {};
      topicSlugs = data.topicSlugs || {};
      pendingVerifications = data.pendingVerifications || {};
      notifyCooldown = data.notifyCooldown || {};
      knownActiveTopics = data.knownActiveTopics || {};
      pendingCounts = data.pendingCounts || {};
      recentAuthors = data.recentAuthors || {};
      nudgeLog = data.nudgeLog || {};
      deviceCodes = data.deviceCodes || {};
      for (const acct of Object.values(webAccounts)) {
        // Accounts created before contact verification existed: grandfathered.
        if (acct.verified === undefined) acct.verified = true;
        // Migrate single-channel accounts to the dual-contact shape.
        if (acct.email === undefined) {
          acct.email = acct.channel === 'email' ? acct.contact : null;
          acct.whatsapp = acct.channel === 'whatsapp' ? acct.contact : null;
          acct.emailVerified = !!acct.email && acct.verified !== false;
          acct.whatsappVerified = !!acct.whatsapp && acct.verified !== false;
        }
      }
      console.log(`Loaded state for ${Object.keys(webAccounts).length} accounts`);
    }
  } catch (e) {
    console.error('Failed to load state:', e.message);
    // Preserve the unreadable file — the next saveState() would otherwise
    // clobber it and make the loss permanent.
    try {
      const bak = `${STATE_FILE}.corrupt-${Date.now()}`;
      fs.copyFileSync(STATE_FILE, bak);
      console.error(`Corrupt state backed up to ${bak}`);
    } catch {}
  }
}

function saveState() {
  try {
    const json = JSON.stringify({
      userState: waData.userState,
      conversationCommentCounts,
      pendingNotifications: waData.pendingNotifications,
      communityTopics,
      webAccounts,
      topicSlugs,
      pendingVerifications,
      waTopicGroups: waData.waTopicGroups,
      notifyCooldown,
      knownActiveTopics,
      pendingCounts,
      recentAuthors,
      nudgeLog,
      deviceCodes,
    }, null, 2);
    // Atomic replace — a crash mid-write must never corrupt the state file.
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

// Expire stale verifications (links: 30 min; verified claims linger a further
// 30 min so the originating browser can still collect them).
function pruneVerifications() {
  const now = Date.now();
  let changed = false;
  for (const [id, p] of Object.entries(pendingVerifications)) {
    const ttl = p.verified ? 60 * 60000 : 30 * 60000;
    if (now - p.created > ttl) { delete pendingVerifications[id]; changed = true; }
  }
  for (const [k, ts] of Object.entries(notifyCooldown)) {
    if (now - ts > 24 * 3600000) { delete notifyCooldown[k]; changed = true; }
  }
  for (const [k, ts] of Object.entries(recentAuthors)) {
    if (now - ts > 3600000) { delete recentAuthors[k]; changed = true; }
  }
  for (const [k, ts] of Object.entries(nudgeLog)) {
    if (now - ts > 30 * 24 * 3600000) { delete nudgeLog[k]; changed = true; }
  }
  for (const [code, c] of Object.entries(deviceCodes)) {
    if (now - c.created > DEVICE_CODE_TTL) { delete deviceCodes[code]; changed = true; }
  }
  if (changed) saveState();
}
setInterval(pruneVerifications, 5 * 60000);

loadState();

// --- JWT creation (admin) ---

function createAdminJWT() {
  const privateKey = fs.readFileSync(KEY_PATH, 'utf-8');
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    sub: 'user:admin-bot',
    oidc_sub: 'admin-bot',
    uid: ADMIN_UID,
    pid: 0,
    conversation_id: '',
    standard_user_participant: true,
    aud: 'participants',
    // Internal contract with the Polis engine (POLIS_JWT_ISSUER) — NOT the
    // public URL. Kept stable across domain changes so existing participant
    // tokens (all issued with this) stay valid.
    iss: JWT_ISS,
    exp: Math.floor(Date.now() / 1000) + 86400 * 365,
    iat: Math.floor(Date.now() / 1000),
  };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = b64(header) + '.' + b64(payload);
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  return unsigned + '.' + signature;
}

let adminToken;
try {
  adminToken = createAdminJWT();
  console.log('Admin JWT created successfully');
} catch (err) {
  console.error('Failed to create admin JWT:', err.message);
  process.exit(1);
}

// --- HTTP helpers ---

function polisRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, POLIS_URL);
    const secure = url.protocol === 'https:';
    const options = {
      method,
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        // Polis builds cookies/links from Host and redirects requests it
        // doesn't consider secure; present the public hostname and proto
        // even when calling over the local port.
        'Host': new URL(PUBLIC_URL).host,
        'X-Forwarded-Proto': 'https',
      },
    };
    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }
    if (body) {
      const data = JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }

    const req = (secure ? https : http).request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, data: data, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

// Read a Mailgun route-forward POST (multipart/form-data or urlencoded)
// into a plain {field: value} object. Text fields only; attachments and
// anything past the size cap are ignored.
function readMailgunBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= 2 * 1024 * 1024) chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const ctype = String(req.headers['content-type'] || '');
      const fields = {};
      try {
        if (ctype.includes('application/x-www-form-urlencoded')) {
          for (const [k, v] of new URLSearchParams(raw.toString('utf8'))) fields[k] = v;
        } else if (ctype.includes('multipart/form-data')) {
          const bm = ctype.match(/boundary="?([^";]+)"?/);
          if (bm) {
            const parts = raw.toString('binary').split('--' + bm[1]);
            for (const part of parts) {
              const nm = part.match(/name="([^"]+)"/);
              if (!nm || /filename="/.test(part.slice(0, part.indexOf('\r\n\r\n') + 4))) continue;
              const idx = part.indexOf('\r\n\r\n');
              if (idx === -1) continue;
              let val = part.slice(idx + 4);
              if (val.endsWith('\r\n')) val = val.slice(0, -2);
              fields[nm[1]] = Buffer.from(val, 'binary').toString('utf8');
            }
          }
        }
      } catch (e) {
        console.error('mailgun body parse error:', e.message);
      }
      resolve(fields);
    });
  });
}

// --- Polis XID helpers ---

// Initialize a participant for a conversation by XID.
// Returns { token, pid, nextComment, conversation, votes }
async function initByXid(xid, zinvite) {
  const result = await polisRequest(
    'GET',
    `/api/v3/participationInit?conversation_id=${zinvite}&xid=${encodeURIComponent(xid)}`,
    null,
    null // No auth — Polis creates anon user for XID
  );

  if (result.status !== 200) {
    throw new Error(`participationInit failed: ${result.status}`);
  }

  const d = result.data;
  return {
    token: d.auth?.token,
    pid: d.ptpt?.pid,
    nextComment: d.nextComment,
    conversation: d.conversation,
    votes: d.votes || [],
  };
}

// Vote on a statement
async function vote(token, zinvite, tid, voteValue) {
  const result = await polisRequest('POST', '/api/v3/votes', {
    conversation_id: zinvite,
    tid: tid,
    vote: voteValue, // Polis convention: -1=agree, 0=pass, 1=disagree
  }, token);

  if (result.status !== 200) {
    throw new Error(`Vote failed: ${result.status}`);
  }
  return result.data;
}

// List a conversation's statements (participant-visible)
async function getComments(token, zinvite) {
  const result = await polisRequest(
    'GET',
    `/api/v3/comments?conversation_id=${encodeURIComponent(zinvite)}`,
    null,
    token
  );
  if (result.status !== 200 || !Array.isArray(result.data)) return [];
  return result.data;
}

// Submit a new statement
async function submitComment(token, zinvite, text) {
  const result = await polisRequest('POST', '/api/v3/comments', {
    conversation_id: zinvite,
    txt: text,
  }, token);

  if (result.status !== 200) {
    throw new Error(`Comment failed: ${result.status}`);
  }
  return result.data;
}

// --- Human-readable topic URLs ---

function slugify(topic) {
  return String(topic).toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-').slice(0, 8).join('-')  // keep slugs reasonably short
    .slice(0, 60).replace(/-+$/, '') || 'topic';
}

// Return the canonical slug for a conversation, creating one if needed.
function ensureSlug(zinvite, topic) {
  for (const [slug, z] of Object.entries(topicSlugs)) {
    if (z === zinvite) return slug;
  }
  let base = slugify(topic);
  if (/^[0-9][0-9a-z]*$/.test(base)) base += '-topic';
  let slug = base, n = 2;
  while (topicSlugs[slug]) slug = `${base}-${n++}`;
  topicSlugs[slug] = zinvite;
  saveState();
  return slug;
}

function topicUrl(zinvite, topic) {
  return topic ? `${PUBLIC_URL}/${ensureSlug(zinvite, topic)}` : `${PUBLIC_URL}/${zinvite}`;
}

// Get active conversations list
async function getActiveConversations() {
  const result = await polisRequest(
    'GET',
    '/api/v3/conversations?include_all_conversations_i_am_in=true',
    null,
    adminToken
  );
  if (result.status === 200 && Array.isArray(result.data)) {
    return result.data
      // Hide test conversations and the junk ones titled with raw HTTP dates
      // ("Wed, 22 Apr 2026 03:48:48 GMT") from an old bug.
      .filter(c => c.is_active && c.topic && c.conversation_id
        && !/^test/i.test(c.topic.trim())
        && !/^(mon|tue|wed|thu|fri|sat|sun),\s/i.test(c.topic.trim()))
      .map(c => ({
        zinvite: c.conversation_id,
        topic: c.topic,
        description: c.description,
        participant_count: c.participant_count || 0,
        created: Number(c.created) || 0,
        url: topicUrl(c.conversation_id, c.topic),
        slug: ensureSlug(c.conversation_id, c.topic),
      }));
  }
  return [];
}

// --- Public web hub (internet-facing via nginx "location /public/") ---
// Everything else on this port stays loopback-only. The public surface is
// deliberately tiny: list topics, create a topic, close YOUR OWN topic (via
// the creatorKey handed out at creation). Moderation/removal of anything else
// stays in the admin console behind Auth0.

const PUBLIC_LIMITS = { perIpPerHour: 3, perDay: 20 };
const publicCreateLog = []; // { ts, ip }

// IP privacy: we never store raw client addresses. Each IP is reduced to a
// truncated HMAC-SHA256 with a random persistent salt (generated once, kept
// next to the state file) — enough to rate-limit repeat traffic, useless for
// identifying anyone.
const IP_SALT_FILE = process.env.IP_SALT_FILE || path.join(path.dirname(STATE_FILE), 'ip-salt');
let ipSalt;
try {
  ipSalt = fs.readFileSync(IP_SALT_FILE, 'utf-8').trim();
  if (!ipSalt) throw new Error('empty');
} catch {
  ipSalt = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(IP_SALT_FILE, ipSalt, { mode: 0o600 });
}

function hashIp(ip) {
  return crypto.createHmac('sha256', ipSalt).update(String(ip)).digest('hex').slice(0, 16);
}

function clientIp(req) {
  // We only listen on loopback; nginx sets X-Forwarded-For to the real client.
  const xff = req.headers['x-forwarded-for'];
  return hashIp(xff ? xff.split(',')[0].trim() : req.socket.remoteAddress);
}

function publicCreateBlocked(ip) {
  const now = Date.now();
  while (publicCreateLog.length && now - publicCreateLog[0].ts > 86400000) {
    publicCreateLog.shift();
  }
  if (publicCreateLog.length >= PUBLIC_LIMITS.perDay) {
    return 'The community has hit today’s new-topic limit. Please try again tomorrow.';
  }
  const fromIp = publicCreateLog.filter(e => e.ip === ip && now - e.ts < 3600000).length;
  if (fromIp >= PUBLIC_LIMITS.perIpPerHour) {
    return 'You’ve created several topics recently — please wait an hour before adding another.';
  }
  return null;
}

// Strip control characters; single-line variant collapses whitespace.
function cleanText(s, max, singleLine) {
  let out = String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  if (singleLine) out = out.replace(/\s+/g, ' ');
  return out.trim().slice(0, max).trim();
}

// --- Notifications: email (Mailgun) + WhatsApp (wireclaw DM pipeline) ---

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY || '';
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || '';
const EMAIL_FROM = process.env.EMAIL_FROM
  || (MAILGUN_DOMAIN ? `Croton Community Forum <forum@${MAILGUN_DOMAIN}>` : '');

// --- HTML email templates ---
// Bulletproof-ish: one centered table, inline styles only, system fonts,
// warm palette matching the site. Every mail keeps a plain-text fallback.
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function emailButton(label, url, style) {
  const solid = style !== 'outline';
  return `<a href="${url}" style="display:inline-block;margin:4px 6px 4px 0;padding:11px 20px;border-radius:9px;font-weight:600;font-size:14px;text-decoration:none;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;${solid ? 'background:#3b6b4a;color:#ffffff;' : 'background:#ffffff;color:#3b6b4a;border:1.5px solid #3b6b4a;'}">${label}</a>`;
}

function emailQuote(text) {
  return `<div style="margin:10px 0;padding:12px 16px;background:#f4f2ec;border-left:3px solid #3b6b4a;border-radius:0 10px 10px 0;font-size:15px;line-height:1.5;color:#3a3a3a;">&ldquo;${escHtml(text)}&rdquo;</div>`;
}

function emailShell(heading, bodyHtml, footerHtml) {
  return `<!doctype html><html><body style="margin:0;padding:0;background-color:#f2efe8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f2efe8;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="padding:0 8px 14px;font-family:Georgia,'Times New Roman',serif;font-size:19px;color:#2d5439;">Croton <i>Community Forum</i></td></tr>
<tr><td style="background:#ffffff;border-radius:16px;padding:26px 28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a2e;box-shadow:0 1px 4px rgba(26,26,46,0.08);">
${heading ? `<h1 style="margin:0 0 12px;font-size:19px;line-height:1.35;font-weight:700;">${heading}</h1>` : ''}
${bodyHtml}
</td></tr>
<tr><td style="padding:16px 8px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.7;color:#8a887f;">
${footerHtml || ''}
<a href="${PUBLIC_URL}" style="color:#3b6b4a;text-decoration:none;">${PUBLIC_URL.replace(/^https?:\/\//, '')}</a> &middot; Voting stays private.
</td></tr>
</table></td></tr></table></body></html>`;
}

function emailFooterUnsub(accountId, zinvite) {
  return `<a href="${unsubscribeLink(accountId, zinvite)}" style="color:#8a887f;">Unsubscribe from this topic</a> &middot; <a href="${unsubscribeLink(accountId, null)}" style="color:#8a887f;">Unsubscribe from everything</a><br>`;
}

function sendEmail(to, subject, text, unsubUrl, replyTo, html) {
  return new Promise((resolve) => {
    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      console.error('Email not configured (MAILGUN_API_KEY/MAILGUN_DOMAIN missing)');
      return resolve(false);
    }
    const fields = { from: EMAIL_FROM, to, subject, text };
    if (html) fields.html = html;
    if (replyTo) fields['h:Reply-To'] = replyTo;
    if (unsubUrl) {
      // RFC 8058 one-click unsubscribe — a strong deliverability signal
      fields['h:List-Unsubscribe'] = `<${unsubUrl}>`;
      fields['h:List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    const form = new URLSearchParams(fields).toString();
    const req = https.request({
      method: 'POST',
      hostname: 'api.mailgun.net',
      path: `/v3/${MAILGUN_DOMAIN}/messages`,
      auth: `api:${MAILGUN_API_KEY}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(form),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) console.error(`Mailgun ${res.statusCode}: ${data.slice(0, 200)}`);
        resolve(res.statusCode === 200);
      });
    });
    req.on('error', (e) => { console.error('Mailgun error:', e.message); resolve(false); });
    req.write(form);
    req.end();
  });
}

function accountsFollowing(zinvite) {
  return Object.entries(webAccounts)
    .filter(([, a]) => a.verified !== false && (a.subs || []).includes(zinvite));
}

// Contact helpers: an account may carry an email and a WhatsApp number; each
// is usable only once verified via its own clickthrough link, and WhatsApp
// only while the bridge is on.
function acctEmail(a) { return a.emailVerified && a.email ? a.email : null; }
function acctWhatsapp(a) { return wa && a.whatsappVerified && a.whatsapp ? a.whatsapp : null; }

// The legacy primary-channel fields (channel, contact) older code and older
// browsers still read.
function settleChannel(a) {
  if (a.whatsappVerified && !a.emailVerified) a.channel = 'whatsapp';
  else if (a.email) a.channel = 'email';
  else if (a.whatsapp) a.channel = 'whatsapp';
  else a.channel = (a.devices || []).length ? 'push' : 'email';
  a.contact = a.channel === 'email' ? a.email : a.channel === 'whatsapp' ? a.whatsapp : null;
}

function findAccountByContact(channel, contact) {
  return Object.keys(webAccounts).find(id => {
    const a = webAccounts[id];
    return channel === 'email' ? a.email === contact : a.whatsapp === contact;
  }) || null;
}

// Two contacts resolving to two different accounts merge into the older one:
// subs union, real xid preferred, both channels retained. Nothing is deleted
// from Polis — only the duplicate account record retires.
function mergeAccounts(keepId, dropId) {
  const keep = webAccounts[keepId], drop = webAccounts[dropId];
  if (!keep || !drop || keepId === dropId) return;
  keep.subs = [...new Set([...(keep.subs || []), ...(drop.subs || [])])];
  keep.allTopics = !!(keep.allTopics || drop.allTopics);
  if (!keep.email && drop.email) { keep.email = drop.email; keep.emailVerified = !!drop.emailVerified; }
  if (!keep.whatsapp && drop.whatsapp) { keep.whatsapp = drop.whatsapp; keep.whatsappVerified = !!drop.whatsappVerified; }
  if ((!keep.xid || isSyntheticXid(keep.xid)) && drop.xid && !isSyntheticXid(drop.xid)) {
    setAccountXid(keepId, drop.xid, 'merge');
  }
  if (!keep.name && drop.name) keep.name = drop.name;
  // Devices come along (newest kept when over the limit).
  const devices = [...(keep.devices || [])];
  for (const d of drop.devices || []) if (!devices.some(k => k.endpoint === d.endpoint)) devices.push(d);
  keep.devices = devices.slice(-MAX_DEVICES);
  settleChannel(keep);
  console.log(`Accounts merged: ${dropId} -> ${keepId}`);
  delete webAccounts[dropId];
  saveState();
}

function unsubscribeLink(accountId, zinvite) {
  return `${PUBLIC_URL}/public/unsubscribe?account=${accountId}${zinvite ? `&z=${zinvite}` : '&all=1'}`;
}

// Complete verification of ONE contact of a pending signup: find, create, or
// merge the account, record both contacts (each verified only by its own
// link), apply profile fields, migrate follows from the browser's previous
// account, and settle the canonical voting identity.
// The signed-in account only counts as "the same person" when the signup
// shares one of its contacts, or it was never verified at all. A verified
// account with entirely different contacts means a borrowed/shared browser —
// merging or migrating across that boundary mixes two people (it happened).
function prevAccountIsSamePerson(prevId, contacts) {
  const prev = prevId && webAccounts[prevId];
  if (!prev) return false;
  if (!prev.emailVerified && !prev.whatsappVerified && prev.verified === false) return true;
  const hasVerified = prev.emailVerified || prev.whatsappVerified;
  if (!hasVerified) return true;
  return contacts.some(c =>
    (c.channel === 'email' && prev.email === c.contact) ||
    (c.channel === 'whatsapp' && prev.whatsapp === c.contact));
}

// Attach one newly-confirmed contact to an EXISTING signed-in account.
// Contacts already owned by a different account never attach (that would
// graft one person's channel onto another's account).
function finalizeTargetedContact(p, entry) {
  let targetId = p.targetAccountId;
  let target = webAccounts[targetId];
  if (!target) { p.verified = true; p.grantAccount = false; saveState(); return null; }
  const owner = findAccountByContact(entry.channel, entry.contact);
  if (owner && owner !== targetId) {
    // The link's wording names the target account and the tapper owns this
    // contact — the tap is informed consent to bring their account along.
    // An account that is only devices (notifications, no confirmed contact)
    // is usually minutes old: it folds into the contact's account, which
    // carries the history, and the signing-up browser is handed that one.
    if (!target.emailVerified && !target.whatsappVerified) {
      mergeAccounts(owner, targetId);
      targetId = owner;
      target = webAccounts[owner];
    } else {
      mergeAccounts(targetId, owner);
    }
  }
  if (entry.channel === 'email') {
    target.email = entry.contact;
    target.emailVerified = true;
  } else {
    target.whatsapp = entry.contact;
    target.whatsappVerified = true;
    if (!target.xid) setAccountXid(targetId, entry.contact, 'anchor-phone');
    if (wa && !target.welcomed) {
      target.welcomed = true;
      wa.welcome(entry.contact);
    }
  }
  target.verified = true;
  settleChannel(target);
  p.verified = true;
  p.accountId = targetId;
  p.grantAccount = true;
  saveState();
  return targetId;
}

function finalizeContact(p, entry) {
  // PROOF-BASED RESOLUTION. A tap proves exactly one thing: the tapper owns
  // THIS contact. So the tapped contact drives everything; the other contact
  // in the signup waits for its own tap; and accounts merge only when each
  // side has been proven (two taps in one signup, or a same-person match).
  const samePerson = prevAccountIsSamePerson(p.previousAccountId, p.contacts);
  const entryOwner = findAccountByContact(entry.channel, entry.contact);

  let accountId = (p.accountId && webAccounts[p.accountId]) ? p.accountId : null;
  if (accountId && entryOwner && entryOwner !== accountId) {
    // Second tap of this signup proved a contact living on another account —
    // both halves proven by their owners, merge is legitimate.
    mergeAccounts(accountId, entryOwner);
  } else if (!accountId) {
    accountId = entryOwner;
  }
  if (!accountId && samePerson) accountId = p.previousAccountId;
  let createdNew = !!p.createdNew;
  if (!accountId) {
    accountId = crypto.randomBytes(16).toString('base64url');
    createdNew = true;
    p.createdNew = true;
    webAccounts[accountId] = {
      name: p.name, subs: [], allTopics: !!p.allTopics,
      email: null, whatsapp: null, emailVerified: false, whatsappVerified: false,
      created: new Date().toISOString(),
    };
  } else if (samePerson && p.previousAccountId && p.previousAccountId !== accountId && webAccounts[p.previousAccountId]) {
    mergeAccounts(accountId, p.previousAccountId);
  }
  // Magic-link semantics: the initiating browser receives the account only
  // when this signup created it, or the browser was already provably this
  // person. Everyone else signs in on the device that taps (cookie / /me).
  p.grantAccount = createdNew || samePerson;
  const acct = webAccounts[accountId];

  if (p.name) acct.name = p.name;
  if (p.allTopics !== undefined) acct.allTopics = !!p.allTopics;
  // Attach ONLY the proven contact — never pre-record the other one.
  if (entry.channel === 'email' && (!acct.email || acct.email === entry.contact)) {
    acct.email = entry.contact;
    acct.emailVerified = true;
  }
  if (entry.channel === 'whatsapp' && (!acct.whatsapp || acct.whatsapp === entry.contact)) {
    acct.whatsapp = entry.contact;
    acct.whatsappVerified = true;
  }
  acct.verified = true;
  settleChannel(acct);

  // Canonical voting identity: a verified WhatsApp number anchors it (keeps
  // DM vote history); otherwise the browser xid from signup. A real browser
  // xid also rescues an account stuck on a synthetic identity.
  if (!acct.xid && acct.whatsappVerified) {
    setAccountXid(accountId, acct.whatsapp, 'verify-anchor-phone');
  } else if (p.xid && (!acct.xid || isSyntheticXid(acct.xid))) {
    setAccountXid(accountId, p.xid, 'verify-browser-xid');
  }

  const prev = p.previousAccountId && webAccounts[p.previousAccountId];
  if (prev && p.previousAccountId !== accountId && samePerson) {
    acct.subs = [...new Set([...(acct.subs || []), ...(prev.subs || [])])];
    if (prev.allTopics && p.allTopics === undefined) acct.allTopics = true;
    prev.subs = [];
    prev.allTopics = false;
  }
  p.verified = true;
  p.accountId = accountId;
  // First verified WhatsApp contact gets the onboarding DM.
  if (wa && acct.whatsappVerified && !acct.welcomed) {
    acct.welcomed = true;
    wa.welcome(acct.whatsapp);
  }
  saveState();
  return accountId;
}

function accountPayload(accountId) {
  const a = webAccounts[accountId];
  return {
    accountId, name: a.name, channel: a.channel, contact: a.contact,
    email: a.email || null, whatsapp: a.whatsapp || null,
    emailVerified: !!a.emailVerified, whatsappVerified: !!a.whatsappVerified,
    allTopics: !!a.allTopics, subs: a.subs || [], verified: a.verified !== false,
    xid: a.xid || null,
    devices: (a.devices || []).map(d => ({ id: d.id, platform: d.platform, created: d.created })),
  };
}

// HttpOnly cookie binding the verified account to the browser. Path-scoped to
// /public (the only surface that uses it); the accountId in the request body
// remains the primary credential for API calls.
function acctCookie(accountId) {
  return `forum_acct=${accountId}; Path=/public; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
}

// --- One-click voting from email ---
// Links carry an HMAC so only we can mint them; the vote itself is recorded
// by a scripted POST from the landing page, so inbox link-scanners that
// prefetch GETs can never cast a vote.
const LINK_SECRET_FILE = process.env.LINK_SECRET_FILE || path.join(path.dirname(STATE_FILE), 'link-secret');
let LINK_SECRET = '';
try {
  LINK_SECRET = fs.readFileSync(LINK_SECRET_FILE, 'utf-8').trim();
} catch {
  LINK_SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(LINK_SECRET_FILE, LINK_SECRET, { mode: 0o600 });
}

function voteSig(accountId, zinvite, tid, v) {
  return crypto.createHmac('sha256', LINK_SECRET)
    .update(`${accountId}|${zinvite}|${tid}|${v}`)
    .digest('hex').slice(0, 32);
}

function voteLink(accountId, zinvite, tid, v) {
  return `${PUBLIC_URL}/public/email-vote?account=${encodeURIComponent(accountId)}&z=${encodeURIComponent(zinvite)}&tid=${tid}&v=${v}&sig=${voteSig(accountId, zinvite, tid, v)}`;
}

const EMAIL_VOTE_VALUES = { a: -1, d: 1, p: 0 };

// --- Vote by email reply ---
// Outgoing topic emails carry Reply-To: vote+<account>.<zinvite>.<sig>@domain;
// a Mailgun route forwards replies to /public/email-reply, where "agree" /
// "a d p" sequences become votes on the next unvoted statements in order.
function replySig(accountId, zinvite) {
  return crypto.createHmac('sha256', LINK_SECRET)
    .update(`reply|${accountId}|${zinvite}`)
    .digest('hex').slice(0, 16);
}

function voteReplyAddress(accountId, zinvite) {
  return `vote+${accountId}.${zinvite}.${replySig(accountId, zinvite)}@${MAILGUN_DOMAIN}`;
}

const REPLY_VOTE_WORDS = {
  agree: -1, a: -1, yes: -1, y: -1, '👍': -1,
  disagree: 1, d: 1, no: 1, n: 1, '👎': 1,
  pass: 0, p: 0, skip: 0, s: 0,
};

// Rate limiting for reply processing (account -> timestamps) and help replies
const emailReplyLog = {};
const helpReplyLog = {};

// The account's voting identity. DURABILITY RULE: identities are only ever
// minted at an explicit user action, never by background jobs — a synthetic
// identity handed to a browser that already has vote history makes that
// history invisible (it isn't lost, but it looks lost, which is as bad).
function accountXid(accountId) {
  const acct = webAccounts[accountId];
  if (!acct) return null;
  if (!acct.xid && acct.channel === 'whatsapp') {
    setAccountXid(accountId, acct.contact, 'anchor-phone');
  }
  return acct.xid || null;
}

// Every xid change is audited on the account (xidHistory) and logged.
function setAccountXid(accountId, xid, reason) {
  const acct = webAccounts[accountId];
  if (!acct || acct.xid === xid) return;
  acct.xidHistory = (acct.xidHistory || []).concat(acct.xid || null).slice(-5);
  acct.xid = xid;
  console.log(`xid change [${reason}] account=${accountId} -> ${xid}`);
  saveState();
}

function isSyntheticXid(xid) {
  return typeof xid === 'string' && xid.startsWith('email:');
}

// Shared branded shell for server-rendered pages (confirmations, email
// voting). Matches the landing page: same self-hosted fonts, palette, card
// treatment, and gentle motion (with reduced-motion opt-out).
function pageShell(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — ${BRAND_NAME}</title>
<link href="/fonts/fonts.css" rel="stylesheet">
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--green:#3b6b4a;--green-dark:#2d5439;--green-soft:rgba(76,132,96,0.12);--ink:#1a1a2e;--muted:#666;--faint:#999}
body{font-family:"Inter",system-ui,sans-serif;color:var(--ink);min-height:100vh;
  background:linear-gradient(135deg,#f8f6f0 0%,#e8e4da 50%,#d4e4d9 100%);background-attachment:fixed;
  display:flex;align-items:flex-start;justify-content:center;padding:10vh 1.1rem 4rem}
.card{background:rgba(255,255,255,0.82);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.9);
  border-radius:18px;padding:2rem 1.8rem;max-width:28rem;width:100%;box-shadow:0 10px 40px rgba(26,26,46,0.1);
  text-align:center;animation:rise .35s cubic-bezier(.22,1,.36,1) both}
.brand{font-family:"DM Serif Display",serif;font-size:1.05rem;color:var(--green-dark);margin-bottom:1.3rem}
.icon{font-size:2.6rem;line-height:1;margin-bottom:0.8rem;display:inline-block;animation:pop .5s cubic-bezier(.22,1,.36,1) .1s both}
h1{font-family:"DM Serif Display",serif;font-weight:400;font-size:1.55rem;margin-bottom:0.6rem}
p{font-size:0.95rem;line-height:1.65;color:#444}
blockquote{margin:0.9rem 0;padding:0.7rem 0.95rem;background:#f4f2ec;border-radius:10px;font-size:0.92rem;line-height:1.55;color:#3a3a3a;text-align:left}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:0.6rem 1.2rem;border-radius:10px;
  font-size:0.92rem;font-weight:600;font-family:inherit;cursor:pointer;border:1.5px solid var(--green);
  background:#fff;color:var(--green);margin:0.25rem 0.25rem 0 0;text-decoration:none;
  transition:transform .18s cubic-bezier(.22,1,.36,1),box-shadow .18s ease,background-color .18s ease,color .18s ease}
.btn:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(59,107,74,0.22)}
.btn:active{transform:scale(.96)}
.btn.primary{background:var(--green);color:#fff}
.home{display:inline-block;margin-top:1.5rem;color:var(--green);font-weight:600;font-size:0.88rem;text-decoration:none}
.home:hover{text-decoration:underline;text-underline-offset:3px}
.note{font-size:0.8rem;color:var(--faint);margin-top:1rem}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes pop{0%{opacity:0;transform:scale(.4)}62%{transform:scale(1.12)}100%{opacity:1;transform:scale(1)}}
@media (prefers-reduced-motion:reduce){*{animation-duration:.001s!important;transition-duration:.001s!important}}
</style></head><body><div class="card">
<div class="brand">${BRAND_NAME}</div>
${bodyHtml}
<a class="home" href="${PUBLIC_URL}">Back to the forum &rarr;</a>
</div></body></html>`;
}

function verifyPage(title, msg, icon) {
  return pageShell(title,
    `<div class="icon">${icon || '📨'}</div><h1>${title}</h1><p>${msg}</p>`);
}

// --- Notifications on the phone (Web Push, server/push.js) ---
// A device is one browser's push subscription on an account:
// { id, endpoint, p256dh, auth, platform, created }. The subscription itself
// proves the device — only that browser and its push service ever hold it —
// so adding one needs no confirmation link. Devices leave when the browser
// says so (sign-out, "turn off") or the push service answers 404/410.
const pusher = push.createPush({
  keyFile: process.env.POLIS_VAPID_FILE || path.join(path.dirname(STATE_FILE), 'vapid.json'),
  subject: process.env.POLIS_VAPID_SUBJECT || PUBLIC_URL,
  outbox: process.env.POLIS_PUSH_TEST_OUTBOX || '',
});
const MAX_DEVICES = 10;                      // per account; the oldest goes first

const deviceIdOf = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('base64url').slice(0, 12);

function findDevice(endpoint) {
  for (const [accountId, a] of Object.entries(webAccounts)) {
    if ((a.devices || []).some(d => d.endpoint === endpoint)) return accountId;
  }
  return null;
}

function dropDevice(accountId, test) {
  const a = webAccounts[accountId];
  if (!a || !a.devices) return false;
  const before = a.devices.length;
  a.devices = a.devices.filter(d => !test(d));
  settleChannel(a);
  return a.devices.length !== before;
}

// Send one notification to every device on an account. Never throws; a device
// whose push service says it is gone is removed. Returns how many took it.
async function pushToAccount(accountId, acct, message) {
  const devices = ((acct && acct.devices) || []).slice(); // /public/push may change the live list mid-send
  if (!devices.length) return 0;
  const results = await pusher.fanout(devices, message);
  const gone = new Set();
  results.forEach((r, i) => {
    if (r.gone) gone.add(devices[i].endpoint);
    else if (!r.ok) console.error(`push: account ${accountId} device ${devices[i].id} → ${r.status} ${r.detail || ''}`);
  });
  if (gone.size) {
    dropDevice(accountId, d => gone.has(d.endpoint));
    console.log(`push: account ${accountId}: ${gone.size} device(s) gone, removed`);
    saveState();
  }
  return results.filter(r => r.ok).length;
}

// Fan a statement alert out to a topic's followers.
// makeMessage/makeSubject receive the recipient's effective count (new +
// anything accumulated during their cooldown); statements get one-click
// email vote links. skipPhones: already notified via legacy subscription.
async function notifyGroup(zinvite, topic, makeMessage, skipPhones, makeSubject, statements, newCount) {
  const skip = new Set(skipPhones || []);
  for (const [accountId, acct] of accountsFollowing(zinvite)) {
    const phone = acctWhatsapp(acct);
    const em = acctEmail(acct);
    if (phone && !skip.has(phone)) {
      skip.add(phone);
      const n = notifyCount(phone, zinvite, newCount);
      if (n) wa.alert(phone, zinvite, topic, `${makeMessage(n)}\n\nReply *vote* to vote now, or *unsubscribe* to stop updates.`);
    }
    if ((acct.devices || []).length) {
      const n = notifyCount(`push:${accountId}`, zinvite, newCount);
      if (n) {
        const first = (statements || [])[0];
        await pushToAccount(accountId, acct, {
          title: topic,
          body: `${n} new statement${n > 1 ? 's' : ''} to vote on${first ? `\n“${first.txt}”` : ''}`,
          url: topicUrl(zinvite, topic),
          tag: `t-${zinvite}`,
        });
      }
    }
    if (em) {
      const n = notifyCount(em, zinvite, newCount);
      if (!n) continue;
      const message = makeMessage(n);
      const subject = makeSubject(n);
      let voteBlocks = '';
      let voteBlocksHtml = '';
      for (const s of statements || []) {
        voteBlocks +=
          `\n"${s.txt}"\n` +
          `  Agree:    ${voteLink(accountId, zinvite, s.tid, 'a')}\n` +
          `  Disagree: ${voteLink(accountId, zinvite, s.tid, 'd')}\n` +
          `  Pass:     ${voteLink(accountId, zinvite, s.tid, 'p')}\n`;
        voteBlocksHtml +=
          emailQuote(s.txt) +
          `<div style="margin:2px 0 18px;">` +
          emailButton('👍 Agree', voteLink(accountId, zinvite, s.tid, 'a')) +
          emailButton('👎 Disagree', voteLink(accountId, zinvite, s.tid, 'd'), 'outline') +
          emailButton('Pass', voteLink(accountId, zinvite, s.tid, 'p'), 'outline') +
          `</div>`;
      }
      const htmlBody =
        (voteBlocksHtml
          ? voteBlocksHtml +
            `<p style="margin:4px 0 16px;font-size:13px;color:#666;">One tap records that vote and walks you through the rest — no sign-in needed. Or simply <b>reply to this email</b> with <b>agree</b>, <b>disagree</b>, or <b>pass</b> (one word per statement, e.g. &ldquo;a&nbsp;d&nbsp;p&rdquo;).</p>`
          : `<p style="margin:4px 0 16px;font-size:14px;color:#444;">Reply to this email with <b>agree</b> / <b>disagree</b> / <b>pass</b> to vote, or open the topic:</p>`) +
        emailButton('See the topic & live results →', topicUrl(zinvite, topic), 'outline');
      await sendEmail(
        em,
        subject || `${topic} — Croton Community Forum`,
        `${message.replace(/\*/g, '')}\n${voteBlocks ? `${voteBlocks}\nClicking a link records that one vote and then walks you through any others — no sign-in needed.\n` : ''}\n✉️ Or just REPLY to this email to vote: one word per statement, in order — e.g. "agree disagree pass" or simply "a d p".\n\nVote on the site: ${topicUrl(zinvite, topic)}\n\n—\nCroton Community Forum · ${PUBLIC_URL}\nUnsubscribe from this topic: ${unsubscribeLink(accountId, zinvite)}\nUnsubscribe from everything: ${unsubscribeLink(accountId, null)}`,
        unsubscribeLink(accountId, zinvite),
        voteReplyAddress(accountId, zinvite),
        emailShell(escHtml(message.replace(/\*/g, '')), htmlBody, emailFooterUnsub(accountId, zinvite))
      );
    }
  }
}

// Build a plain-text results digest for a topic: strongest consensus and the
// most divisive statements, by actual vote tallies.
async function buildTopicDigest(zinvite, topic) {
  let comments = [];
  try {
    const result = await polisRequest(
      'GET',
      `/api/v3/comments?conversation_id=${encodeURIComponent(zinvite)}&include_voting_patterns=true`,
      null,
      adminToken
    );
    if (result.status === 200 && Array.isArray(result.data)) comments = result.data;
  } catch {}
  const scored = comments
    .map(c => {
      const total = c.count || 0;
      const ag = c.agree_count || 0;
      return { txt: c.txt, total, pct: total ? ag / total : 0 };
    })
    .filter(c => c.total >= 3);
  if (!scored.length) return `Results for "${topic}": not enough votes for a summary yet.`;
  const consensus = [...scored].sort((a, b) => b.pct - a.pct || b.total - a.total).slice(0, 3);
  const divisive = [...scored].sort((a, b) =>
    Math.abs(a.pct - 0.5) - Math.abs(b.pct - 0.5) || b.total - a.total)[0];
  let out = `📊 *Results: ${topic}*\n\n*Strongest agreement:*\n`;
  for (const c of consensus) {
    out += `• ${Math.round(c.pct * 100)}% agree (${c.total} votes) — "${c.txt}"\n`;
  }
  if (divisive && !consensus.includes(divisive)) {
    out += `\n*Most divided:*\n• ${Math.round(divisive.pct * 100)}% agree / ${Math.round((1 - divisive.pct) * 100)}% disagree (${divisive.total} votes) — "${divisive.txt}"\n`;
  }
  return out.trim();
}

// Topic-close lifecycle — detected by diffing the active list every checker
// cycle, so it covers creator closes, admin-console closes, everything:
// followers get a results digest, the topic subgroup gets a final message and
// a "[closed]" rename, and subscriptions/sessions/slugs get pruned.
async function handleClosedTopics(activeNow) {
  const nowActive = new Set(activeNow.map(c => c.zinvite).filter(Boolean));
  const known = knownActiveTopics; // { zinvite: topic }
  for (const [z, topic] of Object.entries(known)) {
    if (nowActive.has(z)) continue;
    delete knownActiveTopics[z];
    console.log(`Topic closed: ${z} "${topic}"`);
    try {
      const digest = await buildTopicDigest(z, topic);
      const closeMsg = `🏁 *This topic has closed.* Thank you for voting!\n\n${digest}\n\nFull results: ${topicUrl(z, topic)}`;

      // Its WhatsApp subgroup and DM sessions
      wa?.topicClosed(z, topic, closeMsg);

      // Followers: digest on every verified channel, then prune the sub
      for (const [accountId, acct] of accountsFollowing(z)) {
        const phone = acctWhatsapp(acct);
        const em = acctEmail(acct);
        if (phone) wa.dm(phone, closeMsg);
        await pushToAccount(accountId, acct, {
          title: `Closed: ${topic}`,
          body: 'Thank you for voting. See where the community landed.',
          url: topicUrl(z, topic),
          tag: `t-${z}`,
        });
        if (em) {
          await sendEmail(
            em,
            `Topic closed — results: ${topic}`,
            `${closeMsg.replace(/\*/g, '')}\n\n—\n${BRAND_NAME} · ${PUBLIC_URL}\nUnsubscribe from everything: ${unsubscribeLink(accountId, null)}`,
            unsubscribeLink(accountId, null),
            null,
            emailShell(`🏁 Topic closed: ${escHtml(topic)}`,
              `<p style="margin:0 0 10px;font-size:14px;color:#444;">Thank you for voting! Here's where the community landed:</p>` +
              `<div style="margin:10px 0 16px;padding:14px 16px;background:#f4f2ec;border-radius:10px;font-size:14px;line-height:1.7;color:#3a3a3a;">${escHtml(digest.replace(/\*/g, '')).replace(/\n/g, '<br>')}</div>` +
              emailButton('See the full results →', topicUrl(z, topic)),
              `<a href="${unsubscribeLink(accountId, null)}" style="color:#8a887f;">Unsubscribe from everything</a><br>`)
          );
        }
        acct.subs = (acct.subs || []).filter(s => s !== z);
      }
    } catch (e) {
      console.error(`Close lifecycle failed for ${z}:`, e.message);
    }
  }
  for (const c of activeNow) {
    if (c.zinvite) knownActiveTopics[c.zinvite] = c.topic;
  }
  saveState();
}


// --- New statement notification checker ---

async function checkForNewStatements() {
  try {
    const convos = await getActiveConversations();
    await handleClosedTopics(convos);
    wa?.syncTopicGroups(convos);
    for (const conv of convos) {
      if (!conv.zinvite) continue;

      // Get current comment count via participationInit
      const result = await polisRequest(
        'GET',
        `/api/v3/participationInit?conversation_id=${conv.zinvite}`,
        null,
        adminToken,
      );
      if (result.status !== 200) continue;

      const currentCount = result.data.pca?.asPOJO?.['n-cmts'] || 0;
      const lastKnown = conversationCommentCounts[conv.zinvite] || 0;

      if (lastKnown > 0 && currentCount > lastKnown) {
        const newCount = currentCount - lastKnown;
        console.log(`New statements detected: ${newCount} new in ${conv.zinvite}`);

        // WhatsApp DM sessions and the topic's subgroup, when the bridge is on
        const notifiedPhones = wa ? wa.newStatements(conv, newCount, notifyCount) : [];

        // The newest statements themselves (for one-click email voting)
        let newStatements = [];
        try {
          const comments = await getComments(adminToken, conv.zinvite);
          newStatements = comments
            .sort((a, b) => b.tid - a.tid)
            .slice(0, Math.min(newCount, 3))
            .reverse()
            .map(c => ({ tid: c.tid, txt: c.txt }));
        } catch {}

        // Web hub groups (email + WhatsApp followers), deduped against above
        await notifyGroup(
          conv.zinvite,
          conv.topic,
          (n) => `🔔 *${n} new statement${n > 1 ? 's' : ''}* to vote on in "${conv.topic}"`,
          notifiedPhones,
          (n) => `${n} new statement${n > 1 ? 's' : ''} to vote on: ${conv.topic}`,
          newStatements,
          newCount
        );
      }

      conversationCommentCounts[conv.zinvite] = currentCount;
    }
    saveState();
  } catch (err) {
    console.error('New statement check error:', err.message);
  }
}

// Check every 5 minutes
setInterval(checkForNewStatements, 5 * 60 * 1000);

// --- Weekly unvoted-backlog nudge ---
// At most once a week per follower: "you have N statements waiting" across
// their followed topics. Sweep runs at most daily; skips anyone nudged or
// notified recently.
async function runNudgeSweep() {
  const now = Date.now();
  if (now - (nudgeLog._lastSweep || 0) < 24 * 3600000) return;
  nudgeLog._lastSweep = now;
  saveState();
  try {
    const convos = await getActiveConversations();
    const byZ = {};
    convos.forEach(c => { if (c.zinvite) byZ[c.zinvite] = c; });
    for (const [accountId, acct] of Object.entries(webAccounts)) {
      if (acct.verified === false) continue;
      const subs = (acct.subs || []).filter(z => byZ[z]);
      if (!subs.length) continue;
      const nudgeKey = acct.contact || accountId;
      if (now - (nudgeLog[nudgeKey] || 0) < 7 * 24 * 3600000) continue;
      // Only accounts with an established identity — the sweep must never
      // mint one (see accountXid durability rule).
      const sweepXid = accountXid(accountId);
      if (!sweepXid) continue;
      const backlog = [];
      for (const z of subs) {
        try {
          const init = await initByXid(sweepXid, z);
          const unvoted = init.nextComment ? (init.nextComment.remaining || 0) + 1 : 0;
          if (unvoted > 0) backlog.push({ z, topic: byZ[z].topic, unvoted });
        } catch {}
      }
      if (!backlog.length) continue;
      nudgeLog[nudgeKey] = now;
      const total = backlog.reduce((s, b) => s + b.unvoted, 0);
      backlog.sort((a, b) => b.unvoted - a.unvoted);
      const nWa = acctWhatsapp(acct);
      const nEm = acctEmail(acct);
      if (nWa) wa.nudge(nWa, backlog, total);
      await pushToAccount(accountId, acct, {
        title: `${total} statement${total > 1 ? 's' : ''} waiting for your vote`,
        body: backlog.map(b => `${b.topic} — ${b.unvoted}`).join('\n'),
        url: topicUrl(backlog[0].z, backlog[0].topic),
        tag: 'nudge',
      });
      if (nEm) {
        let bodyTxt = `You have ${total} statement${total > 1 ? 's' : ''} waiting for your vote:\n`;
        backlog.forEach(b => { bodyTxt += `\n${b.topic} (${b.unvoted} unvoted): ${topicUrl(b.z, b.topic)}`; });
        bodyTxt += `\n\n✉️ Or just REPLY to this email to vote on "${backlog[0].topic}": one word per statement, in order — e.g. "a d p".`;
        bodyTxt += `\n\n—\n${BRAND_NAME} · ${PUBLIC_URL}\nUnsubscribe from everything: ${unsubscribeLink(accountId, null)}`;
        await sendEmail(
          nEm,
          `${total} statement${total > 1 ? 's' : ''} waiting for your vote`,
          bodyTxt,
          unsubscribeLink(accountId, null),
          voteReplyAddress(accountId, backlog[0].z),
          emailShell(`👋 ${total} statement${total > 1 ? 's' : ''} waiting for your vote`,
            backlog.map(b =>
              `<div style="margin:8px 0;padding:12px 15px;background:#f4f2ec;border-radius:10px;">` +
              `<div style="font-size:14px;font-weight:600;color:#1a1a2e;margin-bottom:6px;">${escHtml(b.topic)} <span style="font-weight:400;color:#8a887f;">· ${b.unvoted} unvoted</span></div>` +
              emailButton('Vote →', topicUrl(b.z, b.topic), 'outline') + `</div>`).join('') +
            `<p style="margin:14px 0 0;font-size:13px;color:#666;">✉️ Or just <b>reply to this email</b> to vote on &ldquo;${escHtml(backlog[0].topic)}&rdquo; — one word per statement, e.g. &ldquo;a d p&rdquo;.</p>`,
            `<a href="${unsubscribeLink(accountId, null)}" style="color:#8a887f;">Unsubscribe from everything</a><br>`)
        );
      }
      saveState();
    }
  } catch (e) {
    console.error('Nudge sweep error:', e.message);
  }
}
setInterval(runNudgeSweep, 6 * 3600000);
setTimeout(runNudgeSweep, 10 * 60000);
// Initial check after 30s (let server start up)
setTimeout(checkForNewStatements, 30000);

// --- Petitions ---
// A separate module with its own store: petitions carry real names, street
// addresses and photographs of signed sheets, none of which belong in
// voting-state.json alongside anonymous voting data.
petitions.init({
  DIR: __dirname,
  PUBLIC_URL, BRAND_NAME,
  PLACE: process.env.POLIS_PETITION_PLACE || 'Croton-on-Hudson',
  escHtml, pageShell, cleanText, clientIp, hashIp,
  sendEmail, emailShell, emailButton, emailQuote, unsubscribeLink,
  acctEmail, acctWhatsapp, pushToAccount,
  getAccount: (id) => (id ? webAccounts[id] : undefined),
  allAccounts: () => webAccounts,
  queueWa: (n) => { if (wa) { wa.dm(n.phone, n.text); saveState(); } },
  WA_ANNOUNCE_JID: () => (wa ? wa.announceJid() : ''),
  LINK_SECRET: () => LINK_SECRET,
});

wa?.init({
  data: waData, BRAND_NAME, PUBLIC_URL, PORT,
  saveState, readBody, getActiveConversations, initByXid, vote, getComments, submitComment, topicUrl,
  accounts: () => webAccounts,
  markAuthor: (phone, zinvite) => { recentAuthors[`${phone}|${zinvite}`] = Date.now(); },
});

// --- HTTP Server ---

// nginx stamps X-External-Request on everything it proxies here, so the hub
// can tell a request off the internet from a loopback call by the router or
// wireclaw. The admin endpoints below (/create, /seed, /conversations, the
// /wa/* bridge) are unauthenticated by design — they were only ever meant to
// be reachable over 127.0.0.1 — but the single-segment slug location matches
// their paths too. Anything external gets the public surface and nothing else.
const EXTERNAL_RESERVED = new Set(['create', 'seed', 'seed-bulk', 'conversations', 'info', 'admin', 'wa']);
function externalAllowed(method, urlPath) {
  if (urlPath === '/petitions' || urlPath.startsWith('/public/')
    || urlPath.startsWith('/t/') || urlPath.startsWith('/p/')) return true;
  const seg = urlPath.match(/^\/([a-z0-9-]+)$/);
  if (seg && (method === 'GET' || method === 'HEAD') && !EXTERNAL_RESERVED.has(seg[1])) return true;
  return false;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  try {
    if (req.headers['x-external-request']
      && !externalAllowed(req.method, (req.url || '').split('?')[0])) {
      res.writeHead(404);
      return res.end(JSON.stringify({ error: 'not found' }));
    }

    if (await petitions.handle(req, res)) return;

    // --- Original admin endpoints (unchanged) ---

    // POST /create — create a conversation
    if (req.method === 'POST' && req.url === '/create') {
      const body = await readBody(req);
      if (!body.topic) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'topic required' }));
      }
      const result = await polisRequest('POST', '/api/v3/conversations', {
        topic: body.topic,
        description: body.description || '',
        is_active: true,
        is_public: true,
        is_anon: false,
        auth_needed_to_vote: false,
        auth_needed_to_write: false,
      }, adminToken);

      if (result.status === 200 || result.status === 302) {
        const conv = result.data;
        res.writeHead(200);
        return res.end(JSON.stringify({
          zid: conv.zid,
          zinvite: conv.conversation_id,
          url: topicUrl(conv.conversation_id, body.topic),
          topic: body.topic,
        }));
      } else {
        res.writeHead(result.status || 500);
        return res.end(JSON.stringify({ error: 'Create failed', details: result.data }));
      }
    }

    // POST /seed — add a seed comment
    if (req.method === 'POST' && req.url === '/seed') {
      const body = await readBody(req);
      if (!body.zinvite || !body.text) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'zinvite and text required' }));
      }
      const result = await polisRequest('POST', '/api/v3/comments', {
        conversation_id: body.zinvite,
        txt: body.text,
        is_seed: true,
        vote: 0,
      }, adminToken);

      if (result.status === 200) {
        res.writeHead(200);
        return res.end(JSON.stringify({ tid: result.data.tid, text: body.text }));
      } else {
        res.writeHead(result.status || 500);
        return res.end(JSON.stringify({ error: 'Seed failed', details: result.data }));
      }
    }

    // GET /info/:zinvite
    const infoMatch = req.url?.match(/^\/info\/([a-z0-9]+)$/);
    if (req.method === 'GET' && infoMatch) {
      const zinvite = infoMatch[1];
      const result = await polisRequest('GET', `/api/v3/participationInit?conversation_id=${zinvite}`, null, adminToken);
      if (result.status === 200) {
        const d = result.data;
        res.writeHead(200);
        return res.end(JSON.stringify({
          conversation_id: d.conversation_id || zinvite,
          url: topicUrl(zinvite, d.topic),
          topic: d.topic || '',
          nextComment: d.nextComment,
          votes: d.votes?.length || 0,
        }));
      } else {
        res.writeHead(result.status || 500);
        return res.end(JSON.stringify({ error: 'Info failed', details: result.data }));
      }
    }

    // POST /seed-bulk — add multiple seeds at once
    if (req.method === 'POST' && req.url === '/seed-bulk') {
      const body = await readBody(req);
      if (!body.zinvite || !body.statements || !Array.isArray(body.statements)) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'zinvite and statements[] required' }));
      }
      const results = [];
      for (const text of body.statements) {
        const result = await polisRequest('POST', '/api/v3/comments', {
          conversation_id: body.zinvite,
          txt: text,
          is_seed: true,
          vote: 0,
        }, adminToken);
        results.push({ tid: result.data?.tid, text, status: result.status });
      }
      conversationCommentCounts[body.zinvite] =
        (conversationCommentCounts[body.zinvite] || 0) + results.filter(r => r.status === 200).length;
      saveState();
      res.writeHead(200);
      return res.end(JSON.stringify({ seeded: results.length, results }));
    }

    // POST /admin/close — deactivate any conversation (loopback-only, like
    // /create; for moderation from the shell: curl -d '{"zinvite":"..."}')
    if (req.method === 'POST' && req.url === '/admin/close') {
      const body = await readBody(req);
      if (!body.zinvite) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'zinvite required' }));
      }
      const result = await polisRequest('PUT', '/api/v3/conversations', {
        conversation_id: body.zinvite,
        is_active: false,
      }, adminToken);
      res.writeHead(result.status === 200 ? 200 : 502);
      return res.end(JSON.stringify(result.status === 200
        ? { ok: true, zinvite: body.zinvite }
        : { error: 'close failed', details: result.data }));
    }

    // --- WhatsApp voting endpoints ---

    // GET /conversations — list active conversations
    if (req.method === 'GET' && req.url === '/conversations') {
      const convos = await getActiveConversations();
      res.writeHead(200);
      return res.end(JSON.stringify(convos));
    }

    // WhatsApp bridge routes (/wa/*), when it is on — loopback only.
    if (wa && await wa.handle(req, res)) return;

    // --- Public web hub routes (the ONLY ones nginx exposes to the internet) ---

    // GET /t/:slug — human-readable topic URL. Served via nginx internal
    // redirect (X-Accel-Redirect) so the browser keeps the slug in the
    // address bar while the participation client renders the page.
    const urlPath = (req.url || '').split('?')[0];
    const urlQuery = (req.url || '').includes('?') ? '?' + (req.url || '').split('?').slice(1).join('?') : '';
    const slugMatch = urlPath.match(/^\/t\/([a-z0-9-]+)$/);
    if ((req.method === 'GET' || req.method === 'HEAD') && slugMatch) {
      const zinvite = topicSlugs[slugMatch[1]];
      if (zinvite) {
        // Topic pages ARE the landing page in single-topic mode
        res.writeHead(200, { 'X-Accel-Redirect': '/_topic', 'Content-Type': 'text/html; charset=utf-8' });
        return res.end();
      }
      res.writeHead(302, { Location: `${PUBLIC_URL}/` });
      return res.end();
    }

    // GET /public/topics — active topics, safe fields only, sorted by engagement
    if (req.method === 'GET' && req.url === '/public/topics') {
      const convos = await getActiveConversations();
      const topics = convos.map(c => ({
        zinvite: c.zinvite,
        slug: c.slug,
        topic: c.topic,
        description: c.description || '',
        participant_count: c.participant_count,
        statement_count: conversationCommentCounts[c.zinvite] || 0,
        created: c.created || 0,
        followers: accountsFollowing(c.zinvite).length,
        url: c.url,
        community: !!communityTopics[c.zinvite],
      }));
      topics.sort((a, b) =>
        (b.participant_count + b.followers + b.statement_count / 2)
        - (a.participant_count + a.followers + a.statement_count / 2));
      res.writeHead(200);
      return res.end(JSON.stringify(topics));
    }

    // POST /public/email-reply — Mailgun forwards replies to our vote+
    // addresses here. Parse "agree" / "a d p" style replies into votes on
    // the sender's next unvoted statements, then email back a receipt.
    if (req.method === 'POST' && req.url === '/public/email-reply') {
      const f = await readMailgunBody(req);
      // Always 200 — anything else makes Mailgun retry for days.
      const done = (why) => {
        if (why) console.log(`email-reply ignored: ${why}`);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      };

      // Account ids are case-sensitive — never lowercase the local part
      const recipient = String(f.recipient || '').trim();
      const m = recipient.match(/^vote\+([a-zA-Z0-9_-]+)\.([a-z0-9]+)\.([a-f0-9]{16})@/i);
      if (!m) return done('bad recipient shape');
      const [, accountId, zinvite, sig] = m;
      const acct = webAccounts[accountId];
      if (!acct || sig !== replySig(accountId, zinvite)) return done('bad signature');

      // Sender must be the account's email (soft identity check on top of
      // the signed address), and auto-responders are ignored.
      const senderEmail = String(f.sender || f.from || '').toLowerCase().match(/[^\s<>"']+@[^\s<>"']+/);
      if (!senderEmail || !acct.email || senderEmail[0] !== acct.email.toLowerCase()) return done('sender mismatch');
      if (/auto-submitted:\s*auto/i.test(String(f['message-headers'] || ''))) return done('auto-submitted');

      emailReplyLog[accountId] = (emailReplyLog[accountId] || []).filter(t => Date.now() - t < 600000);
      if (emailReplyLog[accountId].length >= 5) return done('rate limited');
      emailReplyLog[accountId].push(Date.now());

      // Parse leading vote words from the reply (stripped-text excludes the
      // quoted original). Stop at the first non-vote token; cap at 10.
      const textIn = String(f['stripped-text'] || f['body-plain'] || '');
      const tokens = textIn.toLowerCase().split(/[\s,;.!]+/).filter(Boolean);
      const votesToCast = [];
      for (const t of tokens) {
        if (t in REPLY_VOTE_WORDS) { votesToCast.push(REPLY_VOTE_WORDS[t]); if (votesToCast.length >= 10) break; }
        else break;
      }
      const unsub = unsubscribeLink(accountId, zinvite);
      const replyAddr = voteReplyAddress(accountId, zinvite);
      const topicName = (knownActiveTopics[zinvite]) || 'this topic';

      if (!votesToCast.length) {
        // One gentle help reply per hour, then silence (loop safety)
        if (Date.now() - (helpReplyLog[accountId] || 0) > 3600000) {
          helpReplyLog[accountId] = Date.now();
          await sendEmail(acct.email, `How to vote by reply — ${BRAND_NAME}`,
            `To vote by email, reply with one word per statement, in order:\n\n  agree  (or a / yes)\n  disagree  (or d / no)\n  pass  (or p / skip)\n\nExample: a reply saying "a d p" votes agree, disagree, pass on your next three unvoted statements.\n\nOr vote on the site: ${topicUrl(zinvite, topicName)}\n\n—\n${BRAND_NAME} · ${PUBLIC_URL}\nUnsubscribe: ${unsub}`,
            unsub, replyAddr,
            emailShell('How to vote by reply',
              `<p style="margin:0 0 12px;font-size:14px;color:#444;">Reply to any topic email with one word per statement, in order:</p>` +
              `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 14px;font-size:14px;color:#3a3a3a;">` +
              `<tr><td style="padding:4px 14px 4px 0;"><b>👍 agree</b></td><td style="color:#8a887f;">or a / yes</td></tr>` +
              `<tr><td style="padding:4px 14px 4px 0;"><b>👎 disagree</b></td><td style="color:#8a887f;">or d / no</td></tr>` +
              `<tr><td style="padding:4px 14px 4px 0;"><b>⏭ pass</b></td><td style="color:#8a887f;">or p / skip</td></tr></table>` +
              `<p style="margin:0 0 16px;font-size:14px;color:#444;">Example: replying &ldquo;<b>a d p</b>&rdquo; votes agree, disagree, pass on your next three unvoted statements.</p>` +
              emailButton('Vote on the site instead →', topicUrl(zinvite, topicName), 'outline'),
              `<a href="${unsub}" style="color:#8a887f;">Unsubscribe</a><br>`));
        }
        return done('no vote words');
      }

      done(); // respond to Mailgun immediately; casting continues async
      try {
        let xid = accountXid(accountId);
        if (!xid) { xid = `email:${accountId}`; setAccountXid(accountId, xid, 'email-reply-mint'); }
        const recorded = [];
        let remaining = null;
        for (const val of votesToCast) {
          const init = await initByXid(xid, zinvite);
          if (!init.token || !init.nextComment) { remaining = 0; break; }
          await vote(init.token, zinvite, init.nextComment.tid, val);
          recorded.push(`${val === -1 ? '👍 agree' : val === 1 ? '👎 disagree' : '⏭ pass'} — "${init.nextComment.txt}"`);
          remaining = Math.max(0, (init.nextComment.remaining || 0));
        }
        const summary = recorded.length
          ? `Recorded ${recorded.length} vote${recorded.length > 1 ? 's' : ''}:\n\n${recorded.join('\n')}\n\n${remaining ? `${remaining} statement${remaining > 1 ? 's' : ''} left — reply again (e.g. "a a p") to keep going, or vote on the site:` : `🎉 That's every statement in this topic! See the results:`}\n${topicUrl(zinvite, topicName)}`
          : `You've already voted on every statement in this topic. See the results:\n${topicUrl(zinvite, topicName)}`;
        await sendEmail(acct.email, `✅ Votes recorded — ${topicName}`,
          `${summary}\n\n—\n${BRAND_NAME} · ${PUBLIC_URL}\nUnsubscribe: ${unsub}`,
          unsub, replyAddr,
          emailShell(recorded.length ? `✅ ${recorded.length} vote${recorded.length > 1 ? 's' : ''} recorded` : 'All caught up',
            (recorded.length
              ? recorded.map(r => `<div style="margin:6px 0;padding:9px 13px;background:#f0f8f2;border-radius:9px;font-size:14px;line-height:1.5;color:#2d5439;">${escHtml(r)}</div>`).join('')
              : `<p style="margin:0 0 12px;font-size:14px;color:#444;">You've already voted on every statement in this topic.</p>`) +
            `<p style="margin:14px 0 14px;font-size:13px;color:#666;">${remaining ? `<b>${remaining}</b> statement${remaining > 1 ? 's' : ''} left — reply again (e.g. &ldquo;a a p&rdquo;) to keep going, or:` : '🎉 That was the last one. See where the community landed:'}</p>` +
            emailButton(remaining ? 'Continue on the site →' : 'See the results →', topicUrl(zinvite, topicName)),
            `<a href="${unsub}" style="color:#8a887f;">Unsubscribe</a><br>`));
      } catch (e) {
        console.error('email-reply vote error:', e.message);
      }
      return;
    }

    // POST /public/bug — bug report from the site footer. Goes to the admin
    // by email and into the Support & bug reports WhatsApp group.
    if (req.method === 'POST' && req.url === '/public/bug') {
      const body = await readBody(req);
      if (body.website) { res.writeHead(200); return res.end(JSON.stringify({ ok: true })); }
      const text = cleanText(body.text, 2000, false);
      const contact = cleanText(body.contact, 120, true);
      if (!text || text.trim().length < 10) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Tell us a little more — at least a sentence.' }));
      }
      const ipKey = hashIp(req.socket.remoteAddress || '');
      bugReportLog[ipKey] = (bugReportLog[ipKey] || []).filter(t => Date.now() - t < 3600000);
      if (bugReportLog[ipKey].length >= 5) {
        res.writeHead(429);
        return res.end(JSON.stringify({ error: 'That’s plenty for one hour — thank you! Try again later.' }));
      }
      bugReportLog[ipKey].push(Date.now());

      const report = `🐞 *Bug report*\n\n${text.trim()}\n\n${contact ? `From: ${contact}` : '(no contact left)'}`;
      if (wa) { wa.support(report); saveState(); }
      await sendEmail(
        BUG_EMAIL,
        `Bug report — ${BRAND_NAME}`,
        `${text.trim()}\n\n${contact ? `From: ${contact}` : '(no contact left)'}\n\n—\n${BRAND_NAME} · ${PUBLIC_URL}`
      );
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true }));
    }

    // GET /public/stats?account=<id> — the account's participation across
    // active topics: votes cast, statements written, topics opened. Uses the
    // read-only admin participation endpoint (never creates participants).
    if (req.method === 'GET' && req.url.startsWith('/public/stats?')) {
      const q = new URL(req.url, 'http://x').searchParams;
      const accountId = q.get('account') || '';
      const acct = webAccounts[accountId];
      if (!acct) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Unknown account.' }));
      }
      const cached = statsCache[accountId];
      if (cached && Date.now() - cached.ts < 8000) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(cached.body);
      }
      let votes = 0, statements = 0;
      try {
        if (acct.xid) {
          const convos = await getActiveConversations();
          for (const c of convos) {
            if (!c.zinvite) continue;
            const part = await polisRequest('GET',
              `/api/v3/participation?conversation_id=${encodeURIComponent(c.zinvite)}&strict=false`,
              null, adminToken).catch(() => null);
            const mine = part && part.status === 200 && part.data && part.data[acct.xid];
            if (mine) {
              votes += mine.votes || 0;
              statements += mine.comments || 0;
            }
          }
        }
      } catch (e) {
        console.error('stats error:', e.message);
      }
      const topics = Object.values(communityTopics)
        .filter(t => t.accountId === accountId).length;
      const body = JSON.stringify({ votes, statements, topics });
      statsCache[accountId] = { ts: Date.now(), body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(body);
    }

    // GET /public/my-activity?account= — the signed-in member's footprint:
    // topics they voted in, statements they wrote (with live tallies), and
    // topics they created (with removability). Read-only Polis calls only.
    if (req.method === 'GET' && req.url.startsWith('/public/my-activity?')) {
      const q = new URL(req.url, 'http://x').searchParams;
      const accountId = q.get('account') || '';
      const acct = webAccounts[accountId];
      if (!acct) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Unknown account.' }));
      }
      const out = { votes: [], statements: [], topics: [] };
      try {
        const convos = await getActiveConversations();
        for (const c of convos) {
          if (!c.zinvite) continue;
          let mine = null;
          if (acct.xid) {
            const part = await polisRequest('GET',
              `/api/v3/participation?conversation_id=${encodeURIComponent(c.zinvite)}&strict=false`,
              null, adminToken).catch(() => null);
            mine = (part && part.status === 200 && part.data && part.data[acct.xid]) || null;
          }
          if (mine && mine.votes > 0) {
            out.votes.push({ zinvite: c.zinvite, topic: c.topic, slug: c.slug, count: mine.votes });
          }
          if (mine && mine.comments > 0) {
            // Get this member's pid via participationInit — for an xid that
            // already exists (they've participated) this returns the existing
            // participant, creating nothing. Then match their own comments.
            const [initRes, comRes] = await Promise.all([
              initByXid(acct.xid, c.zinvite).catch(() => null),
              polisRequest('GET', `/api/v3/comments?conversation_id=${encodeURIComponent(c.zinvite)}&moderation=true&include_voting_patterns=true`, null, adminToken).catch(() => null),
            ]);
            const myPid = initRes && initRes.pid;
            if (myPid !== undefined && myPid !== null && comRes && comRes.status === 200 && Array.isArray(comRes.data)) {
              const items = comRes.data
                .filter(cm => cm.txt && cm.mod !== -1 && cm.pid === myPid)
                .map(cm => ({
                  tid: cm.tid, txt: cm.txt,
                  agree: cm.agree_count || 0, disagree: cm.disagree_count || 0,
                  pass: cm.pass_count || 0, total: cm.count || 0,
                }));
              if (items.length) out.statements.push({ zinvite: c.zinvite, topic: c.topic, slug: c.slug, items });
            }
          }
          const ct = communityTopics[c.zinvite];
          if (ct && ct.accountId === accountId) {
            const createdMs = Date.parse(ct.created) || 0;
            let totalVotes = 0;
            try {
              const r = await fetch(`http://127.0.0.1:${PORT}/public/results?z=${encodeURIComponent(c.zinvite)}`).then(x => x.json());
              totalVotes = (r.statements || []).reduce((s, st) => s + (st.total || 0), 0);
            } catch {}
            const othersVotes = Math.max(0, totalVotes - (mine ? mine.votes : 0));
            out.topics.push({
              zinvite: c.zinvite, topic: c.topic, slug: c.slug, created: createdMs,
              othersVotes,
              removable: (Date.now() - createdMs < 3600000) || othersVotes === 0,
            });
          }
        }
      } catch (e) {
        console.error('my-activity error:', e.message);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    }

    // POST /public/topic-remove { accountId, zinvite } — a creator quietly
    // removes their topic: within 1 hour of creation, or any time while no
    // one else has voted. No close-fanfare (no digests, no group posts).
    if (req.method === 'POST' && req.url === '/public/topic-remove') {
      const body = await readBody(req);
      const acct = webAccounts[body.accountId || ''];
      const ct = communityTopics[body.zinvite || ''];
      if (!acct || !ct || ct.accountId !== body.accountId) {
        res.writeHead(403);
        return res.end(JSON.stringify({ error: 'Only the person who created this topic can remove it.' }));
      }
      const createdMs = Date.parse(ct.created) || 0;
      let totalVotes = 0, myVotes = 0;
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/public/results?z=${encodeURIComponent(body.zinvite)}`).then(x => x.json());
        totalVotes = (r.statements || []).reduce((s, st) => s + (st.total || 0), 0);
        if (acct.xid) {
          const part = await polisRequest('GET',
            `/api/v3/participation?conversation_id=${encodeURIComponent(body.zinvite)}&strict=false`,
            null, adminToken).catch(() => null);
          myVotes = (part && part.status === 200 && part.data && part.data[acct.xid] && part.data[acct.xid].votes) || 0;
        }
      } catch {}
      const othersVotes = Math.max(0, totalVotes - myVotes);
      if (Date.now() - createdMs >= 3600000 && othersVotes > 0) {
        res.writeHead(403);
        return res.end(JSON.stringify({ error: `Neighbors have already cast ${othersVotes} vote${othersVotes > 1 ? 's' : ''} here, and the one-hour window has passed — the topic can be closed from its card instead.` }));
      }
      ct.removed = true;
      saveState();
      const result = await polisRequest('PUT', '/api/v3/conversations', {
        conversation_id: body.zinvite,
        is_active: false,
      }, adminToken);
      if (result.status !== 200) {
        delete ct.removed;
        saveState();
        res.writeHead(502);
        return res.end(JSON.stringify({ error: 'Could not remove the topic right now — please try again.' }));
      }
      console.log(`Topic removed by creator: ${body.zinvite}`);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true }));
    }

    // GET /public/me — cookie-based signin: the device that tapped a verify
    // link carries the account cookie, so it can sign in without a claim.
    if (req.method === 'GET' && req.url === '/public/me') {
      const cookies = String(req.headers.cookie || '');
      const m = cookies.match(/(?:^|;\s*)forum_acct=([A-Za-z0-9_-]+)/);
      const acct = m && webAccounts[m[1]];
      if (!acct) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: 'Not signed in.' }));
      }
      res.writeHead(200);
      return res.end(JSON.stringify(accountPayload(m[1])));
    }

    // GET /public/account?account=<id> — fresh account state (name, channel,
    // subs, allTopics) so browsers can re-sync follow state on page load.
    if (req.method === 'GET' && req.url.startsWith('/public/account?')) {
      const q = new URL(req.url, 'http://x').searchParams;
      const acct = webAccounts[q.get('account') || ''];
      if (!acct) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Unknown account.' }));
      }
      res.writeHead(200);
      return res.end(JSON.stringify(accountPayload(q.get('account'))));
    }

    // POST /public/account — lightweight signup: display name + notification
    // channel. No passwords; the accountId returned is the bearer credential
    // and lives in the member's browser.
    if (req.method === 'POST' && req.url === '/public/account') {
      const body = await readBody(req);
      if (body.website) { res.writeHead(200); return res.end(JSON.stringify({ ok: true })); }
      const name = cleanText(body.name, 60, true);

      // Dual contacts: either or both. (Legacy single channel/contact bodies
      // are mapped in.) Each must be proven by its own clickthrough link
      // before it is used for anything. With the WhatsApp bridge off, a
      // number in the body is ignored: neither added nor removed.
      let email = cleanText(body.email || (body.channel === 'email' ? body.contact : ''), 120, true).toLowerCase();
      let whatsapp = wa ? cleanText(body.whatsapp || (body.channel === 'whatsapp' ? body.contact : ''), 40, true).replace(/[^\d]/g, '') : '';
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Please enter a valid email address.' }));
      }
      if (whatsapp) {
        if (whatsapp.length === 10) whatsapp = '1' + whatsapp; // assume US
        if (whatsapp.length < 11 || whatsapp.length > 15) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Please enter a valid WhatsApp number (with area code).' }));
        }
      }
      if (!email && !whatsapp && !(webAccounts[body.previousAccountId] || {}).devices?.length) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: wa ? 'Enter an email address, a WhatsApp number, or both.' : 'Enter an email address.' }));
      }

      const contacts = [];
      if (email) contacts.push({ channel: 'email', contact: email, token: crypto.randomBytes(24).toString('base64url') });
      if (whatsapp) contacts.push({ channel: 'whatsapp', contact: whatsapp, token: crypto.randomBytes(24).toString('base64url') });

      // Change-aware save for a signed-in account: apply profile edits and
      // removals immediately; verify only contacts that are actually new.
      const prevId = typeof body.previousAccountId === 'string' ? body.previousAccountId : null;
      const prevAcct = prevId && webAccounts[prevId];
      if (prevAcct && prevAcct.verified !== false) {
        const name2 = cleanText(body.name, 60, true);
        if (name2) prevAcct.name = name2;
        if (body.allTopics !== undefined) prevAcct.allTopics = !!body.allTopics;
        // Removals: a cleared field means "drop this channel"
        if (prevAcct.email && !email) { prevAcct.email = null; prevAcct.emailVerified = false; }
        if (wa && prevAcct.whatsapp && !whatsapp) { prevAcct.whatsapp = null; prevAcct.whatsappVerified = false; }
        if (!prevAcct.email && !acctWhatsapp(prevAcct) && !(prevAcct.devices || []).length && !contacts.length) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Keep at least one way to reach you.' }));
        }
        const needs = contacts.filter(c => !(
          c.channel === 'email'
            ? (prevAcct.email === c.contact && prevAcct.emailVerified)
            : (prevAcct.whatsapp === c.contact && prevAcct.whatsappVerified)));
        settleChannel(prevAcct);
        saveState();
        if (!needs.length) {
          // Pure profile edit — done, no verification round-trip
          res.writeHead(200, { 'Set-Cookie': acctCookie(prevId) });
          return res.end(JSON.stringify(accountPayload(prevId)));
        }
        // Targeted add: only the new contact(s) get confirmation links
        const claimId2 = crypto.randomBytes(16).toString('base64url');
        const pending2 = {
          targetAccountId: prevId, contacts: needs,
          created: Date.now(), verified: false,
        };
        const who = prevAcct.name ? `the ${BRAND_NAME} account of “${prevAcct.name}”` : `an existing ${BRAND_NAME} account`;
        for (const c of needs) {
          const link = `${PUBLIC_URL}/public/verify?token=${c.token}`;
          if (c.channel === 'email') {
            const sent = await sendEmail(c.contact, `Link this email to ${BRAND_NAME}`,
              `Click this link to LINK this email address to ${who} for updates:\n\n${link}\n\nIf this isn't you, or you don't recognize the account, ignore this email — nothing will change.\nThe link expires in 30 minutes.\n\n—\n${BRAND_NAME} · ${PUBLIC_URL}`,
              null, null,
              emailShell('Link this email address?',
                `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#444;">Confirm to link this email address to ${escHtml(who)} for topic updates.</p>` +
                emailButton('Link this email →', link) +
                `<p style="margin:16px 0 0;font-size:13px;color:#8a887f;">If this isn't you, or you don't recognize the account, ignore this email — nothing will change. The link expires in 30 minutes.</p>`));
            if (!sent) {
              res.writeHead(502);
              return res.end(JSON.stringify({ error: 'Couldn’t send the confirmation email — please try again shortly.' }));
            }
          } else {
            wa.dm(c.contact, `👋 Tap to *link this number* to ${who} for updates:\n\n${link}\n\nIf this isn't you, or you don't recognize the account, ignore this message — nothing will change. The link expires in 30 minutes.`);
          }
        }
        pendingVerifications[claimId2] = pending2;
        saveState();
        res.writeHead(200);
        return res.end(JSON.stringify({
          pending: true, claimId: claimId2, channels: needs.map(c => c.channel), updated: true,
        }));
      }

      for (const c of contacts) {
        const inflight = Object.values(pendingVerifications).filter(p =>
          (p.contacts || []).some(pc => pc.contact === c.contact) && !p.verified && Date.now() - p.created < 3600000);
        if (inflight.length >= 3) {
          res.writeHead(429);
          return res.end(JSON.stringify({ error: 'Too many signup attempts for that contact — try again in an hour.' }));
        }
      }

      const claimId = crypto.randomBytes(16).toString('base64url');
      const pending = {
        name, contacts,
        allTopics: body.allTopics === undefined ? undefined : !!body.allTopics,
        previousAccountId: typeof body.previousAccountId === 'string' ? body.previousAccountId : null,
        xid: (typeof body.xid === 'string' && /^web:[0-9a-f-]{36}$/.test(body.xid)) ? body.xid : null,
        created: Date.now(),
        verified: false,
      };

      for (const c of contacts) {
        const link = `${PUBLIC_URL}/public/verify?token=${c.token}`;
        if (c.channel === 'email') {
          const sent = await sendEmail(
            c.contact,
            `Confirm your ${BRAND_NAME} account`,
            `Hi${name ? ' ' + name : ''},\n\nClick this link to confirm your email and finish setting up your ${BRAND_NAME} account:\n\n${link}\n\nThe link expires in 30 minutes. If you didn't request this, you can ignore this email — no account will be created.\n\n—\n${BRAND_NAME} · ${PUBLIC_URL}`,
            null, null,
            emailShell(`Hi${name ? ' ' + escHtml(name) : ''} 👋`,
              `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#444;">One tap finishes setting up your ${BRAND_NAME} account — you'll get topic updates here and can vote right from your inbox.</p>` +
              emailButton('Confirm my email →', link) +
              `<p style="margin:16px 0 0;font-size:13px;color:#8a887f;">The link expires in 30 minutes. If you didn't request this, ignore this email — no account will be created.</p>`)
          );
          if (!sent) {
            res.writeHead(502);
            return res.end(JSON.stringify({ error: 'Couldn’t send the confirmation email — please try again shortly.' }));
          }
        } else {
          wa.dm(c.contact, `👋 Tap to confirm your ${BRAND_NAME} account:\n\n${link}\n\nThe link expires in 30 minutes. If you didn't request this, ignore this message.`);
        }
      }

      pendingVerifications[claimId] = pending;
      saveState();
      res.writeHead(200);
      return res.end(JSON.stringify({ pending: true, claimId, channels: contacts.map(c => c.channel) }));
    }

    // GET /public/verify?token=… — email confirmation link. Finalizes the
    // account and binds this browser via cookie; the signup tab collects the
    // account through /public/claim polling.
    if (req.method === 'GET' && req.url.startsWith('/public/verify?')) {
      const q = new URL(req.url, 'http://x').searchParams;
      const token = q.get('token') || '';
      let hit = null;
      if (token) {
        for (const p of Object.values(pendingVerifications)) {
          const c = (p.contacts || []).find(cc => cc.token === token);
          if (c) { hit = { p, c }; break; }
          if (p.token === token) { hit = { p, c: { channel: p.channel, contact: p.contact } }; break; } // legacy pending
        }
      }
      if (!hit) {
        res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(verifyPage('Link expired', 'This confirmation link is no longer valid. Head back to the forum and sign up again to get a fresh one.', '⌛'));
      }
      if (!hit.p.contacts) hit.p.contacts = [hit.c]; // normalize legacy shape
      if (hit.p.targetAccountId) {
        // Adding a channel to an existing account: confirm without signing
        // this (possibly different) device into that account.
        finalizeTargetedContact(hit.p, hit.c);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(verifyPage(hit.c.channel === 'whatsapp' ? 'WhatsApp linked' : 'Email linked',
          'This contact is now linked to the account for updates. You can close this page.', '✅'));
      }
      const accountId = finalizeContact(hit.p, hit.c);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': acctCookie(accountId),
      });
      return res.end(verifyPage(
        hit.c.channel === 'whatsapp' ? 'WhatsApp confirmed' : 'Email confirmed',
        'You’re all set — successfully subscribed. If your signup tab is still open it will finish on its own.', '✅'));
    }

    // GET /public/email-vote — landing page for a vote link from an email.
    // Renders the statement and records the chosen vote via scripted POST,
    // then chains through remaining unvoted statements.
    if (req.method === 'GET' && req.url.startsWith('/public/email-vote?')) {
      const q = new URL(req.url, 'http://x').searchParams;
      const accountId = q.get('account') || '';
      const z = q.get('z') || '';
      const tid = parseInt(q.get('tid') || '', 10);
      const v = q.get('v') || '';
      const acct = webAccounts[accountId];
      if (!acct || !(v in EMAIL_VOTE_VALUES) || !Number.isInteger(tid) ||
          (q.get('sig') || '') !== voteSig(accountId, z, tid, v)) {
        res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(verifyPage('Link not valid', 'This voting link is invalid or has expired. You can always vote on the website.', '🤔'));
      }
      let stmt = '';
      try {
        const comments = await getComments(adminToken, z);
        const c = comments.find(cc => cc.tid === tid);
        stmt = c ? c.txt : '';
      } catch {}
      const boot = { account: accountId, z, tid, v, sig: q.get('sig'), stmt };
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pageShell('Vote',
        `<div class="icon">🗳️</div>
<div id="app" style="min-height:4rem"><p>Recording your vote…</p></div>
<script>
var BOOT = ${JSON.stringify(boot)};
var LBL = { a: '👍 Agree', d: '👎 Disagree', p: '⏭️ Pass' };
function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
function submit(p){
  var app = document.getElementById('app');
  app.style.opacity = '0.4';
  fetch('/public/email-vote-submit', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)})
    .then(function(r){return r.json();})
    .then(function(d){
      app.style.transition = 'opacity 0.25s ease';
      app.style.opacity = '1';
      if (d.error) { app.innerHTML = '<h1>Hmm</h1><p>' + esc(d.error) + '</p>'; return; }
      var html = '<h1>' + LBL[p.v] + ' recorded</h1>' +
        (p.stmt ? '<blockquote>' + esc(p.stmt) + '</blockquote>' : '');
      if (d.next) {
        html += '<p style="margin-top:1.1rem"><b>Next statement</b> <span style="color:#999">(' + d.next.position + ' of ' + d.next.total + ')</span></p>' +
          '<blockquote>' + esc(d.next.txt) + '</blockquote><p id="next-btns"></p>';
      } else {
        html += '<p style="margin-top:0.9rem">🎉 You\\'ve voted on every statement in this topic. Thank you!</p>';
      }
      app.innerHTML = html;
      if (d.next) {
        ['a','d','p'].forEach(function(k){
          var b = document.createElement('button');
          b.textContent = LBL[k];
          b.className = k === 'a' ? 'btn primary' : 'btn';
          b.onclick = function(){ submit({account:BOOT.account, z:BOOT.z, tid:d.next.tid, v:k, sig:d.next.sigs[k], stmt:d.next.txt}); };
          document.getElementById('next-btns').appendChild(b);
        });
      }
    })
    .catch(function(){ app.style.opacity='1'; app.innerHTML = '<h1>Hmm</h1><p>Something went wrong — try the website instead.</p>'; });
}
submit(BOOT);
</script>`));
    }

    // POST /public/email-vote-submit — records a signed email vote and hands
    // back the next unvoted statement (with fresh signatures) for chaining.
    if (req.method === 'POST' && req.url === '/public/email-vote-submit') {
      const body = await readBody(req);
      const accountId = String(body.account || '');
      const z = String(body.z || '');
      const tid = parseInt(body.tid, 10);
      const v = String(body.v || '');
      const acct = webAccounts[accountId];
      if (!acct || !(v in EMAIL_VOTE_VALUES) || !Number.isInteger(tid) ||
          String(body.sig || '') !== voteSig(accountId, z, tid, v)) {
        res.writeHead(410);
        return res.end(JSON.stringify({ error: 'This voting link is no longer valid — please vote on the website.' }));
      }
      try {
        // Explicit user action — the one place a synthetic email identity may
        // be minted (an email-only voter with no browser history needs one).
        let xid = accountXid(accountId);
        if (!xid) {
          xid = `email:${accountId}`;
          setAccountXid(accountId, xid, 'email-vote-mint');
        }
        let init = await initByXid(xid, z);
        if (!init.token) throw new Error('no participant token');
        const result = await vote(init.token, z, tid, EMAIL_VOTE_VALUES[v]);
        const next = result.nextComment && result.nextComment.tid !== undefined
          ? result.nextComment : null;
        res.writeHead(200);
        return res.end(JSON.stringify({
          ok: true,
          next: next && {
            tid: next.tid,
            txt: next.txt,
            total: next.total,
            position: next.total - (next.remaining || 0),
            sigs: {
              a: voteSig(accountId, z, next.tid, 'a'),
              d: voteSig(accountId, z, next.tid, 'd'),
              p: voteSig(accountId, z, next.tid, 'p'),
            },
          },
        }));
      } catch (e) {
        console.error('email-vote error:', e.message);
        res.writeHead(502);
        return res.end(JSON.stringify({ error: 'Couldn’t record that vote — please try the website.' }));
      }
    }

    // POST /public/account-xid { accountId, xid } — a signed-in browser with
    // real vote history claims the identity for an account that has none (or
    // only a synthetic one). Never downgrades: a real xid is never replaced.
    if (req.method === 'POST' && req.url === '/public/account-xid') {
      const body = await readBody(req);
      const acct = webAccounts[body.accountId || ''];
      const xid = typeof body.xid === 'string' && /^web:[0-9a-f-]{36}$/.test(body.xid) ? body.xid : null;
      if (!acct || !xid) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'accountId and a valid xid required' }));
      }
      if (!acct.xid || isSyntheticXid(acct.xid)) {
        setAccountXid(body.accountId, xid, 'browser-claim');
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ xid: acct.xid }));
    }

    // GET /public/results?z=… — live per-statement tallies + the slices of
    // the math payload the results view needs. Tallies require admin auth
    // against Polis, so the hub serves them; cached briefly to keep the
    // 30s-polling clients cheap.
    if (req.method === 'GET' && req.url.startsWith('/public/results?')) {
      const q = new URL(req.url, 'http://x').searchParams;
      const z = q.get('z') || '';
      if (!/^[a-z0-9]+$/.test(z)) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Bad topic id.' }));
      }
      const cached = resultsCache[z];
      if (cached && Date.now() - cached.ts < 20000) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(cached.body);
      }
      try {
        const [commentsRes, mathData] = await Promise.all([
          // moderation=true is what makes Polis join the vote tallies in
          polisRequest('GET', `/api/v3/comments?conversation_id=${encodeURIComponent(z)}&moderation=true&include_voting_patterns=true`, null, adminToken),
          // pca2 arrives gzipped — go through nginx with fetch, which inflates
          fetch(`${PUBLIC_URL}/api/v3/math/pca2?conversation_id=${encodeURIComponent(z)}`)
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null),
        ]);
        if (commentsRes.status !== 200 || !Array.isArray(commentsRes.data)) throw new Error(`comments ${commentsRes.status}`);
        // moderation=true includes rejected statements — never expose those
        const visible = commentsRes.data.filter(c => c.txt && c.mod !== -1);
        const statements = visible.map(c => ({
          tid: c.tid,
          txt: c.txt,
          agree: c.agree_count || 0,
          disagree: c.disagree_count || 0,
          pass: c.pass_count || 0,
          total: c.count || 0,
        }));
        // Distinct statement authors ("contributors")
        const contributors = new Set(visible.map(c => c.pid).filter(p => p !== undefined && p !== null)).size;
        const m = mathData || null;
        const math = m ? {
          n: m.n,
          groups: (m['group-clusters'] || []).map(g => ({ id: g.id, size: (g.members || []).length })),
          groupVotes: m['group-votes'] || null,
          consensus: m.consensus || null,
        } : null;
        const body = JSON.stringify({ statements, math, contributors });
        resultsCache[z] = { ts: Date.now(), body };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(body);
      } catch (e) {
        console.error('results endpoint error:', e.message);
        res.writeHead(502);
        return res.end(JSON.stringify({ error: 'Results are unavailable right now.' }));
      }
    }

    // GET /public/claim?claim=… — the signup browser polls this until the
    // email link is clicked, then adopts the account (single use).
    if (req.method === 'GET' && req.url.startsWith('/public/claim?')) {
      const q = new URL(req.url, 'http://x').searchParams;
      const claimId = q.get('claim') || '';
      const p = pendingVerifications[claimId];
      if (!p) {
        res.writeHead(410);
        return res.end(JSON.stringify({ error: 'Unknown or expired signup — please start again.' }));
      }
      if (!p.verified) {
        res.writeHead(200);
        return res.end(JSON.stringify({ pending: true }));
      }
      if (p.grantAccount === false) {
        // Confirmed by the contact's owner, but this browser isn't them.
        res.writeHead(200);
        return res.end(JSON.stringify({ confirmed: true, foreign: true }));
      }
      // Not deleted on collect: the pending survives (until TTL) so the
      // OTHER contact's link can still verify its channel.
      const payload = accountPayload(p.accountId);
      if (p.foreignContact) payload.foreignContact = p.foreignContact;
      res.writeHead(200, { 'Set-Cookie': acctCookie(p.accountId) });
      return res.end(JSON.stringify(payload));
    }

    // GET /public/push-key — the VAPID public key browsers subscribe with
    if (req.method === 'GET' && req.url === '/public/push-key') {
      res.writeHead(200, { 'Cache-Control': 'public, max-age=3600' });
      return res.end(JSON.stringify({ publicKey: pusher.publicKey }));
    }

    // POST /public/push — notifications on this device, in one tap.
    // { subscription, accountId?, name?, zinvite?, allTopics?, xid? }
    // Adds this browser's push subscription to the account, or — with no
    // account — to the account that already has it, or a new account (no
    // email, no number, no confirmation link). Also re-sent quietly on page
    // load, so changed keys and moved accounts heal on their own.
    if (req.method === 'POST' && req.url === '/public/push') {
      const body = await readBody(req);
      if (body.website) { res.writeHead(200); return res.end(JSON.stringify({ ok: true })); }
      const sub = body.subscription;
      if (!push.validSubscription(sub)) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'This browser can’t receive notifications from us. Try email instead.' }));
      }
      const ipKey = hashIp(clientIp(req));
      if (throttled(pushLog, ipKey, 120, 3600000)) {
        res.writeHead(429);
        return res.end(JSON.stringify({ error: 'Too many tries from this connection — wait a little and try again.' }));
      }
      if (body.accountId && !webAccounts[body.accountId]) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Unknown account.' }));
      }
      const holder = findDevice(sub.endpoint);
      // A subscription already on an account is only taken (adopted, moved,
      // or re-keyed) by the browser that holds it: the same auth secret,
      // which never leaves that browser, the push service, and us. The
      // account's own holder (its accountId) may always update its device.
      if (holder && holder !== body.accountId) {
        const held = webAccounts[holder].devices.find(d => d.endpoint === sub.endpoint);
        const a = Buffer.from(String(held.auth)), b = Buffer.from(String(sub.keys.auth));
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          res.writeHead(403);
          return res.end(JSON.stringify({ error: 'This notification subscription belongs to another device.' }));
        }
      }
      let accountId = body.accountId || holder;
      // The same browser, signed in to a different account now: the device
      // moves with it.
      if (holder && holder !== accountId) dropDevice(holder, d => d.endpoint === sub.endpoint);
      let created = false;
      if (!accountId) {
        if (throttled(pushAccountLog, ipKey, 60, 24 * 3600000)) { // a meeting on one Wi-Fi
          res.writeHead(429);
          return res.end(JSON.stringify({ error: 'That’s a lot of new sign-ups from this connection today. Try again tomorrow.' }));
        }
        accountId = crypto.randomBytes(16).toString('base64url');
        created = true;
        webAccounts[accountId] = {
          name: cleanText(body.name, 60, true), subs: [], allTopics: !!body.allTopics,
          email: null, whatsapp: null, emailVerified: false, whatsappVerified: false,
          verified: true, devices: [], created: new Date().toISOString(),
        };
      }
      const acct = webAccounts[accountId];
      acct.devices = acct.devices || [];
      let device = acct.devices.find(d => d.endpoint === sub.endpoint);
      const isNew = !device;
      if (isNew) {
        device = { id: deviceIdOf(sub.endpoint), endpoint: sub.endpoint, created: new Date().toISOString() };
        acct.devices.push(device);
        if (acct.devices.length > MAX_DEVICES) acct.devices.splice(0, acct.devices.length - MAX_DEVICES);
      }
      device.p256dh = sub.keys.p256dh;
      device.auth = sub.keys.auth;
      device.platform = push.platformOf(sub.endpoint, req.headers['user-agent']);
      if (!created && body.allTopics !== undefined) acct.allTopics = !!body.allTopics;
      const z = typeof body.zinvite === 'string' && /^[0-9a-z]+$/i.test(body.zinvite) ? body.zinvite : null;
      if (z) {
        acct.subs = acct.subs || [];
        if (!acct.subs.includes(z)) acct.subs.push(z);
      }
      // This browser's voting identity becomes the account's, unless the
      // account already has a real one (see accountXid durability rule).
      if (typeof body.xid === 'string' && /^web:[0-9a-f-]{36}$/.test(body.xid) && (!acct.xid || isSyntheticXid(acct.xid))) {
        setAccountXid(accountId, body.xid, created ? 'push-signup' : 'push-browser-xid');
      }
      acct.verified = true;
      settleChannel(acct);
      saveState();
      if (isNew) {
        console.log(`push: device ${device.id} (${device.platform}) on ${created ? 'new ' : ''}account ${accountId}`);
        // A first notification right away: proof it works, on the device.
        const topicName = z && knownActiveTopics[z];
        setImmediate(() => pusher.send(device, {
          title: 'Notifications are on',
          body: topicName
            ? `You’ll hear here when “${topicName}” gets new statements.`
            : `You’ll hear here when topics you follow get new statements.`,
          url: z && topicName ? topicUrl(z, topicName) : PUBLIC_URL,
          tag: 'welcome',
        }).then(r => { if (!r.ok) console.error(`push: welcome to ${device.id} → ${r.status} ${r.detail || ''}`); }));
      }
      res.writeHead(200, { 'Set-Cookie': acctCookie(accountId) });
      return res.end(JSON.stringify({ ...accountPayload(accountId), deviceId: device.id, created }));
    }

    // POST /public/push-remove — stop notifications on a device
    // { accountId, endpoint } (this browser) or { accountId, deviceId }
    if (req.method === 'POST' && req.url === '/public/push-remove') {
      const body = await readBody(req);
      const acct = webAccounts[body.accountId || ''];
      if (!acct) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Unknown account.' }));
      }
      const removed = dropDevice(body.accountId, d =>
        (body.endpoint && d.endpoint === body.endpoint) || (body.deviceId && d.id === body.deviceId));
      if (removed) saveState();
      res.writeHead(200);
      return res.end(JSON.stringify({ ...accountPayload(body.accountId), removed }));
    }

    // POST /public/device-code { accountId } — a one-time code that signs an
    // iPhone's Home Screen app in to this account (that app starts with
    // storage of its own). Good for one use within 30 minutes.
    if (req.method === 'POST' && req.url === '/public/device-code') {
      const body = await readBody(req);
      if (!webAccounts[body.accountId || '']) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Unknown account.' }));
      }
      const mine = Object.values(deviceCodes).filter(c => c.accountId === body.accountId);
      if (mine.length >= 10) {
        res.writeHead(429);
        return res.end(JSON.stringify({ error: 'Too many links today — use one you already have.' }));
      }
      const code = crypto.randomBytes(18).toString('base64url');
      deviceCodes[code] = { accountId: body.accountId, created: Date.now() };
      saveState();
      res.writeHead(200);
      return res.end(JSON.stringify({ code }));
    }

    // POST /public/device-redeem { code } — the Home Screen app collects the account
    if (req.method === 'POST' && req.url === '/public/device-redeem') {
      const body = await readBody(req);
      const c = typeof body.code === 'string' && deviceCodes[body.code];
      if (c) delete deviceCodes[body.code];
      if (!c || Date.now() - c.created > DEVICE_CODE_TTL || !webAccounts[c.accountId]) {
        if (c) saveState();
        res.writeHead(410);
        return res.end(JSON.stringify({ error: 'That link has been used or has expired.' }));
      }
      saveState();
      res.writeHead(200, { 'Set-Cookie': acctCookie(c.accountId) });
      return res.end(JSON.stringify(accountPayload(c.accountId)));
    }

    // POST /public/subscribe — join a topic's group { accountId, zinvite }
    if (req.method === 'POST' && req.url === '/public/subscribe') {
      const body = await readBody(req);
      const acct = webAccounts[body.accountId];
      if (!acct) {
        res.writeHead(403);
        return res.end(JSON.stringify({ error: 'Sign up first to follow topics.' }));
      }
      if (!body.zinvite || !/^[0-9a-z]+$/i.test(body.zinvite)) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'zinvite required' }));
      }
      acct.subs = acct.subs || [];
      if (!acct.subs.includes(body.zinvite)) acct.subs.push(body.zinvite);
      // WhatsApp members also get the legacy per-phone subscription so the
      // DM flow stays in sync.
      if (wa && acct.channel === 'whatsapp') wa.setSubscribed(acct.contact, true);
      saveState();
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, subs: acct.subs }));
    }

    // POST /public/unsubscribe { accountId, zinvite?|all }  and
    // GET  /public/unsubscribe?account=..&z=..|all=1   (email footer links)
    if (req.url?.startsWith('/public/unsubscribe')) {
      let accountId, zinvite, all;
      if (req.method === 'POST') {
        const body = await readBody(req);
        accountId = body.accountId; zinvite = body.zinvite; all = body.all;
        if (!accountId) {
          const q = new URL(req.url, PUBLIC_URL).searchParams;
          accountId = q.get('account'); zinvite = q.get('z'); all = q.get('all');
        }
      } else {
        const q = new URL(req.url, PUBLIC_URL).searchParams;
        accountId = q.get('account'); zinvite = q.get('z'); all = q.get('all');
      }
      const acct = webAccounts[accountId];
      const html = req.method === 'GET';
      if (!acct) {
        res.writeHead(404, html ? { 'Content-Type': 'text/html' } : undefined);
        return res.end(html ? '<p>Unknown account.</p>' : JSON.stringify({ error: 'unknown account' }));
      }
      if (all) {
        acct.subs = [];
        acct.allTopics = false;
        if (wa && acct.channel === 'whatsapp') wa.setSubscribed(acct.contact, false);
      } else if (zinvite) {
        acct.subs = (acct.subs || []).filter(z => z !== zinvite);
      }
      saveState();
      if (html) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center"><h2>You're unsubscribed.</h2><p>${all ? 'You won’t get any more updates.' : 'No more updates for that topic.'}</p><p><a href="${PUBLIC_URL}/">Back to the forum</a></p></body>`);
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, subs: acct.subs }));
    }

    // POST /public/create — community topic creation
    // { topic, description?, statements?: string[], website: honeypot }
    if (req.method === 'POST' && req.url === '/public/create') {
      const body = await readBody(req);
      const ip = clientIp(req);

      // Honeypot: bots fill every field. Pretend it worked.
      if (body.website) {
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true }));
      }

      const topic = cleanText(body.topic, 140, true);
      const description = cleanText(body.description, 600, false);
      const statements = (Array.isArray(body.statements) ? body.statements : [])
        .map(s => cleanText(s, 140, true))
        .filter(s => s.length >= 5)
        .slice(0, 5);

      if (topic.length < 8) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Please give your topic a title of at least 8 characters.' }));
      }
      if (/^test/i.test(topic) || /^(mon|tue|wed|thu|fri|sat|sun),\s/i.test(topic)) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'That title isn’t allowed — please pick a more descriptive one.' }));
      }

      const blocked = publicCreateBlocked(ip);
      if (blocked) {
        res.writeHead(429);
        return res.end(JSON.stringify({ error: blocked }));
      }
      // Reserve the rate-limit slot NOW — concurrent requests would otherwise
      // all pass the check before any of them records an entry.
      publicCreateLog.push({ ts: Date.now(), ip });

      const result = await polisRequest('POST', '/api/v3/conversations', {
        topic,
        description,
        is_active: true,
        is_public: true,
        is_anon: false,
        auth_needed_to_vote: false,
        auth_needed_to_write: false,
      }, adminToken);

      if (result.status !== 200 && result.status !== 302) {
        console.error('Public create failed:', result.status, JSON.stringify(result.data).slice(0, 300));
        res.writeHead(502);
        return res.end(JSON.stringify({ error: 'Could not create the topic right now — please try again.' }));
      }

      const zinvite = result.data.conversation_id;
      let seeded = 0;
      for (const text of statements) {
        const seedRes = await polisRequest('POST', '/api/v3/comments', {
          conversation_id: zinvite,
          txt: text,
          is_seed: true,
          vote: 0,
        }, adminToken);
        if (seedRes.status === 200) seeded++;
      }

      const creatorKey = crypto.randomBytes(16).toString('base64url');
      communityTopics[zinvite] = { creatorKey, ip, created: new Date().toISOString() };
      conversationCommentCounts[zinvite] = seeded;

      // Creator with an account: auto-join their topic's group
      if (body.accountId && webAccounts[body.accountId]) {
        const acct = webAccounts[body.accountId];
        acct.subs = acct.subs || [];
        if (!acct.subs.includes(zinvite)) acct.subs.push(zinvite);
        communityTopics[zinvite].accountId = body.accountId;
      }
      saveState();
      console.log(`Public topic created: ${zinvite} "${topic}" (${seeded} seeds) from ${ip}`);

      // Alert members who asked to hear about every new topic
      setImmediate(async () => {
        // WhatsApp: ask WireClaw for the topic's subgroup, post to Announcements
        if (wa) {
          wa.syncTopicGroups([{ zinvite, topic }]);
          wa.announce(`🆕 *New community topic:* ${topic}\n${description ? `\n_${description.slice(0, 150)}_\n` : ''}\nFind its discussion group in this community, or vote anonymously at ${topicUrl(zinvite, topic)}`);
        }
        for (const [accountId, acct] of Object.entries(webAccounts)) {
          if (!acct.allTopics || acct.verified === false || accountId === body.accountId) continue;
          const waTo = acctWhatsapp(acct);
          if (waTo) {
            wa.alert(waTo, zinvite, topic, `🆕 *New community topic:* ${topic}\n${description ? `\n_${description.slice(0, 150)}_\n` : ''}\nReply *vote* to vote on it now, or *topics* to see everything open.`);
          }
          await pushToAccount(accountId, acct, {
            title: `New topic: ${topic}`,
            body: description ? description.slice(0, 150) : 'A neighbor opened a new topic. Tap to read and vote.',
            url: topicUrl(zinvite, topic),
            tag: `t-${zinvite}`,
          });
          if (acctEmail(acct)) {
            await sendEmail(
              acctEmail(acct),
              `New topic: ${topic} — Croton Community Forum`,
              `A neighbor just opened a new topic:\n\n${topic}\n${description ? '\n' + description + '\n' : ''}\nVote here: ${topicUrl(zinvite, topic)}\n\n—\nCroton Community Forum · ${PUBLIC_URL}\nUnsubscribe from everything: ${unsubscribeLink(accountId, null)}`,
              unsubscribeLink(accountId, null),
              null,
              emailShell('🆕 A neighbor opened a new topic',
                emailQuote(topic) +
                (description ? `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#444;">${escHtml(description)}</p>` : '') +
                emailButton('Read & vote →', topicUrl(zinvite, topic)),
                `<a href="${unsubscribeLink(accountId, null)}" style="color:#8a887f;">Unsubscribe from everything</a><br>`)
            );
          }
        }
        saveState();
      });

      res.writeHead(200);
      return res.end(JSON.stringify({
        zinvite,
        url: topicUrl(zinvite, topic),
        slug: ensureSlug(zinvite, topic),
        topic,
        seeded,
        creatorKey,
      }));
    }

    // POST /public/close — creator closes their own topic { zinvite, key }
    if (req.method === 'POST' && req.url === '/public/close') {
      const body = await readBody(req);
      const record = communityTopics[body.zinvite];
      if (!record || !body.key || record.creatorKey !== body.key) {
        res.writeHead(403);
        return res.end(JSON.stringify({ error: 'Only the person who created this topic can close it.' }));
      }
      const result = await polisRequest('PUT', '/api/v3/conversations', {
        conversation_id: body.zinvite,
        is_active: false,
      }, adminToken);
      if (result.status !== 200) {
        console.error('Public close failed:', result.status, JSON.stringify(result.data).slice(0, 300));
        res.writeHead(502);
        return res.end(JSON.stringify({ error: 'Could not close the topic right now — please try again.' }));
      }
      record.closed = new Date().toISOString();
      saveState();
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, zinvite: body.zinvite }));
    }

    // Root-level readable topic URLs (nginx routes single-segment lowercase
    // paths here). Unknown names pass through to the Polis server so admin
    // console routes like /home and /signin keep working.
    const rootMatch = urlPath.match(/^\/([a-z0-9-]+)$/);
    if (rootMatch) {
      const z = topicSlugs[rootMatch[1]];
      if (z && (req.method === 'GET' || req.method === 'HEAD')) {
        // Topic pages ARE the landing page in single-topic mode
        res.writeHead(200, { 'X-Accel-Redirect': '/_topic', 'Content-Type': 'text/html; charset=utf-8' });
        return res.end();
      }
      res.writeHead(200, { 'X-Accel-Redirect': `/_polis/${rootMatch[1]}${urlQuery}` });
      return res.end();
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    console.error('Server error:', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

// Loopback only — consumers (router, wireclaw) are all local, and these
// endpoints are unauthenticated (admin actions + resident phone numbers).
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Polis API proxy + voting handler listening on 127.0.0.1:${PORT}`);
});
