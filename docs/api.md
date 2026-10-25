# Hub API

The hub listens on `127.0.0.1:9876`. Two surfaces:

## Public (`/public/*` — the only routes nginx may expose)

- `GET /public/topics` — active topics, engagement-sorted:
  `[{ zinvite, topic, description, participant_count, statement_count,
  followers, url, community }]`
- `POST /public/create` — `{ topic, description?, statements?: string[≤5],
  accountId?, website }` → `{ zinvite, url, topic, seeded, creatorKey }`.
  `website` is a honeypot and must be empty. Title ≥ 8 chars; per-IP and
  global rate limits (429). The `creatorKey` authorizes closing this topic.
- `POST /public/close` — `{ zinvite, key }` → deactivates the topic.
  Creator-only (403 otherwise).
- `POST /public/account` — `{ name?, email?, allTopics?, previousAccountId?,
  xid? }`. A new or changed email gets a confirmation link and the answer is
  `{ pending: true, claimId }`; the page polls `GET /public/claim?claim=ID`
  until the link is opened. Profile edits on a signed-in account
  (`previousAccountId`) save at once and return the account. Passwordless:
  the accountId is the credential.
- `GET /public/push-key` — `{ publicKey }`, the VAPID key browsers subscribe
  with.
- `POST /public/push` — `{ subscription, accountId?, name?, allTopics?,
  zinvite?, xid? }` → the account plus `deviceId` and `created`. Adds this
  browser's push subscription to the account, to the account that already
  holds it (only with the same keys), or to a new account with no email.
  No confirmation step: the subscription proves the device. A first
  notification is sent at once. Sent again quietly on page load. 404 for an
  unknown `accountId`.
- `POST /public/push-remove` — `{ accountId, endpoint }` or
  `{ accountId, deviceId }` → stops notifications on that device.
- `POST /public/device-code` — `{ accountId }` → `{ code }`, and
  `POST /public/device-redeem` — `{ code }` → the account. A one-time code
  (30 minutes) that signs an iPhone Home Screen app, which starts with its
  own storage, in to the same account.
- `POST /public/subscribe` / `POST /public/unsubscribe` —
  `{ accountId, zinvite }` (unsubscribe also accepts `all: true`) → follows /
  unfollows a topic's notification group.
- `GET /public/unsubscribe?account=ID&z=ZINVITE|all=1` — HTML unsubscribe
  page for email footer links.

## Loopback-only (never expose)

The `/wa/*` routes exist only with `POLIS_WHATSAPP=on`.

- `POST /create`, `POST /seed`, `POST /seed-bulk`, `GET /info/:zinvite` —
  unrestricted admin conversation management (used by trusted local bots).
- `GET /conversations` — active topic list.
- `POST /wa/group`, `POST /wa/dm` — WhatsApp voting state machine
  (`{ phone, name, text }` → `{ responses: [{ text, dmPhone? }] }`).
- `GET /wa/pending-notifications` — drain queued outbound DMs (poll this from
  the component that can actually send WhatsApp messages).
- `POST /wa/notify` — `{ phone, text }` queue an outbound DM.
- `GET /wa/state/:phone` — a user's voting-session state.

## Voting from the browser

The frontend talks straight to Polis (same origin), not through the hub:

1. `GET /api/v3/participationInit?conversation_id=Z&xid=web:<uuid>` →
   `auth.token` (Bearer) + `nextComment`
2. `POST /api/v3/votes` `{ conversation_id, tid, vote: -1|0|1 }`
3. `POST /api/v3/comments` `{ conversation_id, txt }`

The `xid` is a random per-browser ID kept in localStorage — the same
mechanism the WhatsApp flow uses with phone numbers.

## Notifications

A 5-minute checker diffs each conversation's statement count. When new
statements appear, each follower of that topic is notified, at most once an
hour per topic: every device on the account gets a push notification that
opens the topic; a confirmed email gets a Mailgun message with vote links and
unsubscribe links; with the WhatsApp bridge on, a WhatsApp contact gets a
queued DM. Followers also hear when a topic closes, and get a weekly reminder
of statements they haven't voted on. Accounts with `allTopics` hear about
every new topic and petition.

Push payloads are encrypted to the device (RFC 8291) and signed with the
hub's VAPID key (RFC 8292). A device whose push service answers 404 or 410
is removed.
