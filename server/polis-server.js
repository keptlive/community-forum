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

const PORT = parseInt(process.env.PORT || '9876', 10);

// --- Branding / endpoints (single place to change for a rebrand) ---
// PUBLIC_URL: what users see in links. POLIS_URL: where API calls actually go
// (local HTTP to the docker-published server port, so an expired/renamed public
// cert can never silently break voting again).
const BRAND_NAME = process.env.BRAND_NAME || 'Community Forum';
const PUBLIC_URL = process.env.POLIS_PUBLIC_URL || 'https://forum.example.org';
const POLIS_URL = process.env.POLIS_API_URL || 'http://127.0.0.1:5000';
const KEY_PATH = process.env.POLIS_JWT_KEY || path.join(__dirname, 'jwt-private.pem');
const ADMIN_UID = parseInt(process.env.POLIS_ADMIN_UID || '2', 10);
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'voting-state.json');

// --- Per-user voting state ---
// { phone: { zinvite, token, pid, lastTid, lastStatement, phase, subscribed } }
// phase: 'idle' | 'voting' | 'writing'
let userState = {};

// Pending DM notifications for WireClaw to pick up
let pendingNotifications = [];

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

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      userState = data.userState || data;
      conversationCommentCounts = data.conversationCommentCounts || {};
      pendingNotifications = data.pendingNotifications || [];
      communityTopics = data.communityTopics || {};
      webAccounts = data.webAccounts || {};
      topicSlugs = data.topicSlugs || {};
      console.log(`Loaded state for ${Object.keys(userState).length} users`);
    }
  } catch (e) {
    console.error('Failed to load state:', e.message);
    userState = {};
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      userState,
      conversationCommentCounts,
      pendingNotifications,
      communityTopics,
      webAccounts,
      topicSlugs,
    }, null, 2));
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

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
    iss: `${PUBLIC_URL}/`,
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

// --- Polis XID helpers ---

// Initialize a user for a conversation via XID (phone number)
// Returns { token, pid, nextComment, conversation }
async function initUserForConversation(phone, zinvite) {
  const result = await polisRequest(
    'GET',
    `/api/v3/participationInit?conversation_id=${zinvite}&xid=${encodeURIComponent(phone)}`,
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
    vote: voteValue, // -1=disagree, 0=pass, 1=agree
  }, token);

  if (result.status !== 200) {
    throw new Error(`Vote failed: ${result.status}`);
  }
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
  let base = slugify(topic), slug = base, n = 2;
  while (topicSlugs[slug]) slug = `${base}-${n++}`;
  topicSlugs[slug] = zinvite;
  saveState();
  return slug;
}

function topicUrl(zinvite, topic) {
  return topic ? `${PUBLIC_URL}/t/${ensureSlug(zinvite, topic)}` : `${PUBLIC_URL}/${zinvite}`;
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

function sendEmail(to, subject, text, unsubUrl) {
  return new Promise((resolve) => {
    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      console.error('Email not configured (MAILGUN_API_KEY/MAILGUN_DOMAIN missing)');
      return resolve(false);
    }
    const fields = { from: EMAIL_FROM, to, subject, text };
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
    .filter(([, a]) => (a.subs || []).includes(zinvite));
}

function unsubscribeLink(accountId, zinvite) {
  return `${PUBLIC_URL}/public/unsubscribe?account=${accountId}${zinvite ? `&z=${zinvite}` : '&all=1'}`;
}

// Fan a message out to a topic's group (its followers).
// skipPhones: phones already notified via the legacy per-phone subscription.
async function notifyGroup(zinvite, topic, message, skipPhones, subject) {
  const skip = new Set(skipPhones || []);
  for (const [accountId, acct] of accountsFollowing(zinvite)) {
    if (acct.channel === 'whatsapp') {
      if (skip.has(acct.contact)) continue;
      // Point their DM session at this topic if they aren't mid-conversation,
      // so a bare "vote" reply lands in the right place.
      const st = userState[acct.contact] || { phase: 'idle' };
      if (!st.zinvite || st.phase === 'idle') { st.zinvite = zinvite; st.topic = topic; }
      userState[acct.contact] = st;
      pendingNotifications.push({
        phone: acct.contact,
        text: `${message}\n\nReply *vote* to vote now, or *unsubscribe* to stop updates.`,
      });
      skip.add(acct.contact);
    } else if (acct.channel === 'email') {
      await sendEmail(
        acct.contact,
        subject || `${topic} — Croton Community Forum`,
        `${message.replace(/\*/g, '')}\n\nVote here: ${topicUrl(zinvite, topic)}\n\n—\nCroton Community Forum · ${PUBLIC_URL}\nUnsubscribe from this topic: ${unsubscribeLink(accountId, zinvite)}\nUnsubscribe from everything: ${unsubscribeLink(accountId, null)}`,
        unsubscribeLink(accountId, zinvite)
      );
    }
  }
}

// --- WhatsApp voting handler ---

function formatStatement(comment, remaining, total) {
  const voted = total - remaining;
  return `📊 *Statement ${voted + 1} of ${total}:*\n\n"${comment.txt}"\n\nReply:\n👍 *agree* — 👎 *disagree* — ⏭️ *skip*`;
}

function formatTopicList(conversations) {
  if (conversations.length === 0) {
    return '📭 No active topics right now. Check back later!';
  }
  let msg = '🗳️ *Active Community Topics*\n\n';
  conversations.forEach((c, i) => {
    msg += `*${i + 1}.* ${c.topic}\n`;
    if (c.description) msg += `   _${c.description.slice(0, 80)}${c.description.length > 80 ? '...' : ''}_\n`;
    msg += '\n';
  });
  msg += 'Reply with the *number* to start voting, or type *"new"* to write your own statement.';
  return msg;
}

function formatWelcome() {
  return `👋 *Welcome to ${BRAND_NAME}!*\n\nHere you can vote on community topics and share your own opinions — all through WhatsApp.\n\nType *topics* to see what's being discussed.`;
}

// Handle a DM message from a user in the voting flow
async function handleDM(phone, name, text) {
  const responses = []; // Array of { text } to send back as DMs
  const trimmed = text.trim().toLowerCase();
  const state = userState[phone] || { phase: 'idle' };

  try {
    // --- Commands that work in any phase ---
    if (trimmed === 'topics' || trimmed === 'menu' || trimmed === 'help' || trimmed === 'start') {
      const convos = await getActiveConversations();
      state.phase = 'choosing';
      state.conversations = convos;
      userState[phone] = state;
      saveState();
      responses.push({ text: formatTopicList(convos) });
      return responses;
    }

    if (trimmed === 'stop' || trimmed === 'quit' || trimmed === 'exit') {
      delete userState[phone];
      saveState();
      responses.push({ text: '👋 You\'ve left the voting session. Type *topics* anytime to come back.' });
      return responses;
    }

    if (trimmed === 'subscribe' || trimmed === 'notify' || trimmed === 'notifications on') {
      state.subscribed = true;
      userState[phone] = state;
      saveState();
      responses.push({ text: '🔔 *Subscribed!* I\'ll DM you when new statements are available to vote on.\n\nType *unsubscribe* to stop.' });
      return responses;
    }

    if (trimmed === 'unsubscribe' || trimmed === 'notifications off') {
      state.subscribed = false;
      userState[phone] = state;
      // Also clear any web-hub group memberships tied to this phone
      for (const acct of Object.values(webAccounts)) {
        if (acct.channel === 'whatsapp' && acct.contact === phone) {
          acct.subs = [];
          acct.allTopics = false;
        }
      }
      saveState();
      responses.push({ text: '🔕 *Unsubscribed.* You won\'t get notifications for new statements.\n\nType *subscribe* to turn them back on.' });
      return responses;
    }

    if (trimmed === 'status') {
      if (state.zinvite && state.token) {
        const init = await initUserForConversation(phone, state.zinvite);
        const voted = init.votes ? init.votes.length : 0;
        const total = init.nextComment ? voted + init.nextComment.remaining + 1 : voted;
        responses.push({ text: `📊 *Your progress:* ${voted}/${total} statements voted on\n\nTopic: _${state.topic || 'Unknown'}_\n\nType *vote* to continue or *topics* to switch.` });
      } else {
        responses.push({ text: 'You\'re not in a voting session. Type *topics* to get started.' });
      }
      return responses;
    }

    // --- Phase: choosing a topic ---
    if (state.phase === 'choosing') {
      const num = parseInt(trimmed);
      if (num >= 1 && num <= (state.conversations || []).length) {
        const chosen = state.conversations[num - 1];
        const init = await initUserForConversation(phone, chosen.zinvite);
        state.zinvite = chosen.zinvite;
        state.topic = chosen.topic;
        state.token = init.token;
        state.pid = init.pid;
        state.phase = 'voting';
        userState[phone] = state;
        saveState();

        if (init.nextComment) {
          state.lastTid = init.nextComment.tid;
          state.lastStatement = init.nextComment.txt;
          saveState();
          responses.push({ text: `✅ *Topic:* ${chosen.topic}\n\n${formatStatement(init.nextComment, init.nextComment.remaining, init.nextComment.total)}` });
        } else {
          responses.push({ text: `✅ *Topic:* ${chosen.topic}\n\n🎉 You've voted on all statements! Type *new* to write your own, or *topics* for another topic.\n\n🔔 Type *subscribe* to get notified when new statements are added.` });
          state.phase = 'idle';
          saveState();
        }
        return responses;
      }
      // Not a valid number
      responses.push({ text: 'Please reply with a topic number, or type *topics* to see the list again.' });
      return responses;
    }

    // --- Phase: voting ---
    if (state.phase === 'voting' && state.token && state.lastTid !== undefined) {
      let voteValue = null;
      if (['agree', 'yes', 'a', '👍', 'y', '1'].includes(trimmed)) voteValue = 1;
      else if (['disagree', 'no', 'd', '👎', 'n', '-1'].includes(trimmed)) voteValue = -1;
      else if (['skip', 'pass', 's', '⏭️', '⏭', 'p', '0'].includes(trimmed)) voteValue = 0;
      else if (trimmed === 'new' || trimmed === 'write') {
        state.phase = 'writing';
        userState[phone] = state;
        saveState();
        responses.push({ text: '✏️ *Write your statement*\n\nType your opinion as a single message. Good statements:\n- Start with "I think..." or "The village should..."\n- Are under 140 characters\n- Express one clear idea\n\nType *cancel* to go back to voting.' });
        return responses;
      }

      if (voteValue !== null) {
        const result = await vote(state.token, state.zinvite, state.lastTid, voteValue);
        const label = voteValue === 1 ? '👍 Agreed' : voteValue === -1 ? '👎 Disagreed' : '⏭️ Skipped';

        if (result.nextComment) {
          state.lastTid = result.nextComment.tid;
          state.lastStatement = result.nextComment.txt;
          saveState();
          responses.push({ text: `${label}\n\n${formatStatement(result.nextComment, result.nextComment.remaining, result.nextComment.total)}` });
        } else {
          state.lastTid = undefined;
          state.lastStatement = undefined;
          state.phase = 'idle';
          saveState();
          responses.push({ text: `${label}\n\n🎉 *You've voted on all statements!*\n\nType *new* to write your own statement, or *topics* for another topic.\n\n🔔 Type *subscribe* to get notified when new statements are added.` });
        }
        return responses;
      }

      // Unrecognized vote input
      responses.push({ text: 'Reply *agree*, *disagree*, or *skip* to vote.\nOr type *new* to write your own statement.' });
      return responses;
    }

    // --- Phase: writing a statement ---
    if (state.phase === 'writing' && state.token) {
      if (trimmed === 'cancel' || trimmed === 'back') {
        state.phase = 'voting';
        userState[phone] = state;
        saveState();
        // Re-init to get the next comment
        const init = await initUserForConversation(phone, state.zinvite);
        if (init.nextComment) {
          state.lastTid = init.nextComment.tid;
          state.lastStatement = init.nextComment.txt;
          saveState();
          responses.push({ text: `Back to voting!\n\n${formatStatement(init.nextComment, init.nextComment.remaining, init.nextComment.total)}` });
        } else {
          responses.push({ text: 'Back to voting — but you\'ve voted on everything! Type *topics* for another topic.' });
        }
        return responses;
      }

      // Submit the statement
      const result = await submitComment(state.token, state.zinvite, text.trim());
      state.phase = 'voting';
      userState[phone] = state;
      saveState();

      // Get next comment
      const init = await initUserForConversation(phone, state.zinvite);
      let followUp = '';
      if (init.nextComment) {
        state.lastTid = init.nextComment.tid;
        state.lastStatement = init.nextComment.txt;
        saveState();
        followUp = `\n\n${formatStatement(init.nextComment, init.nextComment.remaining, init.nextComment.total)}`;
      }
      responses.push({ text: `✅ *Statement submitted!* It will appear for others to vote on after moderation.${followUp}` });
      return responses;
    }

    // --- Phase: idle or first contact ---
    if (trimmed === 'vote' && state.zinvite && state.token) {
      // Resume voting in current topic
      const init = await initUserForConversation(phone, state.zinvite);
      if (init.token) {
        state.token = init.token;
      }
      if (init.nextComment) {
        state.phase = 'voting';
        state.lastTid = init.nextComment.tid;
        state.lastStatement = init.nextComment.txt;
        userState[phone] = state;
        saveState();
        responses.push({ text: formatStatement(init.nextComment, init.nextComment.remaining, init.nextComment.total) });
      } else {
        responses.push({ text: '🎉 You\'ve voted on all statements in this topic! Type *topics* for another topic.' });
      }
      return responses;
    }

    if (trimmed === 'new' || trimmed === 'write') {
      if (state.zinvite && state.token) {
        state.phase = 'writing';
        userState[phone] = state;
        saveState();
        responses.push({ text: '✏️ *Write your statement*\n\nType your opinion as a single message.\n\nType *cancel* to go back.' });
        return responses;
      }
      responses.push({ text: 'Pick a topic first. Type *topics* to see active discussions.' });
      return responses;
    }

    // Default: show welcome/help
    responses.push({ text: formatWelcome() });
    return responses;

  } catch (err) {
    console.error('DM handler error:', err.message);
    responses.push({ text: '⚠️ Something went wrong. Type *topics* to start over.' });
    return responses;
  }
}

// Handle a group message (show topics, instructions)
// Responses can have { text } (reply in group) or { text, dmPhone } (send as DM)
async function handleGroup(phone, name, text) {
  const responses = [];
  const trimmed = text.trim().toLowerCase();

  try {
    if (trimmed === 'topics' || trimmed === 'vote' || trimmed === 'start') {
      const convos = await getActiveConversations();
      // Store conversations for this user so they can pick by number
      userState[phone] = userState[phone] || { phase: 'idle' };
      userState[phone].conversations = convos;
      userState[phone].phase = 'choosing';
      saveState();

      let msg = '🗳️ *Active Community Topics*\n\n';
      convos.forEach((c, i) => {
        msg += `*${i + 1}.* ${c.topic}\n`;
      });
      msg += '\nReply with the *number* to start voting.';
      responses.push({ text: msg });
      return responses;
    }

    // User picks a topic number — initiate DM with first statement
    const state = userState[phone] || {};
    if (state.phase === 'choosing' && state.conversations) {
      const num = parseInt(trimmed);
      if (num >= 1 && num <= state.conversations.length) {
        const chosen = state.conversations[num - 1];
        const init = await initUserForConversation(phone, chosen.zinvite);
        state.zinvite = chosen.zinvite;
        state.topic = chosen.topic;
        state.token = init.token;
        state.pid = init.pid;
        state.phase = 'voting';
        state.subscribed = true; // Auto-subscribe when picking a topic
        userState[phone] = state;
        saveState();

        // Reply in group confirming
        responses.push({ text: `✅ *${name || 'You'}* — check your DMs! Voting on: _${chosen.topic}_` });

        // DM the user with the first statement
        if (init.nextComment) {
          state.lastTid = init.nextComment.tid;
          state.lastStatement = init.nextComment.txt;
          saveState();
          responses.push({
            text: `🗳️ *Topic:* ${chosen.topic}\n\n${formatStatement(init.nextComment, init.nextComment.remaining, init.nextComment.total)}`,
            dmPhone: phone,
          });
        } else {
          responses.push({
            text: `🗳️ *Topic:* ${chosen.topic}\n\n🎉 You've already voted on all statements! Type *new* to write your own.`,
            dmPhone: phone,
          });
        }
        return responses;
      }
    }

    // Any other message — brief help
    responses.push({ text: '🗳️ Type *topics* to see active discussions and start voting!' });
    return responses;

  } catch (err) {
    console.error('Group handler error:', err.message);
    responses.push({ text: '⚠️ Something went wrong. Try again.' });
    return responses;
  }
}

// --- New statement notification checker ---

async function checkForNewStatements() {
  try {
    const convos = await getActiveConversations();
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

        // Legacy per-phone subscriptions (WhatsApp DM flow)
        const notifiedPhones = [];
        for (const [phone, state] of Object.entries(userState)) {
          if (state.subscribed && state.zinvite === conv.zinvite) {
            pendingNotifications.push({
              phone,
              text: `🔔 *${newCount} new statement${newCount > 1 ? 's' : ''}* to vote on!\n\n_${conv.topic}_\n\nType *vote* to continue voting.`,
            });
            notifiedPhones.push(phone);
          }
        }

        // Web hub groups (email + WhatsApp followers), deduped against above
        await notifyGroup(
          conv.zinvite,
          conv.topic,
          `🔔 *${newCount} new statement${newCount > 1 ? 's' : ''}* to vote on in "${conv.topic}"`,
          notifiedPhones,
          `${newCount} new statement${newCount > 1 ? 's' : ''} to vote on: ${conv.topic}`
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
// Initial check after 30s (let server start up)
setTimeout(checkForNewStatements, 30000);

// --- HTTP Server ---

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  try {
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

    // POST /wa/group — handle group message
    if (req.method === 'POST' && req.url === '/wa/group') {
      const body = await readBody(req);
      if (!body.phone || !body.text) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'phone and text required' }));
      }
      const responses = await handleGroup(body.phone, body.name || '', body.text);
      res.writeHead(200);
      return res.end(JSON.stringify({ responses }));
    }

    // POST /wa/dm — handle DM message
    if (req.method === 'POST' && req.url === '/wa/dm') {
      const body = await readBody(req);
      if (!body.phone || !body.text) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'phone and text required' }));
      }
      const responses = await handleDM(body.phone, body.name || '', body.text);
      res.writeHead(200);
      return res.end(JSON.stringify({ responses }));
    }

    // GET /wa/pending-notifications — returns and clears pending DM notifications
    if (req.method === 'GET' && req.url === '/wa/pending-notifications') {
      const notifications = pendingNotifications.splice(0);
      if (notifications.length) saveState();
      res.writeHead(200);
      return res.end(JSON.stringify({ notifications }));
    }

    // POST /wa/notify — accept notifications from external services (e.g., router)
    if (req.method === "POST" && req.url === "/wa/notify") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        try {
          const n = JSON.parse(body);
          if (n.phone && n.text) {
            pendingNotifications.push({ phone: n.phone, text: n.text });
            saveState();
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "phone and text required" }));
          }
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "invalid JSON" }));
        }
      });
      return;
    }

    // GET /wa/state/:phone — get user's voting state (used by the router
    // bridge to detect active sessions). WhatsApp identities aren't always
    // bare digits — LID users arrive as "12345…@lid" — so accept any single
    // path segment.
    const stateMatch = req.url?.match(/^\/wa\/state\/([^/]+)$/);
    if (req.method === 'GET' && stateMatch) {
      const phone = decodeURIComponent(stateMatch[1]);
      res.writeHead(200);
      return res.end(JSON.stringify(userState[phone] || { phase: 'idle' }));
    }

    // --- Public web hub routes (the ONLY ones nginx exposes to the internet) ---

    // GET /t/:slug — human-readable topic URL, redirects to the voting page
    const slugMatch = req.url?.match(/^\/t\/([a-z0-9-]+)$/);
    if (req.method === 'GET' && slugMatch) {
      const zinvite = topicSlugs[slugMatch[1]];
      if (zinvite) {
        res.writeHead(301, { Location: `${PUBLIC_URL}/alpha/${zinvite}` });
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

    // POST /public/account — lightweight signup: display name + notification
    // channel. No passwords; the accountId returned is the bearer credential
    // and lives in the member's browser.
    if (req.method === 'POST' && req.url === '/public/account') {
      const body = await readBody(req);
      if (body.website) { res.writeHead(200); return res.end(JSON.stringify({ ok: true })); }
      const name = cleanText(body.name, 60, true);
      const channel = body.channel === 'whatsapp' ? 'whatsapp' : 'email';
      let contact = cleanText(body.contact, 120, true);

      if (channel === 'email') {
        contact = contact.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contact)) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Please enter a valid email address.' }));
        }
      } else {
        contact = contact.replace(/[^\d]/g, '');
        if (contact.length === 10) contact = '1' + contact; // assume US
        if (contact.length < 11 || contact.length > 15) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Please enter a valid WhatsApp number (with area code).' }));
        }
      }

      // Same contact = same account (keeps follows when someone re-registers)
      let accountId = Object.keys(webAccounts)
        .find(id => webAccounts[id].channel === channel && webAccounts[id].contact === contact);
      if (!accountId) {
        accountId = crypto.randomBytes(16).toString('base64url');
        webAccounts[accountId] = {
          name, channel, contact,
          subs: [],
          allTopics: !!body.allTopics,
          created: new Date().toISOString(),
        };
      } else {
        if (name) webAccounts[accountId].name = name;
        if (body.allTopics !== undefined) webAccounts[accountId].allTopics = !!body.allTopics;
      }
      // Channel switch: the browser passes its previous accountId — migrate
      // its follows to this account and retire the old one, so nobody keeps
      // getting notifications on a channel they moved away from.
      const prev = body.previousAccountId && webAccounts[body.previousAccountId];
      if (prev && body.previousAccountId !== accountId) {
        const acct = webAccounts[accountId];
        acct.subs = [...new Set([...(acct.subs || []), ...(prev.subs || [])])];
        if (prev.allTopics && body.allTopics === undefined) acct.allTopics = true;
        prev.subs = [];
        prev.allTopics = false;
      }
      saveState();
      res.writeHead(200);
      return res.end(JSON.stringify({
        accountId,
        name: webAccounts[accountId].name,
        channel,
        allTopics: webAccounts[accountId].allTopics,
        subs: webAccounts[accountId].subs,
      }));
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
      // existing DM flow stays in sync.
      if (acct.channel === 'whatsapp') {
        const st = userState[acct.contact] || { phase: 'idle' };
        st.subscribed = true;
        userState[acct.contact] = st;
      }
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
        if (acct.channel === 'whatsapp' && userState[acct.contact]) {
          userState[acct.contact].subscribed = false;
        }
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
      publicCreateLog.push({ ts: Date.now(), ip });

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
        for (const [accountId, acct] of Object.entries(webAccounts)) {
          if (!acct.allTopics || accountId === body.accountId) continue;
          if (acct.channel === 'whatsapp') {
            pendingNotifications.push({
              phone: acct.contact,
              text: `🆕 *New community topic:* ${topic}\n\nType *topics* to see it and vote.`,
            });
          } else {
            await sendEmail(
              acct.contact,
              `New topic: ${topic} — Croton Community Forum`,
              `A neighbor just opened a new topic:\n\n${topic}\n${description ? '\n' + description + '\n' : ''}\nVote here: ${topicUrl(zinvite, topic)}\n\n—\nCroton Community Forum · ${PUBLIC_URL}\nUnsubscribe from everything: ${unsubscribeLink(accountId, null)}`,
              unsubscribeLink(accountId, null)
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
