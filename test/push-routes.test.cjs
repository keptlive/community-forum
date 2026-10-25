const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startHub } = require('./hub.cjs');

// A browser: its push keys, and the subscription it would hand the page.
function browser(host = 'fcm.googleapis.com') {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh, auth,
    subscription: {
      endpoint: `https://${host}/fcm/send/${crypto.randomBytes(12).toString('base64url')}`,
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    },
  };
}

// RFC 8291, receiving side: what the browser does with a push body.
function decrypt(b, body) {
  const buf = Buffer.from(body, 'base64url');
  const salt = buf.subarray(0, 16);
  const idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen);
  const ct = buf.subarray(21 + idlen);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const uaPublic = b.ecdh.getPublicKey();
  const ikm = hmac(hmac(b.auth, b.ecdh.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  return JSON.parse(plain.subarray(0, plain.length - 1));
}

const settle = () => new Promise((r) => setTimeout(r, 150));

const fakePolis = (req) => {
  if (req.method === 'POST' && req.url === '/api/v3/conversations') return [200, { conversation_id: 'new123' }];
  if (req.url.startsWith('/api/v3/conversations')) return [200, []];
  return [200, {}];
};

test('one tap makes an account with notifications on this device, and the first one arrives', async (t) => {
  const hub = await startHub(t, { polis: fakePolis });
  const key = await (await fetch(hub.base + '/public/push-key')).json();
  assert.equal(Buffer.from(key.publicKey, 'base64url').length, 65);

  const bad = browser('evil.example');
  assert.equal((await hub.post('/public/push', { subscription: bad.subscription })).status, 400);

  const phone = browser();
  const xid = 'web:' + crypto.randomUUID();
  const r = await hub.post('/public/push', { subscription: phone.subscription, xid, allTopics: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /forum_acct=/);
  const acct = await r.json();
  assert.equal(acct.created, true);
  assert.equal(acct.channel, 'push');
  assert.equal(acct.xid, xid);
  assert.equal(acct.allTopics, true);
  assert.equal(acct.devices.length, 1);
  assert.equal(acct.devices[0].id, acct.deviceId);
  assert.equal(acct.devices[0].endpoint, undefined, 'endpoints never leave the server');

  await settle();
  const [welcome] = hub.pushes();
  assert.equal(welcome.endpoint, phone.subscription.endpoint);
  assert.equal(welcome.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(welcome.headers.TTL, '86400');
  const [, jwt, k] = welcome.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, key.publicKey);
  assert.equal(JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')).aud, 'https://fcm.googleapis.com');
  const msg = decrypt(phone, welcome.body);
  assert.equal(msg.title, 'Notifications are on');
  assert.equal(msg.tag, 'welcome');

  // Same browser again with no account in hand (storage cleared): same account, no second welcome.
  const again = await (await hub.post('/public/push', { subscription: phone.subscription, zinvite: 'abc123' })).json();
  assert.equal(again.accountId, acct.accountId);
  assert.equal(again.created, false);
  assert.deepEqual(again.subs, ['abc123']);
  await settle();
  assert.equal(hub.pushes().length, 1);

  // A new topic reaches accounts that asked for every new topic.
  const created = await hub.post('/public/create', { topic: 'Sidewalk on Grand Street', description: 'Should the village build one?', statements: [] });
  assert.equal(created.status, 200);
  await settle();
  const alert = hub.pushes().at(-1);
  const note = decrypt(phone, alert.body);
  assert.equal(note.title, 'New topic: Sidewalk on Grand Street');
  assert.equal(note.body, 'Should the village build one?');
  assert.match(note.url, /\/sidewalk-on-grand-street$/);
  assert.equal(note.tag, 't-new123');
  assert.ok(alert.headers.Topic, 'replaces an undelivered older alert about the same topic');

  // Turned off on this device.
  const off = await (await hub.post('/public/push-remove', { accountId: acct.accountId, endpoint: phone.subscription.endpoint })).json();
  assert.equal(off.removed, true);
  assert.deepEqual(off.devices, []);
  const s = hub.readState();
  assert.deepEqual(s.webAccounts[acct.accountId].devices, []);
  assert.equal(s.webAccounts[acct.accountId].xid, xid, 'the account and its votes stay');
});

test('a device moves with the browser to the account it is signed in to', async (t) => {
  const hub = await startHub(t, { polis: fakePolis });
  const phone = browser();
  const first = await (await hub.post('/public/push', { subscription: phone.subscription })).json();
  const laptop = browser();
  const second = await (await hub.post('/public/push', { subscription: laptop.subscription })).json();
  const moved = await (await hub.post('/public/push', { subscription: phone.subscription, accountId: second.accountId })).json();
  assert.equal(moved.accountId, second.accountId);
  assert.equal(moved.devices.length, 2);
  const s = hub.readState();
  assert.deepEqual(s.webAccounts[first.accountId].devices, []);
});

test('an iPhone Home Screen app signs in with a one-time code', async (t) => {
  const hub = await startHub(t, { polis: fakePolis });
  const acct = await (await hub.post('/public/push', { subscription: browser().subscription })).json();
  assert.equal((await hub.post('/public/device-code', { accountId: 'nobody' })).status, 404);
  const { code } = await (await hub.post('/public/device-code', { accountId: acct.accountId })).json();
  const redeemed = await hub.post('/public/device-redeem', { code });
  assert.equal(redeemed.status, 200);
  assert.equal((await redeemed.json()).accountId, acct.accountId);
  assert.match(redeemed.headers.get('set-cookie'), /forum_acct=/);
  assert.equal((await hub.post('/public/device-redeem', { code })).status, 410, 'one use only');
  assert.equal((await hub.post('/public/device-redeem', { code: 'made-up' })).status, 410);
});

test('signing up by email still works, and a WhatsApp number is ignored while the bridge is off', async (t) => {
  const hub = await startHub(t, { polis: fakePolis });
  const r = await hub.post('/public/account', { name: 'Maria', whatsapp: '9145550100' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /email/i);
  // A push account can add an email; the number in the same request is ignored.
  const acct = await (await hub.post('/public/push', { subscription: browser().subscription })).json();
  const edit = await hub.post('/public/account', { previousAccountId: acct.accountId, name: 'Maria', email: '', whatsapp: '9145550100' });
  assert.equal(edit.status, 200, 'a push-only account may save a profile with no email');
  const s = hub.readState();
  assert.equal(s.webAccounts[acct.accountId].whatsapp, null);
  assert.equal(s.webAccounts[acct.accountId].name, 'Maria');
});

test('confirming an email that already has an account folds the phone-only account into it', async (t) => {
  const desktop = browser(), phone = browser();
  const dev = (b, id) => ({ id, endpoint: b.subscription.endpoint, p256dh: b.subscription.keys.p256dh, auth: b.subscription.keys.auth, platform: 'other', created: '2026-10-01T00:00:00.000Z' });
  const state = {
    webAccounts: {
      older: { name: 'Maria', email: 'maria@example.org', emailVerified: true, verified: true, channel: 'email', contact: 'maria@example.org',
        subs: ['abc123'], allTopics: false, xid: 'web:11111111-1111-4111-8111-111111111111', devices: [dev(desktop, 'desk')] },
      phoneonly: { name: '', email: null, emailVerified: false, whatsappVerified: false, verified: true, channel: 'push', contact: null,
        subs: ['def456'], allTopics: true, xid: 'web:22222222-2222-4222-8222-222222222222', devices: [dev(phone, 'phone')] },
    },
    pendingVerifications: {
      claim1: { targetAccountId: 'phoneonly', contacts: [{ channel: 'email', contact: 'maria@example.org', token: 'tok-1' }], created: Date.now(), verified: false },
    },
  };
  const hub = await startHub(t, { state, polis: fakePolis });
  assert.equal((await fetch(hub.base + '/public/verify?token=tok-1')).status, 200);
  const s = hub.readState();
  assert.equal(s.webAccounts.phoneonly, undefined, 'the minutes-old account is the one that goes');
  const kept = s.webAccounts.older;
  assert.equal(kept.xid, 'web:11111111-1111-4111-8111-111111111111', 'the vote history stays with the older account');
  assert.deepEqual(kept.devices.map((d) => d.id), ['desk', 'phone'], 'both devices on the kept account');
  assert.deepEqual(kept.subs.sort(), ['abc123', 'def456']);
  assert.equal(kept.allTopics, true);
  const claim = await (await fetch(hub.base + '/public/claim?claim=claim1')).json();
  assert.equal(claim.accountId, 'older', 'the phone is handed the kept account');
});

test('a subscription on an account is only taken with its own keys; an unknown account is refused', async (t) => {
  const hub = await startHub(t, { polis: fakePolis });
  const phone = browser();
  const acct = await (await hub.post('/public/push', { subscription: phone.subscription })).json();
  const forged = { endpoint: phone.subscription.endpoint, keys: { p256dh: browser().subscription.keys.p256dh, auth: crypto.randomBytes(16).toString('base64url') } };
  const r = await hub.post('/public/push', { subscription: forged });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).accountId, undefined);
  assert.equal(hub.readState().webAccounts[acct.accountId].devices[0].auth, phone.subscription.keys.auth, 'keys untouched');
  const other = await (await hub.post('/public/push', { subscription: browser().subscription })).json();
  assert.equal((await hub.post('/public/push', { subscription: forged, accountId: other.accountId })).status, 403, 'nor moved by another account');
  // The real browser, storage cleared, gets its account back.
  assert.equal((await (await hub.post('/public/push', { subscription: phone.subscription })).json()).accountId, acct.accountId);
  const stale = await hub.post('/public/push', { subscription: browser().subscription, accountId: 'gone-account' });
  assert.equal(stale.status, 404);
  assert.equal(Object.keys(hub.readState().webAccounts).length, 2, 'no account made for a stale id');
});
