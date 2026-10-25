// Drives the real page in Chromium as an Android phone, an iPhone in Safari,
// the iPhone Home Screen app, and an app's in-app browser.
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node test/browser/e2e.cjs [shots-dir]
//
// The push service itself can't be reached from here (Chromium's needs Google
// keys), so PushManager hands back a subscription made with keys this script
// holds: everything else is real — permission, the page's flow, the hub,
// encryption (decrypted below with those keys), and the service worker
// showing a delivered push.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const { startStack } = require('./stack.cjs');

const UA = {
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  fbAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/470.0.0.0;]',
};
const shots = process.argv[2];
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, name + '.png') }); };

function fakeBrowserKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh, auth,
    endpoint: 'https://fcm.googleapis.com/fcm/send/' + crypto.randomBytes(12).toString('base64url'),
    p256dh: ecdh.getPublicKey().toString('base64url'),
    authB64: auth.toString('base64url'),
  };
}

function decrypt(k, body) {
  const buf = Buffer.from(body, 'base64url');
  const salt = buf.subarray(0, 16), idlen = buf[20], asPublic = buf.subarray(21, 21 + idlen), ct = buf.subarray(21 + idlen);
  const hmac = (key, d) => crypto.createHmac('sha256', key).update(d).digest();
  const ikm = hmac(hmac(k.auth, k.ecdh.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), k.ecdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const d = crypto.createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.length - 1));
}

// PushManager answers with our keys; a subscription survives reloads like a real one.
const stubPush = (k) => `(() => {
  const fake = ${JSON.stringify({ endpoint: k.endpoint, p256dh: k.p256dh, auth: k.authB64 })};
  const make = () => ({ endpoint: fake.endpoint, options: { applicationServerKey: null },
    toJSON() { return { endpoint: fake.endpoint, expirationTime: null, keys: { p256dh: fake.p256dh, auth: fake.auth } }; },
    unsubscribe() { localStorage.removeItem('__sub'); return Promise.resolve(true); } });
  PushManager.prototype.subscribe = function (opts) {
    window.__serverKey = Array.from(new Uint8Array(opts.applicationServerKey));
    localStorage.setItem('__sub', '1');
    return Promise.resolve(make());
  };
  PushManager.prototype.getSubscription = function () { return Promise.resolve(localStorage.getItem('__sub') ? make() : null); };
})();`;

async function modalState(page) {
  return page.evaluate(() => ({
    open: document.getElementById('acct-overlay').classList.contains('open'),
    viaRow: !document.getElementById('via-row').hidden,
    pushChecked: !!document.querySelector('input[name="a-channel"][value="push"]:checked'),
    pushName: document.getElementById('seg-push-name').textContent,
    pushPane: !document.getElementById('push-pane').hidden,
    emailPane: !document.getElementById('email-pane').hidden,
    save: document.getElementById('acct-save').textContent,
    adv: !document.getElementById('push-adv').hidden,
    advTitle: document.getElementById('push-adv-title').textContent,
    advText: document.getElementById('push-adv-body').textContent,
    note: document.getElementById('push-note').textContent,
    help: document.getElementById('push-help').textContent,
  }));
}

(async () => {
  const stack = await startStack();
  // The full browser: the headless shell denies notifications whatever is granted.
  const browser = await chromium.launch({ channel: 'chromium' });
  const results = [];
  const ok = (name) => { results.push(name); console.log('ok -', name); };
  try {
    // ---------------- Android, Chrome: one tap ----------------
    {
      const k = fakeBrowserKeys();
      const ctx = await browser.newContext({ userAgent: UA.android, viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true });
      await ctx.grantPermissions(['notifications'], { origin: stack.base });
      await ctx.addInitScript(stubPush(k));
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(stack.base + '/');
      await page.waitForSelector('[data-follow="abc123"]');
      await page.click('[data-follow="abc123"]');
      await page.waitForFunction(() => document.getElementById('acct-overlay').classList.contains('open'));
      await page.waitForFunction(() => !document.getElementById('via-row').hidden);
      let m = await modalState(page);
      assert.equal(m.pushChecked, true, 'notifications preselected');
      assert.equal(m.pushName, 'This phone');
      assert.equal(m.pushPane && !m.emailPane, true);
      assert.equal(m.save, 'Turn on notifications');
      assert.equal(m.adv, false, 'no Advanced section on Android');
      await shot(page, 'android-1-modal');
      ok('Android: Follow opens the modal with "This phone" first and one button');

      await page.click('#acct-save');
      await page.waitForFunction(() => /Notifications are on/.test(document.getElementById('screen-note').textContent));
      await page.waitForFunction(() => /Following/.test(document.querySelector('[data-follow="abc123"]').textContent));
      await shot(page, 'android-2-on');
      const ls = await page.evaluate(() => ({ a: JSON.parse(localStorage.getItem('ccf-account')), p: JSON.parse(localStorage.getItem('ccf-push')), key: window.__serverKey }));
      const keyNow = (await (await fetch(stack.base + '/public/push-key')).json()).publicKey;
      assert.deepEqual(Buffer.from(ls.key).toString('base64url'), keyNow, 'subscribed with the hub\'s VAPID key');
      assert.equal(ls.a.devices.length, 1);
      assert.equal(ls.p.accountId, ls.a.accountId);
      await new Promise((r) => setTimeout(r, 400));
      const st = stack.state();
      const acct = st.webAccounts[ls.a.accountId];
      assert.deepEqual(acct.subs, ['abc123'], 'the Follow went through after sign-up');
      assert.equal(acct.devices[0].endpoint, k.endpoint);
      assert.equal(acct.devices[0].platform, 'android');
      assert.equal(acct.channel, 'push');
      const welcome = stack.pushes().find((x) => x.endpoint === k.endpoint);
      assert.equal(decrypt(k, welcome.body).title, 'Notifications are on');
      ok('Android: one tap → account, device, follow, and an encrypted first notification');

      // The service worker shows what arrives, and opens its link.
      const cdp = await ctx.newCDPSession(page);
      const regs = [];
      cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => regs.push(...e.registrations));
      await cdp.send('ServiceWorker.enable');
      await page.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready);
      for (let i = 0; i < 20 && !regs.find((r) => !r.isDeleted); i++) await new Promise((r) => setTimeout(r, 100));
      const reg = regs.find((r) => !r.isDeleted);
      await cdp.send('ServiceWorker.deliverPushMessage', { origin: stack.base, registrationId: reg.registrationId,
        data: JSON.stringify({ title: 'Pigeons in the park', body: '2 new statements to vote on', url: stack.base + '/pigeons-in-the-park', tag: 't-abc123', renotify: true }) });
      let notes = [];
      for (let i = 0; i < 30 && !notes.length; i++) {
        notes = await page.evaluate(async () => {
          const r = await navigator.serviceWorker.ready;
          return (await r.getNotifications()).map((x) => ({ title: x.title, body: x.body, tag: x.tag, data: x.data }));
        });
        if (!notes.length) await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(notes[0].title, 'Pigeons in the park');
      assert.equal(notes[0].tag, 't-abc123');
      assert.match(notes[0].data.url, /pigeons-in-the-park$/);
      ok('Service worker: a delivered push shows as a notification with its topic link');

      // Reopen: on, with a way to turn it off.
      await page.click('#me-btn');
      await page.waitForFunction(() => /Notifications are on for this phone/.test(document.getElementById('push-note').textContent));
      m = await modalState(page);
      assert.equal(m.save, 'Save');
      await shot(page, 'android-3-reopen');
      await page.click('#push-off');
      await page.waitForFunction(() => /Notifications are off/.test(document.getElementById('screen-note').textContent));
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(stack.state().webAccounts[ls.a.accountId].devices, []);
      m = await modalState(page);
      assert.equal(m.save, 'Turn on notifications');
      ok('Android: Turn off removes this phone on the server and in the page');
      assert.deepEqual(errors, []);
      await ctx.close();
    }

    // ---------------- Android, blocked ----------------
    {
      const ctx = await browser.newContext({ userAgent: UA.android, viewport: { width: 412, height: 860 }, isMobile: true });
      await ctx.addInitScript(() => {
        Object.defineProperty(Notification, 'permission', { get: () => window.__perm || 'default' });
        Notification.requestPermission = () => { window.__perm = 'denied'; return Promise.resolve('denied'); };
      });
      const page = await ctx.newPage();
      await page.goto(stack.base + '/');
      await page.click('#me-btn');
      await page.waitForFunction(() => !document.getElementById('via-row').hidden);
      await page.click('#acct-save');
      await page.waitForFunction(() => /blocked/.test(document.getElementById('push-note').textContent));
      const m = await modalState(page);
      assert.match(m.help, /Permissions/);
      assert.equal(m.save, 'Save');
      await shot(page, 'android-4-blocked');
      ok('Android: "Block" shows how to allow it again, for Chrome on Android');
      await ctx.close();
    }

    // ---------------- iPhone, Safari tab: email first, push under Advanced ----------------
    let deviceUrl;
    let iphoneAccount;
    {
      const ctx = await browser.newContext({ userAgent: UA.iphone, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await ctx.addInitScript(() => { delete window.PushManager; });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(stack.base + '/');
      await page.click('#me-btn');
      await page.waitForFunction(() => document.getElementById('acct-overlay').classList.contains('open'));
      await new Promise((r) => setTimeout(r, 200));
      let m = await modalState(page);
      assert.equal(m.viaRow, false, 'no channel switch: email is the way in');
      assert.equal(m.emailPane, true);
      assert.equal(m.save, 'Save');
      assert.equal(m.adv, true);
      assert.equal(m.advTitle, 'Advanced: notifications on this iPhone');
      assert.match(m.advText, /Add to Home Screen/);
      assert.match(m.advText, /bottom of the screen/);
      await page.click('#push-adv-title');
      await shot(page, 'iphone-1-safari-advanced');
      ok('iPhone Safari: email up front, Home Screen steps under Advanced');

      // Signed in (an account made elsewhere), the Advanced steps put a one-time code in the address.
      const k = fakeBrowserKeys();
      const r = await fetch(stack.base + '/public/push', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: { endpoint: k.endpoint, keys: { p256dh: k.p256dh, auth: k.authB64 } }, name: 'Maria' }) });
      iphoneAccount = await r.json();
      await page.evaluate((a) => localStorage.setItem('ccf-account', JSON.stringify(a)), iphoneAccount);
      await page.goto(stack.base + '/pigeons-in-the-park');
      await page.click('#me-btn');
      await page.waitForFunction(() => !document.getElementById('push-adv').hidden);
      m = await modalState(page);
      assert.match(m.advText, /signed in there too/);
      await page.click('#push-adv-title');
      await page.waitForFunction(() => /[?&]device=/.test(location.search));
      deviceUrl = await page.evaluate(() => location.href);
      assert.match(deviceUrl, /\/pigeons-in-the-park\?device=/);
      ok('iPhone Safari, signed in: opening Advanced puts a one-time sign-in code in the address');
      assert.deepEqual(errors, []);
      await ctx.close();
    }

    // ---------------- iPhone Home Screen app: signed in by the code, one tap ----------------
    {
      const k = fakeBrowserKeys();
      const ctx = await browser.newContext({ userAgent: UA.iphone, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await ctx.grantPermissions(['notifications'], { origin: stack.base });
      await ctx.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { get: () => true }); });
      await ctx.addInitScript(stubPush(k));
      const page = await ctx.newPage();
      await page.goto(deviceUrl);
      await page.waitForFunction(() => document.getElementById('acct-overlay').classList.contains('open'));
      await page.waitForFunction(() => !document.getElementById('via-row').hidden);
      const signedIn = await page.evaluate(() => JSON.parse(localStorage.getItem('ccf-account')));
      assert.equal(signedIn.accountId, iphoneAccount.accountId);
      assert.doesNotMatch(await page.evaluate(() => location.search), /device=/, 'the code leaves the address');
      const m = await modalState(page);
      assert.equal(m.pushName, 'This phone');
      assert.equal(m.save, 'Turn on notifications');
      assert.equal(m.adv, false);
      await shot(page, 'iphone-2-homescreen');
      await page.click('#acct-save');
      await page.waitForFunction(() => /Notifications are on/.test(document.getElementById('screen-note').textContent));
      await new Promise((r) => setTimeout(r, 300));
      const devices = stack.state().webAccounts[iphoneAccount.accountId].devices;
      assert.equal(devices.length, 2, 'the app joins the same account');
      assert.equal(devices[1].platform, 'iphone');
      ok('iPhone Home Screen app: opens signed in to the same account, one tap turns notifications on');
      await ctx.close();
    }

    // ---------------- An Android app's in-app browser ----------------
    {
      const ctx = await browser.newContext({ userAgent: UA.fbAndroid, viewport: { width: 412, height: 860 }, isMobile: true });
      await ctx.addInitScript(() => { delete window.PushManager; });
      const page = await ctx.newPage();
      await page.goto(stack.base + '/');
      await page.click('#me-btn');
      await new Promise((r) => setTimeout(r, 200));
      const m = await modalState(page);
      assert.equal(m.viaRow, false);
      assert.equal(m.adv, true);
      assert.match(m.advText, /Open in Chrome/);
      ok('Android in-app browser: email up front, "open in Chrome" under Advanced');
      await ctx.close();
    }

    // ---------------- A computer ----------------
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      const page = await ctx.newPage();
      await page.goto(stack.base + '/');
      await page.click('#me-btn');
      await page.waitForFunction(() => !document.getElementById('via-row').hidden);
      const m = await modalState(page);
      assert.equal(m.pushName, 'This computer');
      await shot(page, 'desktop-1-modal');
      ok('Computer: "This computer" offered in one tap');
      await ctx.close();
    }
    console.log(`\n${results.length} browser checks passed`);
  } catch (e) {
    console.error('FAILED:', e.message);
    console.error(stack.log().slice(-2000));
    process.exitCode = 1;
  } finally {
    await browser.close();
    await stack.stop();
  }
})();
