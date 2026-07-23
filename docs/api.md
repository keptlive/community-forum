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
- `POST /public/account` — `{ name?, channel: "email"|"whatsapp", contact,
  allTopics? }` → `{ accountId, name, channel, allTopics, subs }`.
  Passwordless: the accountId is the credential; the same contact always
  resolves to the same account. Phone numbers are normalized to digits
  (10-digit numbers get a US `1` prefix).
- `POST /public/subscribe` / `POST /public/unsubscribe` —
  `{ accountId, zinvite }` (unsubscribe also accepts `all: true`) → follows /
  unfollows a topic's notification group.
- `GET /public/unsubscribe?account=ID&z=ZINVITE|all=1` — HTML unsubscribe
  page for email footer links.

## Loopback-only (never expose)

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
statements appear, each follower of that topic's group is notified: email
accounts get a Mailgun message with vote link + unsubscribe links; WhatsApp
accounts get a queued DM (and their voting session is pointed at the topic so
replying `vote` just works). Accounts with `allTopics` also hear about every
newly created topic.
