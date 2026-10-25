// A local croton.forum for browser checks: a fake Polis, the real hub, and a
// front server that routes like deploy/nginx (landing page, /public/ to the
// hub with X-External-Request, slugs via X-Accel-Redirect, static files).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const WEB = path.resolve(__dirname, '../../web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function startStack({ topics = [{ conversation_id: 'abc123', topic: 'Pigeons in the park', description: 'Feed them or not?' }] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-stack-'));
  const polis = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/v3/conversations')) {
      return res.end(JSON.stringify(topics.map((t) => ({ ...t, is_active: true, created: 1, participant_count: 3 }))));
    }
    if (req.url.startsWith('/api/v3/participationInit')) {
      return res.end(JSON.stringify({ auth: { token: 't' }, ptpt: { pid: 1 }, conversation: topics[0],
        nextComment: { tid: 1, txt: 'Feed them less', remaining: 0, total: 1 }, votes: [], pca: { asPOJO: { 'n-cmts': 1 } } }));
    }
    res.end('{}');
  });
  const polisPort = await listen(polis);

  const keyPath = path.join(dir, 'jwt.pem');
  fs.writeFileSync(keyPath, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const front = http.createServer();
  const frontPort = await listen(front);
  const base = `http://localhost:${frontPort}`;
  const outbox = path.join(dir, 'outbox.jsonl');
  const statePath = path.join(dir, 'state.json');
  // a free port for the hub
  const hubProbe = http.createServer();
  const realHubPort = await listen(hubProbe);
  await new Promise((r) => hubProbe.close(r));
  const hub = spawn(process.execPath, [path.resolve(__dirname, '../../server/polis-server.js')], {
    env: { ...process.env, PORT: String(realHubPort), STATE_FILE: statePath, POLIS_JWT_KEY: keyPath,
      POLIS_PETITIONS_DIR: path.join(dir, 'petitions'), IP_SALT_FILE: path.join(dir, 'salt'),
      POLIS_PUBLIC_URL: base, POLIS_API_URL: `http://127.0.0.1:${polisPort}`, POLIS_PUSH_TEST_OUTBOX: outbox,
      MAILGUN_API_KEY: '', MAILGUN_DOMAIN: '', POLIS_WHATSAPP: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  hub.stdout.on('data', (d) => { log += d; });
  hub.stderr.on('data', (d) => { log += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('hub did not start\n' + log)), 6000);
    hub.stdout.on('data', () => { if (log.includes('listening on')) { clearTimeout(t); resolve(); } });
  });

  const serveFile = (res, file) => {
    const p = path.join(WEB, file);
    if (!p.startsWith(WEB) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(p).pipe(res);
  };
  const toHub = (req, res) => {
    const up = http.request({ host: '127.0.0.1', port: realHubPort, path: req.url, method: req.method,
      headers: { ...req.headers, 'x-external-request': '1', 'x-real-ip': '127.0.0.1' } }, (r) => {
      const accel = r.headers['x-accel-redirect'];
      if (accel === '/_topic') { r.resume(); return serveFile(res, 'landing.html'); }
      if (accel) { r.resume(); res.writeHead(404); return res.end(); }
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    req.pipe(up);
  };
  front.on('request', (req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/') return serveFile(res, 'landing.html');
    if (p.startsWith('/public/') || p.startsWith('/t/') || /^\/[a-z0-9-]+$/.test(p)) return toHub(req, res);
    if (p.startsWith('/api/v3/')) {
      const up = http.request({ host: '127.0.0.1', port: polisPort, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      return req.pipe(up);
    }
    return serveFile(res, p.slice(1));
  });

  return {
    base,
    state: () => JSON.parse(fs.readFileSync(statePath, 'utf8')),
    pushes: () => (fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []),
    log: () => log,
    async stop() {
      hub.kill();
      await new Promise((r) => front.close(r));
      await new Promise((r) => polis.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { startStack };
