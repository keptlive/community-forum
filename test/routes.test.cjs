const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('creator authorization and unsubscribe persist through real HTTP routes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-routes-'));
  const statePath = path.join(dir, 'state.json');
  const keyPath = path.join(dir, 'jwt.pem');
  fs.writeFileSync(keyPath, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(statePath, JSON.stringify({
    userState: { phone: { subscribed: true } },
    communityTopics: { topic: { creatorKey: 'owner-secret' } },
    webAccounts: { account: { channel: 'whatsapp', contact: 'phone', subs: ['topic', 'another'], allTopics: true } }
  }));
  let upstreamCalls = 0;
  const upstream = http.createServer((req, res) => {
    upstreamCalls++;
    assert.equal(req.method, 'PUT');
    assert.equal(req.url, '/api/v3/conversations');
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const reserve = http.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const child = spawn(process.execPath, [path.resolve(__dirname, '../server/polis-server.js')], {
    env: { ...process.env, PORT: String(port), STATE_FILE: statePath, POLIS_JWT_KEY: keyPath,
      POLIS_WHATSAPP: 'on', POLIS_PETITIONS_DIR: path.join(dir, 'petitions'), IP_SALT_FILE: path.join(dir, 'salt'), POLIS_PUBLIC_URL: 'http://127.0.0.1:' + port,
      POLIS_API_URL: 'http://127.0.0.1:' + upstream.address().port },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error('server exited: ' + code)); });
    child.stdout.on('data', data => {
      if (data.toString().includes('listening on')) { clearTimeout(timer); resolve(); }
    });
  });
  const request = (route, body) => fetch('http://127.0.0.1:' + port + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  assert.equal((await request('/public/close', { zinvite: 'topic', key: 'wrong' })).status, 403);
  assert.equal(upstreamCalls, 0);
  assert.equal((await request('/public/close', { zinvite: 'topic', key: 'owner-secret' })).status, 200);
  assert.equal(upstreamCalls, 1);
  assert.equal((await request('/public/unsubscribe', { accountId: 'account', zinvite: 'topic' })).status, 200);
  let state = JSON.parse(fs.readFileSync(statePath));
  assert.deepEqual(state.webAccounts.account.subs, ['another']);
  assert.equal(state.webAccounts.account.allTopics, true);
  assert.equal((await request('/public/unsubscribe', { accountId: 'account', all: true })).status, 200);
  state = JSON.parse(fs.readFileSync(statePath));
  assert.deepEqual(state.webAccounts.account.subs, []);
  assert.equal(state.webAccounts.account.allTopics, false);
  assert.equal(state.userState.phone.subscribed, false);
  assert.equal((await request('/public/unsubscribe', { accountId: 'missing', all: true })).status, 404);
  const callsBefore = upstreamCalls;
  for (const route of ['/create', '/seed', '/seed-bulk', '/wa/notify']) {
    const response = await fetch('http://127.0.0.1:' + port + route, {
      method: 'POST', headers: {'Content-Type': 'application/json', 'X-External-Request': '1'}, body: '{}'
    });
    assert.equal(response.status, 404, route);
  }
  assert.equal(upstreamCalls, callsBefore, 'external admin requests never reach Polis');
  assert.equal((await fetch('http://127.0.0.1:' + port + '/petitions')).status, 200);
});
