# Community Forum

A headless community deliberation site built on top of a
[Polis](https://github.com/compdemocracy/polis) deployment. Residents browse
topics, vote agree/disagree on statements, write their own, and create new
topics — all from one lightweight page, with no login. Optional passwordless
"accounts" (name + email or WhatsApp number) power per-topic notification
groups. A WhatsApp bridge lets people do the entire voting flow from chat.

The stock Polis admin console stays available (behind its own login) for
moderation; the public can only list, create, vote, and close *their own*
topics.

## Components

| Path | What it is |
|---|---|
| `server/polis-server.js` | The hub: a single-file Node service (no dependencies) that proxies the Polis REST API with a self-signed admin JWT, exposes a small safe public API, runs the WhatsApp voting state machine, and sends notifications (Mailgun email + WhatsApp queue) |
| `web/landing.html` | The whole frontend: engagement-sorted topic list, inline voting, topic creation, account/follow UI. Self-contained HTML/CSS/JS |
| `deploy/nginx-vhost.conf.example` | Routes `/` → landing page, `/public/` → hub API, conversation pages → Polis alpha client, everything else → Polis server |
| `deploy/community-forum.service.example` | systemd unit with all environment knobs |
| `deploy/ratelimit.conf` | nginx `limit_req_zone` for the public API |
| `deploy/docker-compose.override.yml` | Polis compose override: loopback-only port publishes, dev services disabled |
| `patches/alpha-client.patch` | Two small patches to Polis `client-participation-alpha`: subscribe box uses the hub's notifications; footer branding removed |
| `docs/` | Architecture, public API reference, WhatsApp bridge |

## How it fits together

```
internet ── nginx (TLS)
   ├── /                → web/landing.html            (the forum UI)
   ├── /public/…        → hub :9876                   (safe public API, rate-limited)
   ├── /alpha/, /_astro/ → Polis participation client  (conversation pages)
   └── everything else  → Polis server :5000           (REST API, admin console)

WhatsApp ── your bot ── hub :9876 /wa/*   (loopback only — never exposed)
```

The browser votes **directly against the Polis API** (same origin) using an
anonymous per-browser XID — the hub is not in the voting hot path. The hub's
public surface is only `/public/*`: topic list, topic creation (validated,
honeypot, per-IP rate limits), account signup, follow/unfollow, and
close-own-topic via a creator key handed out at creation.

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
5. Copy `web/landing.html` to the vhost's web root and edit the branding text.
6. Optional: wire WhatsApp — see `docs/whatsapp-bridge.md`.

## Security notes

- The hub binds `127.0.0.1` only. nginx exposes **only** `/public/*`. The
  `/wa/*` and admin routes handle phone numbers and unauthenticated admin
  actions and must never be reachable from the internet.
- `voting-state.json` (accounts, phone numbers, creator keys) and
  `jwt-private.pem` are runtime secrets — both are gitignored; never commit
  them.
- Topic creation is rate-limited (3/IP/hour, 20/day globally), length-capped,
  and honeypot-trapped. Emails carry per-topic and global unsubscribe links.
