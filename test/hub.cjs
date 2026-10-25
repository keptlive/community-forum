// Starts the real hub on a free port with its own state directory and a fake
// Polis upstream. `polis(req, body)` returns [status, json] for each upstream call.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function freePort() {
  const s = http.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function startHub(t, { state = {}, env = {}, polis = () => [200, {}] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-hub-'));
  const statePath = path.join(dir, 'state.json');
  const keyPath = path.join(dir, 'jwt.pem');
  fs.writeFileSync(keyPath, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(statePath, JSON.stringify(state));
  const calls = [];
  const upstream = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(data || '{}'); } catch {}
      calls.push({ method: req.method, url: req.url, body });
      const [status, json] = polis(req, body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const outbox = path.join(dir, 'outbox.jsonl');
  const child = spawn(process.execPath, [path.resolve(__dirname, '../server/polis-server.js')], {
    env: {
      ...process.env, PORT: String(port), STATE_FILE: statePath, POLIS_JWT_KEY: keyPath,
      POLIS_PETITIONS_DIR: path.join(dir, 'petitions'), IP_SALT_FILE: path.join(dir, 'salt'),
      POLIS_PUBLIC_URL: base, POLIS_API_URL: 'http://127.0.0.1:' + upstream.address().port,
      POLIS_PUSH_TEST_OUTBOX: outbox, MAILGUN_API_KEY: '', MAILGUN_DOMAIN: '', POLIS_WHATSAPP: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
    await new Promise((r) => upstream.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hub did not start:\n' + log)), 5000);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`hub exited ${code}:\n${log}`)); });
    child.stdout.on('data', () => { if (log.includes('listening on')) { clearTimeout(timer); resolve(); } });
  });
  const post = (route, body, headers = {}) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const pushes = () => (fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  return { base, post, readState, pushes, calls, log: () => log, dir };
}

module.exports = { startHub };
