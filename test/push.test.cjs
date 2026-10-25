const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const push = require('../server/push');

// RFC 8291 Appendix A: the worked example, byte for byte.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('encrypt reproduces the RFC 8291 example', () => {
  const sender = crypto.createECDH('prime256v1');
  sender.setPrivateKey(Buffer.from(RFC.asPrivate, 'base64url'));
  const out = push.encrypt(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth }, { salt: Buffer.from(RFC.salt, 'base64url'), sender });
  assert.equal(out.toString('base64url'), RFC.body);
});

// The decryptor web-push uses, when it can be found (HTTP_ECE=<path to the
// http_ece package> points at one outside node_modules).
const ecePath = (() => { try { return require.resolve(process.env.HTTP_ECE || 'http_ece'); } catch { return null; } })();
test('a fresh message decrypts with http_ece', { skip: !ecePath && 'http_ece not available' }, () => {
  const ece = require(ecePath);
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const json = JSON.stringify({ title: 'Croton', body: '3 new statements' });
  const out = push.encrypt(json, { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') });
  const plain = ece.decrypt(out, { version: 'aes128gcm', privateKey: ua, authSecret: auth.toString('base64url') });
  assert.equal(plain.toString(), json);
});

test('VAPID token verifies with the public key and names the push origin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-vapid-'));
  try {
    const file = path.join(dir, 'vapid.json');
    const keys = push.loadVapid(file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(push.loadVapid(file), keys, 'the second start reuses the same keys');
    const header = push.vapidSigner(keys, 'https://croton.forum')('https://fcm.googleapis.com/fcm/send/abc');
    const [, token, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.equal(k, keys.publicKey);
    const [h, b, s] = token.split('.');
    const claims = JSON.parse(Buffer.from(b, 'base64url'));
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    assert.equal(claims.sub, 'https://croton.forum');
    assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
    assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${b}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only real push services and well-formed keys are accepted', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/send/x',
    'https://web.push.apple.com/QFoo',
    'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://wns2-by3p.notify.windows.com/w/?token=x',
  ]) assert.ok(push.validSubscription({ endpoint, keys }), endpoint);
  for (const endpoint of [
    'http://fcm.googleapis.com/fcm/send/x',
    'https://storage.googleapis.com/x',
    'https://push.apple.com.evil.example/x',
    'https://127.0.0.1/x',
  ]) assert.ok(!push.validSubscription({ endpoint, keys }), endpoint);
  assert.ok(!push.validSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { ...keys, p256dh: 'AAAA' } }));
  assert.ok(!push.validSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { ...keys, auth: 'AA' } }));
});

test('topic header fits the 32-character base64url limit', () => {
  assert.equal(push.topicHeader('topic-abc123'), 'topic-abc123');
  const long = push.topicHeader('petition owner: “Save the Croton Point sledding hill”');
  assert.match(long, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(push.topicHeader(''), undefined);
});
