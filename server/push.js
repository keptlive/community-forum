// Web Push: notifications on a resident's phone or computer, with no app,
// account or third-party service. The browser's own push service (Google for
// Chrome and Android, Apple for iPhone and Safari, Mozilla, Microsoft) carries
// the message; we sign each request with our VAPID key (RFC 8292) and encrypt
// the payload to the browser's key (RFC 8291), so the push service sees
// neither who it is for nor what it says.
//
// Node's crypto only, like the rest of the hub. The shape follows HookPush
// (hookpush.live): the same endpoint allowlist, key checks, payload fields
// and fan-out, and devices are dropped when their push service says 404/410.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');

const MAX_PAYLOAD = 3990;      // bytes of JSON; encryption adds ~103 and push services take 4096
const DEFAULT_TTL = 86400;     // seconds a push service keeps trying a phone that is off
const FANOUT = 20;             // pushes in flight at once

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

// Only real push services, so a "subscription" can't aim the hub at an
// arbitrary host. Exact hosts where the parent domain also serves other
// people's content; any subdomain where the provider uses them for nothing
// else (Apple *.push.apple.com, Microsoft *.notify.windows.com).
const PUSH_HOST = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|([a-z0-9-]+\.)+push\.apple\.com|([a-z0-9-]+\.)+notify\.windows\.com)$/;

// A browser's keys: a P-256 public point (65 bytes, on the curve) and an auth
// secret of 16 bytes. Anything else could never receive a push.
const probe = crypto.createECDH('prime256v1');
probe.generateKeys();
function validKeys(p256dh, auth) {
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 128 || auth.length > 64) return false;
  const key = unb64u(p256dh);
  if (key.length !== 65 || key[0] !== 4 || unb64u(auth).length < 16) return false;
  try { probe.computeSecret(key); return true; } catch { return false; }
}

function validSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1024) return false;
  if (!sub.keys || !validKeys(sub.keys.p256dh, sub.keys.auth)) return false;
  let u;
  try { u = new URL(sub.endpoint); } catch { return false; }
  return u.protocol === 'https:' && PUSH_HOST.test(u.hostname);
}

// Which kind of device, for the account page and the logs. From the push
// service and the browser's user agent; never used to decide anything.
function platformOf(endpoint, ua = '') {
  let host = '';
  try { host = new URL(endpoint).hostname; } catch {}
  if (/iPhone|iPad|iPod/.test(ua)) return 'iphone';
  if (/push\.apple\.com$/.test(host)) return /Macintosh/.test(ua) ? 'mac' : 'iphone';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua) || /notify\.windows\.com$/.test(host)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Linux|CrOS|X11/.test(ua)) return 'linux';
  return 'other';
}

// The VAPID key pair, in web-push's format (65-byte public point, 32-byte
// private scalar, both base64url) so either tool can use the file. Losing it
// silently breaks every subscription: browsers bind each one to this key.
function loadVapid(file) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const keys = {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])),
    privateKey: jwk.d,
  };
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

function vapidSigner(keys, subject) {
  const pub = unb64u(keys.publicKey);
  const key = crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
  });
  const cache = new Map(); // audience -> { header, until }
  // Authorization header for one push service origin. A token lasts 12 h
  // (the limit is 24); it is reused for an hour, then re-signed.
  return function authorization(endpoint, now = Date.now()) {
    const aud = new URL(endpoint).origin;
    const hit = cache.get(aud);
    if (hit && hit.until > now) return hit.header;
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const body = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
    const header = `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.publicKey}`;
    cache.set(aud, { header, until: now + 3600 * 1000 });
    return header;
  };
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// RFC 8291 (aes128gcm): one record, encrypted to the browser's key. `salt`
// and `sender` (an ECDH key) are only passed by the tests, to reproduce the
// RFC's own example; normally both are fresh for every message.
function encrypt(plaintext, keys, { salt = crypto.randomBytes(16), sender } = {}) {
  const uaPublic = unb64u(keys.p256dh);
  const authSecret = unb64u(keys.auth);
  const ecdh = sender || crypto.createECDH('prime256v1');
  if (!sender) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ikm = hmac(hmac(authSecret, ecdh.computeSecret(uaPublic)),
    Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (and only) record.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Web Push Topic header: at most 32 characters of the base64url alphabet. A
// newer push with the same topic replaces an undelivered older one.
function topicHeader(tag) {
  if (!tag) return undefined;
  return /^[A-Za-z0-9_-]{1,32}$/.test(tag) ? tag : crypto.createHash('sha256').update(tag).digest('base64url').slice(0, 32);
}

// What the service worker reads (web/sw.js). `tag` makes a newer alert about
// the same topic replace the older one on the lock screen, and alert again.
function payloadOf(m) {
  const p = { title: String(m.title || '').slice(0, 120), body: String(m.body || '').slice(0, 600) };
  if (m.url) p.url = m.url;
  if (m.tag) { p.tag = m.tag; p.renotify = true; }
  return JSON.stringify(p);
}

// One HTTPS POST to a push service. Resolves { ok, status, gone }; never throws.
function post(endpoint, headers, body, agent) {
  return new Promise((resolve) => {
    const req = https.request(endpoint, { method: 'POST', headers: { ...headers, 'Content-Length': body.length }, agent, timeout: 15000 }, (res) => {
      let text = '';
      res.on('data', (c) => { if (text.length < 300) text += c; });
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        gone: res.statusCode === 404 || res.statusCode === 410,
        detail: res.statusCode >= 300 ? text.slice(0, 200) : undefined,
      }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, status: 0, gone: false, detail: e.message }));
    req.end(body);
  });
}

// keyFile: where the VAPID keys live (made on first start).
// subject: the contact push services see (an https URL or mailto:).
// outbox: TESTS ONLY — write each push as a JSON line there instead of sending.
function createPush({ keyFile, subject, outbox }) {
  const keys = loadVapid(keyFile);
  const authorization = vapidSigner(keys, subject);
  const agent = new https.Agent({ keepAlive: true, maxSockets: FANOUT });
  if (outbox) console.log(`push: TEST OUTBOX ${outbox} — nothing is sent to push services`);

  async function send(device, message, { ttl = DEFAULT_TTL, urgency = 'normal' } = {}) {
    const json = payloadOf(message);
    if (Buffer.byteLength(json) > MAX_PAYLOAD) return { ok: false, status: 413, gone: false, detail: 'payload too large' };
    const body = encrypt(json, { p256dh: device.p256dh, auth: device.auth });
    const headers = {
      TTL: String(ttl),
      Urgency: urgency,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: authorization(device.endpoint),
    };
    const topic = topicHeader(message.tag);
    if (topic) headers.Topic = topic;
    if (outbox) {
      fs.appendFileSync(outbox, JSON.stringify({ endpoint: device.endpoint, headers, body: b64u(body) }) + '\n');
      return { ok: true, status: 201, gone: false };
    }
    return post(device.endpoint, headers, body, agent);
  }

  // Sends to every device with at most FANOUT in flight. Results line up with
  // `devices`; a `gone` result means the browser dropped that subscription.
  async function fanout(devices, message, options) {
    const results = new Array(devices.length);
    let next = 0;
    async function worker() {
      while (next < devices.length) {
        const i = next++;
        results[i] = await send(devices[i], message, options);
      }
    }
    await Promise.all(Array.from({ length: Math.min(FANOUT, devices.length) }, worker));
    return results;
  }

  return { publicKey: keys.publicKey, send, fanout };
}

module.exports = { createPush, validSubscription, validKeys, platformOf, encrypt, topicHeader, payloadOf, vapidSigner, loadVapid };
