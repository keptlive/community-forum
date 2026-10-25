// petitions.js — digital petitions for the community forum hub.
//
// A petition is deliberately NOT a Polis topic. A topic maps opinion and its
// voting is private; a petition is an attributed public ask — you put your
// name to a fixed statement. They are different objects with opposite privacy
// properties, so they get their own store, their own routes and their own
// page rather than being bolted onto the conversation model.
//
// Shape of the thing:
//   * anyone with a verified forum account can start a petition
//   * anyone can sign online — the signature counts only after they click a
//     confirm link emailed to them
//   * a petition prints to a paper signature sheet, so the same petition can
//     be carried door to door and at the farmers market
//   * collectors upload photos of their filled sheets to a shared tally
//   * uploaded sheets are PRIVATE by default (a sheet is a page of neighbors'
//     home addresses); an organizer can publish a copy only after painting
//     redaction boxes over the names and addresses in the browser
//
// Signature records hold real names, street addresses and email addresses, so
// they live in their own 0600 file, never in voting-state.json (which is
// world-readable in backups and dumped wholesale by other tooling).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let qrcode = null;
try { qrcode = require('qrcode-generator'); } catch { /* QR is optional */ }

let ctx = null;
let DATA_DIR = null;
let STORE_FILE = null;
let UPLOAD_DIR = null;

// petitions: id -> petition
// signatures: petitionId -> [signature]
// sheets: petitionId -> [sheet]
// pending: token -> unconfirmed signature
let store = { petitions: {}, signatures: {}, sheets: {}, pending: {} };

// hashed IP -> [timestamps], for the sign and create throttles
const signLog = {};
const createLog = {};

const MAX_UPLOAD = 12 * 1024 * 1024;
const PENDING_TTL = 7 * 24 * 3600000;

// ---------------------------------------------------------------- storage

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
      store = {
        petitions: data.petitions || {},
        signatures: data.signatures || {},
        sheets: data.sheets || {},
        pending: data.pending || {},
      };
      // Signatures taken in person on a collector's device were first filed as
      // 'paper'. They aren't: we hold the drawing, so the record is digital.
      // Only ink on an actual sheet is paper.
      let moved = 0;
      for (const list of Object.values(store.signatures)) {
        for (const s of list) {
          if (s.inPerson && s.source === 'paper') { s.source = 'web'; moved++; }
        }
      }
      if (moved) { console.log(`Reclassified ${moved} in-person signature(s) as digital`); saveStore(); }
      console.log(`Loaded ${Object.keys(store.petitions).length} petitions`);
    }
  } catch (e) {
    console.error('Failed to load petitions:', e.message);
    try {
      fs.copyFileSync(STORE_FILE, `${STORE_FILE}.corrupt-${Date.now()}`);
    } catch {}
  }
}

// Returns false if the store could not be written. Callers that have just
// accepted a signature MUST check it: telling somebody "signed" when the record
// did not reach disk loses their signature silently at the next restart, and a
// full disk is exactly when that happens.
function saveStore() {
  try {
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STORE_FILE);
    return true;
  } catch (e) {
    console.error('CRITICAL: failed to save petitions store:', e.message);
    return false;
  }
}

function prunePending() {
  const now = Date.now();
  let changed = false;
  for (const [tok, p] of Object.entries(store.pending)) {
    // A pending whose address has since signed can never become a signature —
    // the confirm handler would refuse it as a duplicate. Drop it now rather
    // than leave someone's drawing sitting on disk for a week.
    const pet = store.petitions[p.petitionId];
    const superseded = pet && sigs(pet).some(s => s.email && s.email === p.email && s.confirmed);
    if (superseded || now - (p.created || 0) > PENDING_TTL) {
      // Take the unconfirmed signature drawing with it — an abandoned signup
      // must not leave someone's signature sitting on disk forever.
      if (p.hasSignature) {
        try { fs.unlinkSync(path.join(UPLOAD_DIR, p.petitionId, `pending-${tok}.png`)); } catch {}
      }
      delete store.pending[tok];
      changed = true;
    }
  }
  if (changed) saveStore();
}

// ---------------------------------------------------------------- helpers

const id16 = () => crypto.randomBytes(12).toString('base64url');

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-').slice(0, 8).join('-')
    .slice(0, 60) || 'petition';
}

function uniqueSlug(title) {
  const base = slugify(title);
  const taken = new Set(Object.values(store.petitions).map(p => p.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 500; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${id16().toLowerCase().slice(0, 6)}`;
}

function bySlug(slug) {
  return Object.values(store.petitions).find(p => p.slug === slug) || null;
}

function throttled(log, ipHash, limit, windowMs) {
  const now = Date.now();
  const hits = (log[ipHash] || []).filter(t => now - t < windowMs);
  log[ipHash] = hits;
  if (hits.length >= limit) return true;
  hits.push(now);
  return false;
}

function validEmail(s) {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(String(s || ''));
}

const sigs = p => store.signatures[p.id] || [];
const activeSigs = p => sigs(p).filter(s => !s.removed);
const shts = p => store.sheets[p.id] || [];

// Public totals, split by what kind of record exists — not by who was standing
// there. A signature drawn on a screen is a digital signature whether the
// signer was at home or holding a collector's phone at the market: either way
// we hold the actual mark. "Paper" means the record lives on paper — names read
// off a printed sheet, and the counts verified against photographed sheets.
// Unverified uploads are deliberately NOT in the public number: an unchecked
// photo is a claim, not a count.
function counts(p) {
  const live = activeSigs(p);
  const online = live.filter(s => s.source === 'web' && s.confirmed).length;
  const paper = live.filter(s => s.source === 'paper').length
    + shts(p).filter(s => s.status === 'counted').reduce((n, s) => n + (s.verifiedCount || 0), 0);
  return { online, paper, total: online + paper };
}

function isOwner(p, accountId) {
  return !!accountId && p.ownerAccountId === accountId;
}
function isCollector(p, accountId) {
  return !!accountId && (isOwner(p, accountId) || !!(p.collectors || {})[accountId]);
}

// The accountId is the bearer credential everywhere else in the hub; accept it
// from the body/query, but prefer the HttpOnly cookie when the browser has one.
function viewerAccount(req, given) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)forum_acct=([A-Za-z0-9_-]+)/);
  if (m && ctx.getAccount(m[1])) return m[1];
  if (given && ctx.getAccount(given)) return given;
  return null;
}

function petitionUrl(p) { return `${ctx.PUBLIC_URL}/p/${p.slug}`; }

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function html(res, status, body, extraHeaders) {
  res.writeHead(status, Object.assign({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  }, extraHeaders || {}));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let over = false;
    req.on('data', (c) => {
      data += c;
      if (data.length > 2 * 1024 * 1024) { over = true; data = ''; }
    });
    req.on('end', () => {
      if (over) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

function readRaw(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { req.destroy(); return reject(new Error('too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Minimal multipart/form-data reader. Node has no built-in one and the hub
// has no framework; this handles exactly what the upload form sends.
function parseMultipart(buf, boundary) {
  const parts = [];
  const bnd = Buffer.from('--' + boundary);
  let idx = buf.indexOf(bnd);
  while (idx !== -1) {
    const start = idx + bnd.length;
    if (buf.slice(start, start + 2).toString('latin1') === '--') break; // closing boundary
    const next = buf.indexOf(bnd, start);
    if (next === -1) break;
    const chunk = buf.slice(start + 2, next - 2); // strip the CRLF each side
    const hEnd = chunk.indexOf('\r\n\r\n');
    if (hEnd !== -1) {
      const head = chunk.slice(0, hEnd).toString('utf8');
      const nm = head.match(/name="([^"]*)"/);
      const fn = head.match(/filename="([^"]*)"/);
      const ct = head.match(/Content-Type:\s*([^\r\n]+)/i);
      parts.push({
        name: nm ? nm[1] : '',
        filename: fn ? fn[1] : null,
        contentType: ct ? ct[1].trim() : null,
        data: chunk.slice(hEnd + 4),
      });
    }
    idx = next;
  }
  return parts;
}

// Trust the bytes, not the declared Content-Type or the file extension.
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buf.length > 4 && buf.slice(0, 4).toString('latin1') === '%PDF') return { mime: 'application/pdf', ext: 'pdf' };
  return null;
}

function uploadPath(petitionId, file) {
  return path.join(UPLOAD_DIR, petitionId, file);
}

// Write a browser-drawn signature. These are the most sensitive artifacts the
// feature handles — a person's actual signature — so they are 0600, never
// served publicly, and never included in any public payload.
const MAX_SIG = 400 * 1024;
function savePngDataUrl(dataUrl, dest) {
  const m = String(dataUrl || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return false;
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length || buf.length > MAX_SIG) return false;
  const kind = sniff(buf);
  if (!kind || kind.ext !== 'png') return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(dest, buf, { mode: 0o600 });
  return true;
}

function unlinkQuiet(f) { try { fs.unlinkSync(f); } catch {} }

// A deliberately tiny formatter. The stored body stays plain text — it is what
// people sign, what goes into emails and what prints — but a petition is a
// letter, and a letter needs paragraphs, bullets and emphasis to read like one.
// Everything is escaped BEFORE any markup is introduced, so this can never turn
// a signer's or organizer's text into live HTML.
//   blank line -> paragraph    "- " / "• " line -> bullet    **text** -> bold
function formatBody(text, esc) {
  const bold = s => s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/)
    .map(block => {
      const lines = block.split('\n').filter(l => l.trim());
      if (!lines.length) return '';
      if (lines.every(l => /^\s*[-•]\s+/.test(l))) {
        return '<ul>' + lines
          .map(l => `<li>${bold(esc(l.replace(/^\s*[-•]\s+/, '')))}</li>`)
          .join('') + '</ul>';
      }
      return `<p>${bold(esc(lines.join('\n'))).replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
}

// "We, the undersigned…" is right above a bare statement and wrong above a
// letter that opens "Dear Mayor". Stored per petition so the choice is explicit
// rather than re-guessed at every render.
function leadInFor(p) {
  if (p.leadIn !== undefined) return p.leadIn;
  return `We, the undersigned${p.place ? `, residents of ${p.place}` : ''}, state:`;
}

// Someone can sign a given petition once. Online that is settled by email;
// in person there may be no email at all, so fall back to name + address.
function alreadySigned(p, { email, name, address }) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return activeSigs(p).find(s =>
    (email && s.email && s.email === email)
    || (!email && norm(s.name) === norm(name) && norm(s.address) && norm(s.address) === norm(address)));
}

// Near-duplicate detection — catches same person signing with slight variations.
// Returns the matching sig or null.
function findNearDuplicate(p, { email, name, address }) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const nameN = norm(name);
  const addrN = norm(address);
  for (const s of activeSigs(p)) {
    if (s.removed) continue;
    // Same name, different address (moved? typo?)
    if (norm(s.name) === nameN && addrN && norm(s.address) && norm(s.address) !== addrN) return s;
    // Same address, very similar name (first name match)
    if (addrN && norm(s.address) === addrN && nameN) {
      const aParts = nameN.split(/\s+/);
      const bParts = norm(s.name).split(/\s+/);
      if (aParts[0] === bParts[0] && aParts.length > 1 && bParts.length > 1 && aParts.join(' ') !== bParts.join(' ')) return s;
    }
  }
  return null;
}

// ---------------------------------------------------------------- signing

function confirmSig(token) {
  return crypto.createHmac('sha256', ctx.LINK_SECRET()).update(`petition|${token}`).digest('hex').slice(0, 16);
}

function confirmUrl(token) {
  return `${ctx.PUBLIC_URL}/public/petition-confirm?t=${token}.${confirmSig(token)}`;
}

// An email address is optional now, so it can no longer gate the count. When
// somebody does leave one they get a receipt — a record of what they put their
// name to, and a way to notice if somebody else used their address.
async function sendReceipt(p, sig) {
  if (!sig.email) return;
  const witness = sig.collectorName ? `, witnessed by ${sig.collectorName}` : '';
  await ctx.sendEmail(
    sig.email,
    `You signed: ${p.title}`,
    `This is a receipt for the petition you signed${witness}:\n\n${p.title}\n\n${p.body}\n\n`
    + `Follow it here: ${petitionUrl(p)}\n\n`
    + `This is a receipt, not a subscription — we will not email you about it again.\n`
    + `If you did not sign this, reply and tell us and we will remove it.\n\n—\n${ctx.BRAND_NAME} · ${ctx.PUBLIC_URL}`,
    null, null,
    ctx.emailShell('✍️ Thanks for signing',
      ctx.emailQuote(p.title)
      + `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#444;">Your name is on it${ctx.escHtml(witness)}. This is a receipt, not a subscription — we will not email you about it again.</p>`
      + ctx.emailButton('Follow the petition →', petitionUrl(p))
      + `<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#8a887f;">If you did not sign this, reply and tell us — we will take it off.</p>`,
      '')
  );
}

// One throttled note to the organizer rather than a ping per signature.
async function notifyOwner(p) {
  const acct = ctx.getAccount(p.ownerAccountId);
  if (!acct) return;
  const now = Date.now();
  if (now - (p.lastOwnerNotify || 0) < 6 * 3600000) return;
  p.lastOwnerNotify = now;
  const c = counts(p);
  const to = ctx.acctEmail(acct);
  if (to) {
    await ctx.sendEmail(
      to,
      `${c.total} signature${c.total === 1 ? '' : 's'} on “${p.title}”`,
      `Your petition "${p.title}" now has ${c.total} signature${c.total === 1 ? '' : 's'}`
      + `${p.goal ? ` of your ${p.goal} goal` : ''} (${c.online} online, ${c.paper} on paper).\n\n${petitionUrl(p)}\n\n`
      + `—\n${ctx.BRAND_NAME} · ${ctx.PUBLIC_URL}\nUnsubscribe from everything: ${ctx.unsubscribeLink(p.ownerAccountId, null)}`,
      ctx.unsubscribeLink(p.ownerAccountId, null), null,
      ctx.emailShell(`📈 ${c.total} signature${c.total === 1 ? '' : 's'} so far`,
        ctx.emailQuote(p.title)
        + `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#444;">${c.online} online · ${c.paper} on paper${p.goal ? ` · goal ${p.goal}` : ''}</p>`
        + ctx.emailButton('Open your petition →', petitionUrl(p)),
        `<a href="${ctx.unsubscribeLink(p.ownerAccountId, null)}" style="color:#8a887f;">Unsubscribe from everything</a><br>`)
    );
  }
  const wa = ctx.acctWhatsapp(acct);
  if (wa) {
    ctx.queueWa({ phone: wa, text: `📈 *${p.title}* is at ${c.total} signature${c.total === 1 ? '' : 's'} (${c.online} online, ${c.paper} paper).\n${petitionUrl(p)}` });
  }
  await ctx.pushToAccount(p.ownerAccountId, acct, {
    title: `${c.total} signature${c.total === 1 ? '' : 's'} on your petition`,
    body: `${p.title}\n${c.online} online · ${c.paper} on paper${p.goal ? ` · goal ${p.goal}` : ''}`,
    url: petitionUrl(p),
    tag: `po-${p.id}`,
  });
}

// Email the organizer when a near-duplicate is detected so they can review.
async function notifyDuplicate(p, newSig, existingSig) {
  const acct = ctx.getAccount(p.ownerAccountId);
  if (!acct) return;
  const to = ctx.acctEmail(acct);
  if (!to) return;
  await ctx.sendEmail(
    to,
    `Possible duplicate signature on "${p.title}"`,
    `A new signature may be a duplicate of an existing one:\n\n`
    + `NEW:      ${newSig.name} — ${newSig.address}\n`
    + `EXISTING: ${existingSig.name} — ${existingSig.address}\n\n`
    + `If one is a duplicate, open the petition and remove it from the organizer panel.\n\n`
    + `${petitionUrl(p)}\n\n—\n${ctx.BRAND_NAME} · ${ctx.PUBLIC_URL}`,
    null, null,
    ctx.emailShell('⚠️ Possible duplicate signature',
      ctx.emailQuote(p.title)
      + `<p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#444;">A new signature looks similar to an existing one:</p>`
      + `<table style="font-size:13px;border-collapse:collapse;margin:0 0 14px">`
      + `<tr><td style="padding:4px 10px 4px 0;color:#888">New:</td><td style="padding:4px 0"><b>${ctx.escHtml(newSig.name)}</b> — ${ctx.escHtml(newSig.address)}</td></tr>`
      + `<tr><td style="padding:4px 10px 4px 0;color:#888">Existing:</td><td style="padding:4px 0"><b>${ctx.escHtml(existingSig.name)}</b> — ${ctx.escHtml(existingSig.address)}</td></tr></table>`
      + `<p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:#666;">If one is a duplicate, you can remove it from the organizer panel.</p>`
      + ctx.emailButton('Review signatures →', petitionUrl(p)), '')
  );
}

// ---------------------------------------------------------------- payloads

function publicPayload(p, viewer) {
  const c = counts(p);
  const all = activeSigs(p);
  const shown = all
    .filter(s => (s.source === 'paper' || s.confirmed) && s.showName !== false)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 300)
    .map(s => ({ name: s.name, comment: s.comment || '', ts: s.ts, source: s.source }));
  const withheld = all.filter(s => (s.source === 'paper' || s.confirmed) && s.showName === false).length;

  const out = {
    id: p.id, slug: p.slug, title: p.title, summary: p.summary || '',
    body: p.body, bodyHtml: formatBody(p.body, ctx.escHtml), leadIn: leadInFor(p),
    target: p.target || '', place: p.place || '',
    goal: p.goal || 0, status: p.status, created: p.created,
    closed: p.closed || null, outcome: p.outcome || '',
    ownerName: p.ownerName || 'A neighbor',
    addressRequired: p.addressRequired !== false,
    locked: sigs(p).length > 0, // includes removed — body stays frozen once anyone ever signed
    counts: c, withheld, signers: shown, updates: p.updates || [],
    url: petitionUrl(p),
    sheets: shts(p)
      .filter(s => s.public && s.publicFile)
      .map(s => ({
        id: s.id, collectorName: s.collectorName || '',
        count: s.status === 'counted' ? s.verifiedCount : null,
        ts: s.uploaded,
        // Origin-relative on purpose: the organizer's redaction tool reads the
        // image into a canvas, and an absolute URL built from PUBLIC_URL taints
        // it the moment the page is reached by any other hostname.
        image: `/public/petition-sheet?p=${p.id}&s=${s.id}`,
      })),
  };

  if (viewer) {
    const acct = ctx.getAccount(viewer);
    out.viewer = {
      accountId: viewer,
      name: acct ? acct.name : '',
      isOwner: isOwner(p, viewer),
      isCollector: isCollector(p, viewer),
      signed: all.some(s => s.accountId === viewer && s.confirmed)
        || (acct && ctx.acctEmail(acct)
          ? all.some(s => s.email === ctx.acctEmail(acct) && s.confirmed)
          : false),
    };
  }
  return out;
}

// Everything the organizer console needs. Never includes signer email
// addresses or street addresses — those leave the server only through the
// deliberate CSV export.
function adminPayload(p, viewer) {
  const all = activeSigs(p);
  const removed = sigs(p).filter(s => s.removed);
  return {
    inviteUrl: `${petitionUrl(p)}?join=${p.inviteCode}`,
    collectors: Object.entries(p.collectors || {}).map(([aid, c]) => ({
      accountId: aid, name: c.name, added: c.added,
      collected: shts(p).filter(s => s.collectorId === aid && s.status === 'counted')
        .reduce((n, s) => n + (s.verifiedCount || 0), 0),
    })),
    sheets: shts(p).map(s => ({
      id: s.id, collectorId: s.collectorId, collectorName: s.collectorName || '',
      uploaded: s.uploaded, status: s.status, claimedCount: s.claimedCount || 0,
      verifiedCount: s.verifiedCount || 0, note: s.note || '',
      mime: s.mime, public: !!s.public,
      image: `/public/petition-sheet?p=${p.id}&s=${s.id}&account=${viewer}&original=1`,
    })).sort((a, b) => b.uploaded - a.uploaded),
    pendingConfirm: Object.values(store.pending).filter(x => x.petitionId === p.id).length,
    unconfirmed: all.filter(s => s.source === 'web' && !s.confirmed).length,
    signedInPerson: all.filter(s => s.inPerson).length,
    drawnSignatures: all.filter(s => s.sigFile && !s.signatureTyped).length,
    removedSignatures: removed.map(s => ({
      id: s.id, name: s.name, ts: s.ts,
      removedAt: s.removedAt, removeReason: s.removeReason || '',
    })),
    collectUrl: `/p/${p.slug}/collect`,
    recordUrl: `/p/${p.slug}/record?account=${viewer}`,
    exportUrl: `/public/petition-export?p=${p.id}&account=${viewer}`,
  };
}

// ---------------------------------------------------------------- QR codes

function qrSvg(text, px) {
  if (!qrcode) return '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges" role="img" aria-label="QR code linking to this petition">`
      + `<rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  } catch (e) {
    console.error('QR failed:', e.message);
    return '';
  }
}

// ------------------------------------------------------------- print sheet

function printSheet(p, collector, rows) {
  const esc = ctx.escHtml;
  const url = petitionUrl(p);
  const qr = qrSvg(url, 108);
  const rowHtml = Array.from({ length: rows }, (_, i) => `<tr>
      <td class="num">${i + 1}</td><td></td><td></td><td></td><td></td>
    </tr>`).join('');

  // <body class="sheet"> — not a bare <body> — so the site-wide "experimental"
  // banner nginx injects into web pages does not print onto the sheet. The
  // sheet carries its own, correctly worded notice instead.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Signature sheet — ${esc(p.title)}</title>
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
body{font:14px/1.5 Georgia,"Times New Roman",serif;color:#111;background:#e9e7e1;padding:24px 12px}
.page{background:#fff;max-width:8.5in;margin:0 auto 20px;padding:0.55in 0.6in;box-shadow:0 2px 18px rgba(0,0,0,.14)}
.toolbar{max-width:8.5in;margin:0 auto 14px;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;
  font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.toolbar .btn{padding:.55rem 1.1rem;border:1.5px solid #3b6b4a;border-radius:9px;background:#3b6b4a;color:#fff;
  font-weight:600;font-size:.9rem;cursor:pointer;text-decoration:none;font-family:inherit}
.toolbar .btn.ghost{background:#fff;color:#3b6b4a}
.toolbar .hint{color:#5c5a52;font-size:.85rem}
.head{display:flex;gap:14px;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:12px}
.head h1{font-size:19px;line-height:1.25;margin-bottom:4px}
.head .to{font-size:12.5px;color:#333}
.qr{flex:0 0 auto;text-align:center;font:10px/1.3 system-ui,sans-serif;color:#333}
.qr svg{display:block;margin-bottom:2px}
.statement{border:1px solid #111;padding:10px 12px;margin-bottom:12px;font-size:13px;line-height:1.55}
.statement p{margin:0 0 7px}.statement ul{margin:0 0 7px;padding-left:15px}
.statement li{margin-bottom:5px}.statement>:last-child{margin-bottom:0}
.statement b{display:block;margin-bottom:5px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;font-family:system-ui,sans-serif}
table{width:100%;border-collapse:collapse;font-size:12px}
th{font:600 10.5px/1.3 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.05em;text-align:left;
  padding:4px 6px;border:1px solid #111;background:#f1efe9}
td{border:1px solid #999;height:0.42in;padding:2px 6px}
td.num{width:0.3in;text-align:center;color:#777;font-size:10px;border-color:#999}
th.c-name{width:26%}th.c-sign{width:26%}th.c-addr{width:30%}th.c-date{width:12%}
.collector{display:flex;gap:16px;margin:14px 0 10px;font-size:12px;font-family:system-ui,sans-serif}
.collector div{flex:1;border-bottom:1px solid #111;padding-bottom:2px}
.collector span{color:#666;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em}
.foot{margin-top:12px;padding-top:9px;border-top:1px solid #bbb;font:10.5px/1.5 system-ui,sans-serif;color:#444}
.foot b{color:#111}
.warn{margin-top:7px;color:#7a3b12}
@media print{
  body{background:#fff;padding:0}
  .toolbar{display:none}
  .page{box-shadow:none;margin:0;max-width:none;padding:0.4in 0.5in}
  /* A long petition pushes the table onto a second sheet — repeat the column
     headings there and never split a signature row across the fold. */
  thead{display:table-header-group}
  tr{page-break-inside:avoid}
  .statement{page-break-inside:avoid}
  .collector,.foot{page-break-inside:avoid}
  @page{size:letter portrait;margin:0.35in}
}
</style></head><body class="sheet">
<div class="toolbar">
  <button class="btn" onclick="window.print()">Print this sheet</button>
  <a class="btn ghost" href="${url}">Back to the petition</a>
  <span class="hint">Tip: print several copies — one sheet holds ${rows} signatures.</span>
</div>
<div class="page">
  <div class="head">
    <div style="flex:1">
      <h1>${esc(p.title)}</h1>
      ${p.target ? `<div class="to">A petition to <b>${esc(p.target)}</b></div>` : ''}
      <div class="to">Sign online instead: <b>${esc(url.replace(/^https?:\/\//, ''))}</b></div>
    </div>
    ${qr ? `<div class="qr">${qr}Scan to sign online</div>` : ''}
  </div>

  <div class="statement">${leadInFor(p) ? `<b>${esc(leadInFor(p))}</b>` : ''}${formatBody(p.body, esc)}</div>

  <table>
    <thead><tr>
      <th class="c-num"></th>
      <th class="c-name">Print your name</th>
      <th class="c-sign">Signature</th>
      <th class="c-addr">Street address${p.place ? `, ${esc(p.place)}` : ''}</th>
      <th class="c-date">Date</th>
    </tr></thead>
    <tbody>${rowHtml}</tbody>
  </table>

  <div class="collector">
    <div><span>Sheet collected by</span><br>${collector ? esc(collector) : '&nbsp;'}</div>
    <div><span>Date collected</span><br>&nbsp;</div>
    <div><span>Sheet number</span><br>&nbsp;</div>
  </div>

  <div class="foot">
    <b>When the sheet is full:</b> photograph or scan it and upload it at
    <b>${esc(url.replace(/^https?:\/\//, ''))}</b> so it joins the running total.
    Keep the paper — the organizer needs the originals to deliver.
    <div class="warn"><b>Please note:</b> this is a community petition, not an official Village form.
    It is not a designating petition, a referendum petition, or any other filing governed by
    New York Election Law or Village Law, and it does not carry their legal effect. Signers are
    telling ${p.target ? esc(p.target) : 'the recipient'} what they think.</div>
  </div>
</div>
</body></html>`;
}

// --------------------------------------------------------- signed record
// What the organizer actually delivers: the statement, then every signer with
// the signature they drew. Printed on paper this is the digital equivalent of
// the sheets, which is why it carries the same "not a Village form" notice.
function signedRecord(p, viewer) {
  const esc = ctx.escHtml;
  const list = activeSigs(p).filter(s => s.confirmed).sort((a, b) => a.ts - b.ts);
  const acct = a => encodeURIComponent(viewer);
  const rows = list.map((s, i) => `<tr>
      <td class="n">${i + 1}</td>
      <td>${esc(s.name)}${s.showName === false ? '<br><span class="q">asked not to be listed publicly</span>' : ''}</td>
      <td class="sig">${s.sigFile
        ? `<img src="/public/petition-signature?p=${p.id}&s=${s.id}&account=${acct()}" alt="Signature of ${esc(s.name)}">`
        : '<span class="q">no drawing</span>'}${s.signatureTyped ? '<br><span class="q">typed, not drawn</span>' : ''}</td>
      <td>${esc(s.address || '')}</td>
      <td class="d">${new Date(s.ts).toLocaleDateString('en-US')}</td>
      <td class="d">${s.inPerson ? `in person<br><span class="q">${esc(s.collectorName || '')}</span>` : s.source === 'paper' ? 'paper sheet' : 'online'}</td>
    </tr>`).join('');
  const c = counts(p);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Signed record — ${esc(p.title)}</title>
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
body{font:13px/1.5 Georgia,"Times New Roman",serif;color:#111;background:#e9e7e1;padding:24px 12px}
.page{background:#fff;max-width:8.5in;margin:0 auto;padding:.55in .6in;box-shadow:0 2px 18px rgba(0,0,0,.14)}
.toolbar{max-width:8.5in;margin:0 auto 14px;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;
  font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.toolbar .btn{padding:.55rem 1.1rem;border:1.5px solid #3b6b4a;border-radius:9px;background:#3b6b4a;color:#fff;
  font-weight:600;font-size:.9rem;cursor:pointer;text-decoration:none;font-family:inherit}
.toolbar .btn.ghost{background:#fff;color:#3b6b4a}
.toolbar .warn{color:#7a3b12;font-size:.83rem}
h1{font-size:19px;line-height:1.25;margin-bottom:4px}
.to{font-size:12.5px;color:#333;margin-bottom:10px}
.statement{border:1px solid #111;padding:10px 12px;margin-bottom:14px;font-size:12.5px;line-height:1.55}
.statement p{margin:0 0 6px}.statement ul{margin:0 0 6px;padding-left:15px}
.statement li{margin-bottom:4px}.statement>:last-child{margin-bottom:0}
.statement b{display:block;margin-bottom:5px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;font-family:system-ui,sans-serif}
table{width:100%;border-collapse:collapse}
th{font:600 10px/1.3 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.05em;text-align:left;
  padding:5px 6px;border:1px solid #111;background:#f1efe9}
td{border:1px solid #aaa;padding:5px 6px;vertical-align:middle;font-size:12px}
td.n{width:.3in;text-align:center;color:#777;font-size:10px}
td.d{font-size:10.5px;color:#444;white-space:nowrap}
td.sig{width:2.1in}
td.sig img{max-width:100%;height:auto;max-height:.55in;display:block;mix-blend-mode:multiply}
.q{font:400 9.5px/1.3 system-ui,sans-serif;color:#888}
.foot{margin-top:14px;padding-top:9px;border-top:1px solid #bbb;font:10.5px/1.55 system-ui,sans-serif;color:#444}
.foot b{color:#111}
.warnbox{margin-top:7px;color:#7a3b12}
@media print{body{background:#fff;padding:0}.toolbar{display:none}
  .page{box-shadow:none;margin:0;max-width:none;padding:.4in .5in}
  tr{page-break-inside:avoid}thead{display:table-header-group}
  @page{size:letter portrait;margin:.35in}}
</style></head><body class="record">
<div class="toolbar">
  <button class="btn" onclick="window.print()">Print / save as PDF</button>
  <a class="btn ghost" href="${petitionUrl(p)}">Back to the petition</a>
  <span class="warn">This page shows every signer's address and signature. Don't leave it open on a shared screen.</span>
</div>
<div class="page">
  <h1>${esc(p.title)}</h1>
  <div class="to">A petition to <b>${esc(p.target)}</b> · organized by ${esc(p.ownerName)} ·
    ${c.total} signature${c.total === 1 ? '' : 's'} (${c.online} signed on screen, ${c.paper} on paper)
    · printed ${new Date().toLocaleDateString('en-US')}</div>
  <div class="statement">${leadInFor(p) ? `<b>${esc(leadInFor(p))}</b>` : ''}${formatBody(p.body, esc)}</div>
  <table><thead><tr>
    <th></th><th>Name</th><th>Signature</th><th>Address</th><th>Date</th><th>How</th>
  </tr></thead><tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:#888;padding:18px">No signatures yet.</td></tr>'}</tbody></table>
  <div class="foot">
    <b>${c.total}</b> signature${c.total === 1 ? '' : 's'} in total.
    Signatures marked <i>in person</i> were witnessed by the named collector; signatures marked
    <i>online</i> were confirmed by a link sent to the signer's own email address.
    ${shts(p).filter(s => s.status === 'counted').length
      ? `A further ${shts(p).filter(s => s.status === 'counted').reduce((n, s) => n + (s.verifiedCount || 0), 0)} signature(s) were collected on paper sheets held by the organizer.`
      : ''}
    <div class="warnbox"><b>Please note:</b> this is a community petition, not an official Village
    form. It is not a designating petition, a referendum petition, or any other filing governed by
    New York Election Law or Village Law, and it does not carry their legal effect.</div>
  </div>
</div>
</body></html>`;
}

// ---------------------------------------------------------------- routing

async function handle(req, res) {
  const urlPath = (req.url || '').split('?')[0];
  const q = new URL(req.url || '/', 'http://x').searchParams;

  const isPetitionPath = urlPath === '/petitions'
    || urlPath.startsWith('/p/')
    || urlPath.startsWith('/public/petition');
  if (!isPetitionPath) return false;

  // ---- pages -------------------------------------------------------

  // GET /petitions and GET /p/<slug> both serve the single-page app; nginx
  // maps the internal alias to petitions.html.
  if ((req.method === 'GET' || req.method === 'HEAD') && urlPath === '/petitions') {
    res.writeHead(200, { 'X-Accel-Redirect': '/_petitions', 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(), true;
  }

  const printMatch = urlPath.match(/^\/p\/([a-z0-9-]+)\/print$/);
  if (req.method === 'GET' && printMatch) {
    const p = bySlug(printMatch[1]);
    if (!p) { html(res, 404, ctx.pageShell('Not found', '<h1>No such petition</h1><p>That petition does not exist, or its address has changed.</p>')); return true; }
    const rows = Math.min(30, Math.max(5, parseInt(q.get('rows') || '12', 10) || 12));
    let collector = '';
    const viewer = viewerAccount(req, q.get('account'));
    if (viewer && isCollector(p, viewer)) collector = (ctx.getAccount(viewer) || {}).name || '';
    html(res, 200, printSheet(p, collector, rows));
    return true;
  }

  // GET /p/<slug>/record — the organizer's deliverable: every signature with
  // its drawing, laid out to print. Owner only, and no-store.
  const recordMatch = urlPath.match(/^\/p\/([a-z0-9-]+)\/record$/);
  if (req.method === 'GET' && recordMatch) {
    const p = bySlug(recordMatch[1]);
    if (!p) { html(res, 404, ctx.pageShell('Not found', '<div class="icon">🔍</div><h1>No such petition</h1>')); return true; }
    const viewer = viewerAccount(req, q.get('account'));
    if (!isOwner(p, viewer)) {
      html(res, 403, ctx.pageShell('Not yours',
        '<div class="icon">🔒</div><h1>Organizer only</h1><p>This page lists signers with their addresses and signatures, so only the person who started the petition can open it. Use the link in your organizer console.</p>'
        + `<a class="btn primary" href="${petitionUrl(p)}">Back to the petition</a>`));
      return true;
    }
    html(res, 200, signedRecord(p, viewer));
    return true;
  }

  // GET /p/<slug>/collect — kiosk mode for a collector's own phone or tablet
  const collectMatch = urlPath.match(/^\/p\/([a-z0-9-]+)\/collect$/);
  if ((req.method === 'GET' || req.method === 'HEAD') && collectMatch) {
    if (!bySlug(collectMatch[1])) {
      html(res, 404, ctx.pageShell('Not found', '<div class="icon">🔍</div><h1>No such petition</h1>'));
      return true;
    }
    res.writeHead(200, { 'X-Accel-Redirect': '/_petitions', 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(), true;
  }

  const pageMatch = urlPath.match(/^\/p\/([a-z0-9-]+)$/);
  if ((req.method === 'GET' || req.method === 'HEAD') && pageMatch) {
    if (!bySlug(pageMatch[1])) {
      html(res, 404, ctx.pageShell('Not found',
        '<div class="icon">🔍</div><h1>No such petition</h1><p>That petition does not exist, or its address has changed.</p>'
        + `<a class="btn primary" href="${ctx.PUBLIC_URL}/petitions">See all petitions</a>`));
      return true;
    }
    res.writeHead(200, { 'X-Accel-Redirect': '/_petitions', 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(), true;
  }

  // ---- JSON API ----------------------------------------------------

  // GET /public/petitions — the list
  if (req.method === 'GET' && urlPath === '/public/petitions') {
    const viewer = viewerAccount(req, q.get('account'));
    const list = Object.values(store.petitions)
      .filter(p => !p.hidden)
      .map(p => {
        const c = counts(p);
        return {
          id: p.id, slug: p.slug, title: p.title, summary: p.summary || '',
          target: p.target || '', goal: p.goal || 0, status: p.status,
          created: p.created, ownerName: p.ownerName || 'A neighbor',
          counts: c, url: petitionUrl(p),
          mine: isCollector(p, viewer),
        };
      })
      .sort((a, b) => (a.status === b.status ? b.counts.total - a.counts.total : a.status === 'open' ? -1 : 1));
    json(res, 200, { petitions: list, canCreate: !!viewer });
    return true;
  }

  // GET /public/petition?slug= — one petition (+ organizer view when entitled)
  if (req.method === 'GET' && urlPath === '/public/petition') {
    const p = q.get('slug') ? bySlug(q.get('slug')) : store.petitions[q.get('id') || ''];
    if (!p) { json(res, 404, { error: 'No such petition.' }); return true; }
    const viewer = viewerAccount(req, q.get('account'));
    const payload = publicPayload(p, viewer);
    if (viewer && isCollector(p, viewer)) payload.admin = adminPayload(p, viewer);
    json(res, 200, payload);
    return true;
  }

  // POST /public/petition-create
  if (req.method === 'POST' && urlPath === '/public/petition-create') {
    const body = await readBody(req);
    if (body.website) { json(res, 200, { ok: true }); return true; }

    const viewer = viewerAccount(req, body.accountId);
    const acct = viewer && ctx.getAccount(viewer);
    // An organizer needs a confirmed way to be reached (a phone notification
    // alone is a device, not a contact).
    if (!acct || acct.verified === false || !(ctx.acctEmail(acct) || ctx.acctWhatsapp(acct))) {
      json(res, 403, { error: 'Sign up and confirm your email before starting a petition — a petition carries your name as the organizer.' });
      return true;
    }
    const ipHash = ctx.hashIp(ctx.clientIp(req));
    if (throttled(createLog, ipHash, 3, 24 * 3600000)) {
      json(res, 429, { error: 'That is three petitions from this connection today. Give it a day.' });
      return true;
    }

    const title = ctx.cleanText(body.title, 140, true);
    const summary = ctx.cleanText(body.summary, 300, false);
    const text = ctx.cleanText(body.body, 4000, false);
    const target = ctx.cleanText(body.target, 140, true);
    const place = ctx.cleanText(body.place, 80, true) || ctx.PLACE;
    const goal = Math.min(100000, Math.max(0, parseInt(body.goal, 10) || 0));

    if (title.length < 10) { json(res, 400, { error: 'Give the petition a title of at least 10 characters.' }); return true; }
    if (text.length < 40) { json(res, 400, { error: 'Write out what you are asking for — at least 40 characters. This is the text people put their name to, and it cannot be changed once someone signs.' }); return true; }
    if (!target) { json(res, 400, { error: 'Say who the petition is addressed to — for example, the Village Board of Trustees.' }); return true; }

    const p = {
      id: id16(), slug: uniqueSlug(title), title, summary, body: text, target, place, goal,
      ownerAccountId: viewer, ownerName: acct.name || 'A neighbor',
      status: 'open', created: Date.now(),
      addressRequired: body.addressRequired !== false,
      collectors: {}, inviteCode: id16(), updates: [], ipHash,
      // A letter opens with its own salutation — the undersigned line would
      // read as a second, competing opening above it.
      leadIn: /^\s*(dear|to the|to whom)\b/i.test(text)
        ? '' : `We, the undersigned${place ? `, residents of ${place}` : ''}, state:`,
    };
    store.petitions[p.id] = p;
    store.signatures[p.id] = [];
    store.sheets[p.id] = [];
    saveStore();
    console.log(`Petition created: ${p.slug} "${title}" by ${viewer}`);

    // Tell the people who asked to hear about everything new.
    setImmediate(async () => {
      const line = `📜 *New petition:* ${title}\n${summary ? `\n_${summary.slice(0, 150)}_\n` : ''}\nRead it and decide for yourself: ${petitionUrl(p)}`;
      if (ctx.WA_ANNOUNCE_JID()) ctx.queueWa({ phone: ctx.WA_ANNOUNCE_JID(), text: line });
      for (const [aid, a] of Object.entries(ctx.allAccounts())) {
        if (!a.allTopics || a.verified === false || aid === viewer) continue;
        const wa = ctx.acctWhatsapp(a);
        if (wa) ctx.queueWa({ phone: wa, text: line });
        await ctx.pushToAccount(aid, a, {
          title: `New petition: ${title}`,
          body: summary ? summary.slice(0, 150) : 'A neighbor started a petition. Read it and decide for yourself.',
          url: petitionUrl(p),
          tag: `p-${p.id}`,
        });
        const em = ctx.acctEmail(a);
        if (em) {
          await ctx.sendEmail(em, `New petition: ${title}`,
            `A neighbor started a petition:\n\n${title}\n${summary ? '\n' + summary + '\n' : ''}\nRead it and decide for yourself: ${petitionUrl(p)}\n\n—\n${ctx.BRAND_NAME} · ${ctx.PUBLIC_URL}\nUnsubscribe from everything: ${ctx.unsubscribeLink(aid, null)}`,
            ctx.unsubscribeLink(aid, null), null,
            ctx.emailShell('📜 A neighbor started a petition',
              ctx.emailQuote(title)
              + (summary ? `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#444;">${ctx.escHtml(summary)}</p>` : '')
              + ctx.emailButton('Read it →', petitionUrl(p)),
              `<a href="${ctx.unsubscribeLink(aid, null)}" style="color:#8a887f;">Unsubscribe from everything</a><br>`));
        }
      }
    });

    json(res, 200, { ok: true, slug: p.slug, url: petitionUrl(p), inviteUrl: `${petitionUrl(p)}?join=${p.inviteCode}` });
    return true;
  }

  // POST /public/petition-sign
  if (req.method === 'POST' && urlPath === '/public/petition-sign') {
    const body = await readBody(req);
    if (body.website) { json(res, 200, { ok: true, pending: true }); return true; }
    const p = bySlug(body.slug || '');
    if (!p) { json(res, 404, { error: 'No such petition.' }); return true; }
    if (p.status !== 'open') { json(res, 400, { error: 'This petition is closed — it is no longer collecting signatures.' }); return true; }

    const ipHash = ctx.hashIp(ctx.clientIp(req));
    if (throttled(signLog, ipHash, 8, 3600000)) {
      json(res, 429, { error: 'Too many signatures from this connection in the last hour.' });
      return true;
    }

    const name = ctx.cleanText(body.name, 80, true);
    const email = ctx.cleanText(body.email, 120, true).toLowerCase();
    const address = ctx.cleanText(body.address, 160, true);
    const comment = ctx.cleanText(body.comment, 280, false);
    const showName = body.showName !== false;

    // Name and address are what the recipient needs in order to weigh the
    // petition: who you are and that you live here. An email is optional — it
    // buys the signer a receipt and the organizer a way to reach them, and it
    // no longer gates the count.
    if (name.length < 2 || !name.includes(' ')) { json(res, 400, { error: 'Please give your full name — a petition is signed, not voted on anonymously.' }); return true; }
    if (email && !validEmail(email)) { json(res, 400, { error: 'That email address does not look right. Leave it blank if you would rather not give one.' }); return true; }
    if (p.addressRequired !== false && address.length < 5) {
      // Plain text, not escaped — the client puts this in textContent.
      json(res, 400, { error: `Please give your street address. ${p.target || 'The recipient'} needs to know the signers are ${p.place ? `from ${p.place}` : 'local'}. It is never shown publicly.` });
      return true;
    }
    if (!body.signature) { json(res, 400, { error: 'Please sign in the box before submitting.' }); return true; }

    const existing = alreadySigned(p, { email, name, address });
    if (existing) {
      json(res, 200, { ok: true, already: true, confirmed: !!existing.confirmed });
      return true;
    }

    const viewer = viewerAccount(req, body.accountId);
    const vAcct = viewer && ctx.getAccount(viewer);
    const sigId = id16();
    const drew = savePngDataUrl(body.signature, uploadPath(p.id, `sig-${sigId}.png`));
    if (!drew) { json(res, 400, { error: 'That signature did not come through. Please sign again.' }); return true; }

    store.signatures[p.id] = store.signatures[p.id] || [];
    const sig = {
      id: sigId, name, email, address, comment, showName,
      accountId: viewer || null,
      source: 'web', confirmed: true, ts: Date.now(), ipHash,
      sigFile: `sig-${sigId}.png`, signatureTyped: !!body.signatureTyped,
      // Recorded, not enforced: the organizer can see at a glance which
      // signatures came from an address the forum had already proved.
      viaVerifiedAccount: !!(vAcct && vAcct.verified !== false && ctx.acctEmail(vAcct) === email),
    };
    store.signatures[p.id].push(sig);
    if (!saveStore()) {
      // Roll back rather than claim a signature we could not record.
      store.signatures[p.id] = store.signatures[p.id].filter(x => x.id !== sigId);
      unlinkQuiet(uploadPath(p.id, `sig-${sigId}.png`));
      json(res, 500, { error: 'We could not record your signature just now. Please try again in a minute — nothing was saved.' });
      return true;
    }

    setImmediate(() => sendReceipt(p, sig).catch(e => console.error('receipt:', e.message)));
    setImmediate(() => notifyOwner(p).catch(() => {}));
    // Check for near-duplicates and alert the organizer so they can review.
    const nearDup = findNearDuplicate(p, { email, name, address });
    if (nearDup && nearDup.id !== sig.id) {
      setImmediate(() => notifyDuplicate(p, sig, nearDup).catch(e => console.error('dup-notify:', e.message)));
    }
    json(res, 200, { ok: true, confirmed: true, counts: counts(p) });
    return true;
  }

  // GET /public/petition-confirm?t=<token>.<sig>
  if (req.method === 'GET' && urlPath === '/public/petition-confirm') {
    const raw = String(q.get('t') || '');
    const [token, sig] = raw.split('.');
    const pend = token && store.pending[token];
    if (!pend || !sig || sig !== confirmSig(token)) {
      html(res, 400, ctx.pageShell('Link expired',
        '<div class="icon">⏳</div><h1>That link has expired</h1><p>Confirmation links last seven days. Sign again on the petition page and a fresh one will be sent.</p>'
        + `<a class="btn primary" href="${ctx.PUBLIC_URL}/petitions">See petitions</a>`));
      return true;
    }
    const p = store.petitions[pend.petitionId];
    if (!p) { html(res, 404, ctx.pageShell('Not found', '<div class="icon">🔍</div><h1>That petition is gone</h1><p>Nothing was recorded.</p>')); return true; }

    delete store.pending[token];
    store.signatures[p.id] = store.signatures[p.id] || [];
    if (!store.signatures[p.id].some(s => s.email === pend.email)) {
      const sigId = id16();
      let sigFile = null;
      if (pend.hasSignature) {
        try {
          fs.renameSync(uploadPath(p.id, `pending-${token}.png`), uploadPath(p.id, `sig-${sigId}.png`));
          sigFile = `sig-${sigId}.png`;
        } catch (e) { console.error('signature attach failed:', e.message); }
      }
      store.signatures[p.id].push({
        id: sigId, name: pend.name, email: pend.email, address: pend.address,
        comment: pend.comment, showName: pend.showName, accountId: pend.accountId,
        source: 'web', confirmed: true, ts: Date.now(), ipHash: pend.ipHash,
        sigFile, signatureTyped: !!pend.typed,
      });
    } else if (pend.hasSignature) {
      unlinkQuiet(uploadPath(p.id, `pending-${token}.png`));
    }
    saveStore();
    setImmediate(() => notifyOwner(p).catch(e => console.error('owner notify:', e.message)));

    const c = counts(p);
    html(res, 200, ctx.pageShell('Signature confirmed',
      `<div class="icon">✅</div><h1>Signed — thank you</h1>`
      + `<blockquote>${ctx.escHtml(p.title)}</blockquote>`
      + `<p>Your signature is counted. That makes <b>${c.total}</b>${p.goal ? ` of ${p.goal}` : ''}.</p>`
      + `<p style="margin-top:.7rem">The surest way to add more is to ask someone in person — you can print a paper sheet from the petition page.</p>`
      + `<a class="btn primary" href="${petitionUrl(p)}">Open the petition →</a>`));
    return true;
  }

  // POST /public/petition-collect-sign — a neighbor signs on the collector's
  // own phone or tablet, with the collector standing there. This is the paper
  // sheet in digital form: no email round-trip, because the thing vouching for
  // the signature is the named collector who watched it being written. Counted
  // in the paper column for exactly that reason.
  if (req.method === 'POST' && urlPath === '/public/petition-collect-sign') {
    const body = await readBody(req);
    const p = bySlug(body.slug || '');
    if (!p) { json(res, 404, { error: 'No such petition.' }); return true; }
    if (p.status !== 'open') { json(res, 400, { error: 'This petition is closed.' }); return true; }
    const viewer = viewerAccount(req, body.accountId);
    if (!isCollector(p, viewer)) {
      json(res, 403, { error: 'Only the organizer and invited collectors can take signatures in person.' });
      return true;
    }
    // Generous but bounded: a good afternoon at the market, not a bot.
    if (throttled(signLog, `collect:${viewer}`, 80, 3600000)) {
      json(res, 429, { error: 'That is 80 signatures in an hour on this device. Take a break, then carry on.' });
      return true;
    }

    const name = ctx.cleanText(body.name, 80, true);
    const address = ctx.cleanText(body.address, 160, true);
    const email = ctx.cleanText(body.email, 120, true).toLowerCase();
    const comment = ctx.cleanText(body.comment, 280, false);
    const showName = body.showName !== false;

    if (name.length < 2 || !name.includes(' ')) { json(res, 400, { error: 'Full name, please — first and last.' }); return true; }
    if (email && !validEmail(email)) { json(res, 400, { error: 'That email address does not look right. Leave it blank if they would rather not give one.' }); return true; }
    if (p.addressRequired !== false && address.length < 5) { json(res, 400, { error: 'Street address, please.' }); return true; }
    if (!body.signature) { json(res, 400, { error: 'Have them sign in the box before you submit.' }); return true; }
    if (alreadySigned(p, { email, name, address })) {
      json(res, 200, { ok: true, already: true });
      return true;
    }

    const sigId = id16();
    const saved = savePngDataUrl(body.signature, uploadPath(p.id, `sig-${sigId}.png`));
    if (!saved) { json(res, 400, { error: 'That signature did not come through. Ask them to sign again.' }); return true; }

    const acct = ctx.getAccount(viewer) || {};
    store.signatures[p.id] = store.signatures[p.id] || [];
    store.signatures[p.id].push({
      // Digital record — we hold the drawing. inPerson/collectedBy carry the
      // provenance for the organizer's record; they don't change the bucket.
      id: sigId, name, email, address, comment, showName,
      source: 'web', confirmed: true, ts: Date.now(),
      sigFile: `sig-${sigId}.png`, signatureTyped: !!body.signatureTyped,
      collectedBy: viewer, collectorName: acct.name || 'A collector',
      inPerson: true,
    });
    if (!saveStore()) {
      store.signatures[p.id] = store.signatures[p.id].filter(x => x.id !== sigId);
      unlinkQuiet(uploadPath(p.id, `sig-${sigId}.png`));
      json(res, 500, { error: 'That signature could not be recorded. Please have them sign again — nothing was saved.' });
      return true;
    }

    // A receipt only if they volunteered an address to send it to.
    setImmediate(() => sendReceipt(p, store.signatures[p.id][store.signatures[p.id].length - 1]).catch(() => {}));
    setImmediate(() => notifyOwner(p).catch(() => {}));
    json(res, 200, { ok: true, counts: counts(p) });
    return true;
  }

  // GET /public/petition-signature?p=&s=&account= — organizer only. Signature
  // drawings are never public, never shown on the petition page, and never
  // handed to collectors: a collector saw the one person in front of them, not
  // everybody else's.
  if (req.method === 'GET' && urlPath === '/public/petition-signature') {
    const p = store.petitions[q.get('p') || ''];
    const sig = p && sigs(p).find(s => s.id === q.get('s'));
    if (!p || !sig || !sig.sigFile) { json(res, 404, { error: 'No such signature.' }); return true; }
    if (!isOwner(p, viewerAccount(req, q.get('account')))) {
      json(res, 403, { error: 'Only the organizer can view signatures.' });
      return true;
    }
    let data;
    try { data = fs.readFileSync(uploadPath(p.id, sig.sigFile)); }
    catch { json(res, 404, { error: 'That file is missing.' }); return true; }
    res.writeHead(200, {
      'Content-Type': 'image/png', 'Content-Length': data.length,
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow, noimageindex',
    });
    res.end(data);
    return true;
  }

  // POST /public/petition-join — become a signature collector via invite code
  if (req.method === 'POST' && urlPath === '/public/petition-join') {
    const body = await readBody(req);
    const p = bySlug(body.slug || '');
    if (!p) { json(res, 404, { error: 'No such petition.' }); return true; }
    const viewer = viewerAccount(req, body.accountId);
    const acct = viewer && ctx.getAccount(viewer);
    if (!acct || acct.verified === false) { json(res, 403, { error: 'Sign up and confirm your contact first — collectors are named on the sheets they hand in.' }); return true; }
    if (!body.code || body.code !== p.inviteCode) { json(res, 403, { error: 'That collector link is not valid for this petition.' }); return true; }
    if (!isOwner(p, viewer)) {
      p.collectors = p.collectors || {};
      if (!p.collectors[viewer]) p.collectors[viewer] = { name: acct.name || 'A neighbor', added: Date.now() };
      saveStore();
    }
    json(res, 200, { ok: true });
    return true;
  }

  // POST /public/petition-update — owner edits
  if (req.method === 'POST' && urlPath === '/public/petition-update') {
    const body = await readBody(req);
    const p = store.petitions[body.id || ''] || bySlug(body.slug || '');
    if (!p) { json(res, 404, { error: 'No such petition.' }); return true; }
    const viewer = viewerAccount(req, body.accountId);
    if (!isOwner(p, viewer)) { json(res, 403, { error: 'Only the organizer can change this petition.' }); return true; }

    if (body.goal !== undefined) p.goal = Math.min(100000, Math.max(0, parseInt(body.goal, 10) || 0));
    if (body.summary !== undefined) p.summary = ctx.cleanText(body.summary, 300, false);
    // The statement itself is frozen the moment anyone signs: people put their
    // name to specific words, and those words must not move under them.
    if (body.body !== undefined) {
      if (sigs(p).length > 0) { json(res, 400, { error: 'The petition text cannot change once it has signatures — people signed those exact words. Post an update instead.' }); return true; }
      const t = ctx.cleanText(body.body, 4000, false);
      if (t.length < 40) { json(res, 400, { error: 'The petition text is too short.' }); return true; }
      p.body = t;
    }
    if (body.update) {
      const u = ctx.cleanText(body.update, 800, false);
      if (u.length > 3) (p.updates = p.updates || []).unshift({ ts: Date.now(), text: u });
    }
    if (body.status && ['open', 'closed'].includes(body.status)) {
      p.status = body.status;
      p.closed = body.status === 'closed' ? Date.now() : null;
    }
    if (body.outcome !== undefined) p.outcome = ctx.cleanText(body.outcome, 500, false);
    if (body.removeCollector && p.collectors) { delete p.collectors[body.removeCollector]; }
    // Soft-remove a signature — the record stays for audit but drops out of
    // counts, the public list, the signed record and the CSV export.
    if (body.removeSignature) {
      const sigId = body.removeSignature;
      const reason = String(body.removeReason || 'other').slice(0, 60);
      const list = store.signatures[p.id] || [];
      const sig = list.find(s => s.id === sigId && !s.removed);
      if (!sig) { json(res, 404, { error: 'Signature not found or already removed.' }); return true; }
      sig.removed = true;
      sig.removedAt = Date.now();
      sig.removedBy = viewer;
      sig.removeReason = reason;
      saveStore();
      json(res, 200, { ok: true, counts: counts(p) });
      return true;
    }
    // Restore a previously removed signature.
    if (body.restoreSignature) {
      const sigId = body.restoreSignature;
      const list = store.signatures[p.id] || [];
      const sig = list.find(s => s.id === sigId && s.removed);
      if (!sig) { json(res, 404, { error: 'No removed signature with that ID.' }); return true; }
      delete sig.removed;
      delete sig.removedAt;
      delete sig.removedBy;
      delete sig.removeReason;
      saveStore();
      json(res, 200, { ok: true, counts: counts(p) });
      return true;
    }
    // Names read off a paper sheet by the organizer, one per line.
    if (body.transcribe) {
      const lines = String(body.transcribe).split('\n').map(l => ctx.cleanText(l, 80, true)).filter(l => l.length >= 2);
      store.signatures[p.id] = store.signatures[p.id] || [];
      for (const line of lines.slice(0, 200)) {
        store.signatures[p.id].push({
          id: id16(), name: line, email: '', address: '', comment: '',
          showName: true, source: 'paper', confirmed: true, ts: Date.now(),
          transcribedBy: viewer,
        });
      }
    }
    saveStore();
    json(res, 200, { ok: true });
    return true;
  }

  // POST /public/petition-sheet-upload — multipart photo/scan of a full sheet
  if (req.method === 'POST' && urlPath === '/public/petition-sheet-upload') {
    const ctype = String(req.headers['content-type'] || '');
    const bm = ctype.match(/boundary="?([^";]+)"?/);
    if (!bm) { json(res, 400, { error: 'Expected a file upload.' }); return true; }
    let buf;
    try { buf = await readRaw(req, MAX_UPLOAD); }
    catch { json(res, 413, { error: 'That file is larger than 12 MB. A phone photo at normal quality is fine.' }); return true; }

    const parts = parseMultipart(buf, bm[1]);
    const field = n => { const x = parts.find(pt => pt.name === n && pt.filename === null); return x ? x.data.toString('utf8') : ''; };
    const file = parts.find(pt => pt.filename);

    const p = bySlug(field('slug'));
    if (!p) { json(res, 404, { error: 'No such petition.' }); return true; }
    const viewer = viewerAccount(req, field('accountId'));
    if (!isCollector(p, viewer)) { json(res, 403, { error: 'Only the organizer and the people they have invited as collectors can upload sheets.' }); return true; }
    if (!file || !file.data.length) { json(res, 400, { error: 'No file arrived. Try again.' }); return true; }

    const kind = sniff(file.data);
    if (!kind) { json(res, 400, { error: 'That file is not a photo or PDF. JPEG, PNG, WebP and PDF work.' }); return true; }

    const sheetId = id16();
    const dir = path.join(UPLOAD_DIR, p.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `${sheetId}.${kind.ext}`), file.data, { mode: 0o600 });

    const acct = ctx.getAccount(viewer) || {};
    store.sheets[p.id] = store.sheets[p.id] || [];
    store.sheets[p.id].push({
      id: sheetId, collectorId: viewer, collectorName: acct.name || 'A neighbor',
      file: `${sheetId}.${kind.ext}`, mime: kind.mime, size: file.data.length,
      uploaded: Date.now(), status: 'pending',
      claimedCount: Math.min(60, Math.max(0, parseInt(field('count'), 10) || 0)),
      note: ctx.cleanText(field('note'), 200, false),
      public: false,
    });
    saveStore();

    // Let the organizer know a sheet is waiting to be counted.
    if (!isOwner(p, viewer)) {
      const owner = ctx.getAccount(p.ownerAccountId);
      const em = owner && ctx.acctEmail(owner);
      if (em) {
        setImmediate(() => ctx.sendEmail(em,
          `${acct.name || 'A collector'} handed in a sheet — ${p.title}`,
          `${acct.name || 'A collector'} uploaded a signature sheet for "${p.title}" claiming ${field('count') || 'some'} signatures.\n\nCheck it and record the count: ${petitionUrl(p)}\n\n—\n${ctx.BRAND_NAME} · ${ctx.PUBLIC_URL}`,
          null, null,
          ctx.emailShell('📄 A sheet is waiting to be counted',
            ctx.emailQuote(p.title)
            + `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#444;">${ctx.escHtml(acct.name || 'A collector')} uploaded a sheet. Paper signatures join the public total once you have checked them against the photo.</p>`
            + ctx.emailButton('Review the sheet →', petitionUrl(p)), '')).catch(() => {}));
      }
    }
    json(res, 200, { ok: true, sheetId });
    return true;
  }

  // GET /public/petition-sheet?p=&s=[&account=][&original=1]
  // Serves the redacted public copy to anyone when the organizer has published
  // one; the untouched original only to the organizer and its collector.
  if (req.method === 'GET' && urlPath === '/public/petition-sheet') {
    const p = store.petitions[q.get('p') || ''];
    const sheet = p && shts(p).find(s => s.id === q.get('s'));
    if (!p || !sheet) { json(res, 404, { error: 'No such sheet.' }); return true; }
    const viewer = viewerAccount(req, q.get('account'));
    const entitled = isOwner(p, viewer) || (sheet.collectorId && sheet.collectorId === viewer);
    const wantsOriginal = q.get('original') === '1';

    let file, mime;
    if (entitled && (wantsOriginal || !sheet.publicFile)) {
      file = uploadPath(p.id, sheet.file); mime = sheet.mime;
    } else if (sheet.public && sheet.publicFile) {
      file = uploadPath(p.id, sheet.publicFile); mime = 'image/png';
    } else {
      json(res, 403, { error: 'This sheet has not been published. It holds neighbors’ names and addresses.' });
      return true;
    }
    let data;
    try { data = fs.readFileSync(file); }
    catch { json(res, 404, { error: 'That file is missing.' }); return true; }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': data.length,
      'Cache-Control': entitled && wantsOriginal ? 'private, no-store' : 'private, max-age=300',
      'X-Robots-Tag': 'noindex, nofollow, noimageindex',
      'Content-Disposition': 'inline',
    });
    res.end(data);
    return true;
  }

  // POST /public/petition-sheet-count — organizer records the verified count
  if (req.method === 'POST' && urlPath === '/public/petition-sheet-count') {
    const body = await readBody(req);
    const p = store.petitions[body.p || ''];
    const sheet = p && shts(p).find(s => s.id === body.s);
    if (!p || !sheet) { json(res, 404, { error: 'No such sheet.' }); return true; }
    const viewer = viewerAccount(req, body.accountId);
    if (!isOwner(p, viewer)) { json(res, 403, { error: 'Only the organizer can confirm a sheet’s count.' }); return true; }

    if (body.remove) {
      for (const f of [sheet.file, sheet.publicFile]) {
        if (f) { try { fs.unlinkSync(uploadPath(p.id, f)); } catch {} }
      }
      store.sheets[p.id] = shts(p).filter(s => s.id !== sheet.id);
    } else if (body.status === 'rejected') {
      sheet.status = 'rejected';
      sheet.verifiedCount = 0;
    } else {
      sheet.verifiedCount = Math.min(60, Math.max(0, parseInt(body.verifiedCount, 10) || 0));
      sheet.status = 'counted';
    }
    saveStore();
    json(res, 200, { ok: true, counts: counts(p) });
    return true;
  }

  // POST /public/petition-sheet-publish — publish a redacted copy.
  // The browser flattens the original plus the organizer's black boxes onto a
  // canvas and posts the PNG; the unredacted original never becomes public.
  if (req.method === 'POST' && urlPath === '/public/petition-sheet-publish') {
    const body = await readBody(req);
    const p = store.petitions[body.p || ''];
    const sheet = p && shts(p).find(s => s.id === body.s);
    if (!p || !sheet) { json(res, 404, { error: 'No such sheet.' }); return true; }
    const viewer = viewerAccount(req, body.accountId);
    if (!isOwner(p, viewer)) { json(res, 403, { error: 'Only the organizer can publish a sheet.' }); return true; }

    if (body.unpublish) {
      sheet.public = false;
      if (sheet.publicFile) { try { fs.unlinkSync(uploadPath(p.id, sheet.publicFile)); } catch {} sheet.publicFile = null; }
      saveStore();
      json(res, 200, { ok: true, published: false });
      return true;
    }

    const m = String(body.image || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
    if (!m) { json(res, 400, { error: 'Expected a redacted PNG.' }); return true; }
    const png = Buffer.from(m[1], 'base64');
    if (png.length > 8 * 1024 * 1024) { json(res, 413, { error: 'The redacted image came out too large.' }); return true; }
    if (!sniff(png) || sniff(png).ext !== 'png') { json(res, 400, { error: 'That is not a PNG.' }); return true; }
    if (!(parseInt(body.boxes, 10) > 0)) {
      json(res, 400, { error: 'Cover the names and addresses first. A sheet goes public only with those columns blacked out.' });
      return true;
    }

    const dir = path.join(UPLOAD_DIR, p.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    sheet.publicFile = `${sheet.id}-public.png`;
    fs.writeFileSync(path.join(dir, sheet.publicFile), png, { mode: 0o644 });
    sheet.public = true;
    sheet.redactions = parseInt(body.boxes, 10);
    saveStore();
    json(res, 200, { ok: true, published: true });
    return true;
  }

  // GET /public/petition-export — the organizer's own copy, for delivery.
  // This is the only route that emits addresses or email addresses.
  if (req.method === 'GET' && urlPath === '/public/petition-export') {
    const p = store.petitions[q.get('p') || ''];
    if (!p) { json(res, 404, { error: 'No such petition.' }); return true; }
    const viewer = viewerAccount(req, q.get('account'));
    if (!isOwner(p, viewer)) { json(res, 403, { error: 'Only the organizer can export the signatures.' }); return true; }

    const cell = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const rows = [['Name', 'Street address', 'Email', 'Comment', 'Signed (UTC)', 'How',
      'Signature', 'Witnessed by', 'Shown publicly'].map(cell).join(',')];
    for (const s of activeSigs(p).filter(s => s.confirmed).sort((a, b) => a.ts - b.ts)) {
      rows.push([s.name, s.address || '', s.email || '', s.comment || '',
        new Date(s.ts).toISOString(),
        s.inPerson ? 'in person' : s.source === 'paper' ? 'paper sheet' : 'online',
        s.sigFile ? (s.signatureTyped ? 'typed' : 'drawn') : 'none',
        s.collectorName || '',
        s.showName === false ? 'no' : 'yes'].map(cell).join(','));
    }
    const csv = '﻿' + rows.join('\r\n') + '\r\n';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${p.slug}-signatures.csv"`,
      'Cache-Control': 'private, no-store',
    });
    res.end(csv);
    return true;
  }

  json(res, 404, { error: 'not found' });
  return true;
}

// ---------------------------------------------------------------- init

function init(context) {
  ctx = context;
  ctx.PLACE = ctx.PLACE || 'Croton-on-Hudson';
  DATA_DIR = process.env.POLIS_PETITIONS_DIR || path.join(ctx.DIR, 'petitions');
  STORE_FILE = path.join(DATA_DIR, 'petitions.json');
  UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  loadStore();
  prunePending();
  setInterval(prunePending, 6 * 3600000);
  return { handle };
}

module.exports = { init, handle };
