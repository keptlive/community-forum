# Community Forum

A headless community deliberation site built on top of a
[Polis](https://github.com/compdemocracy/polis) deployment. Residents browse
topics, vote agree/disagree on statements, write their own, and create new
topics — all from one lightweight page, with no login. Optional passwordless
accounts get updates on the topics they follow, as a notification on their
phone or computer (Web Push, no app) or by email. A WhatsApp bridge for voting
from chat is included but switched off.

The stock Polis admin console stays available (behind its own login) for
moderation; the public can only list, create, vote, and close *their own*
topics.

## Components

The public source includes the deployed Croton forum's notification devices,
verified email contacts, notification cooldowns, topic results and separate
petition workflow.
`server/petitions.js` stores petition records and private uploads separately from
voting state. Set `POLIS_PETITIONS_DIR` to a persistent private directory and
include it in backups; never commit its contents. Optional QR codes use
`qrcode-generator` when installed. Public pages and self-hosted fonts are in `web/`.
Set `POLIS_JWT_ISS` to the issuer configured in your Polis deployment, and set
`POLIS_BUG_EMAIL` for bug-report delivery (no private recipient is bundled).
Keep `X-External-Request: 1` on public proxy requests so the hub's allowlist
continues to deny private admin and WhatsApp control routes.

| Path | What it is |
|---|---|
| `server/polis-server.js` | The hub: a Node service (no dependencies) that proxies the Polis REST API with a self-signed admin JWT, exposes a small safe public API, and sends notifications (Web Push and Mailgun email) |
| `server/push.js` | Web Push with Node's `crypto`: VAPID (RFC 8292), payload encryption (RFC 8291), push-service allowlist |
| `server/petitions.js` | Petitions, with their own store |
| `server/whatsapp.js` | WhatsApp voting bridge, loaded only with `POLIS_WHATSAPP=on` |
| `web/landing.html` | The whole frontend: engagement-sorted topic list, inline voting, topic creation, account/follow UI. Self-contained HTML/CSS/JS |
| `web/sw.js`, `web/manifest.webmanifest`, `web/*.png` | Service worker that shows notifications, and the Home Screen app manifest and icons (iPhones only allow notifications from a Home Screen app) |
| `deploy/nginx-vhost.conf.example` | Routes `/` → landing page, `/public/` → hub API, conversation pages → Polis alpha client, everything else → Polis server |
| `deploy/community-forum.service.example` | systemd unit with all environment knobs |
| `deploy/ratelimit.conf` | nginx `limit_req_zone` for the public API |
| `deploy/docker-compose.override.yml` | Polis compose override: loopback-only port publishes, dev services disabled |
| `patches/alpha-client.patch` | Two small patches to Polis `client-participation-alpha`: subscribe box uses the hub's notifications; footer branding removed |
| `docs/` | Public API reference, WhatsApp bridge |
| `test/` | `node --test test/*.test.cjs`; `test/browser/e2e.cjs` drives the page in Chromium (needs `playwright-core`) |

## How it fits together

```
internet ── nginx (TLS)
   ├── /                → web/landing.html            (the forum UI)
   ├── /public/…        → hub :9876                   (safe public API, rate-limited)
   ├── /alpha/, /_astro/ → Polis participation client  (conversation pages)
   └── everything else  → Polis server :5000           (REST API, admin console)

WhatsApp ── your bot ── hub :9876 /wa/*   (loopback only; only with POLIS_WHATSAPP=on)
```

The browser votes **directly against the Polis API** (same origin) using an
anonymous per-browser XID — the hub is not in the voting hot path. The hub's
public surface is only `/public/*`: topic list, topic creation (validated,
honeypot, per-IP rate limits), account signup, notifications on a device,
follow/unfollow, and close-own-topic via a creator key handed out at creation.

## Setup

1. Run Polis via Docker Compose (see the Polis repo), with the server
   published on loopback (`deploy/docker-compose.override.yml`). Apply
   `patches/alpha-client.patch` to the Polis checkout and rebuild the web
   containers.
2. Generate an RS256 keypair; give Polis the public key (`server/keys/`, per
   Polis docs) and the hub the private key (`jwt-private.pem` next to
   `polis-server.js`, mode 600). The hub signs its own admin JWT with it.
3. Install the hub: copy `server/` somewhere, install the systemd unit from
   `deploy/community-forum.service.example`, set `POLIS_PUBLIC_URL`,
   `BRAND_NAME`, and (for email notifications) the Mailgun variables.
4. Install the nginx vhost from `deploy/nginx-vhost.conf.example` +
   `deploy/ratelimit.conf`, point DNS, get a certificate.
5. Copy `web/` (pages, `sw.js`, `manifest.webmanifest`, icons, fonts) to the
   vhost's web root and edit the branding text. The hub makes its VAPID key
   pair (`vapid.json`, next to the state file) on first start.
6. Optional: wire WhatsApp — see `docs/whatsapp-bridge.md`.

## Security notes

- The hub binds `127.0.0.1` only. nginx exposes **only** `/public/*`. The
  `/wa/*` and admin routes handle phone numbers and unauthenticated admin
  actions and must never be reachable from the internet.
- `voting-state.json` (accounts, contacts, notification devices, creator
  keys), `jwt-private.pem` and `vapid.json` are runtime secrets — all
  gitignored; never commit them. Back up `vapid.json`: browsers bind every
  subscription to that key, so losing it silently ends them all.
- Push subscriptions are accepted only for the browsers' own push services
  (Google, Apple, Mozilla, Microsoft), so the hub can't be pointed at other
  hosts.
- Topic creation is rate-limited (3/IP/hour, 20/day globally), length-capped,
  and honeypot-trapped. Emails carry per-topic and global unsubscribe links.

## License

[MIT](LICENSE)
