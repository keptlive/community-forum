# WhatsApp Bridge

`server/whatsapp.js` contains the complete voting state machine for chat
(`/wa/dm`, `/wa/group`) — you just need to connect it to whatever service
actually sends and receives WhatsApp messages (a Baileys bot, Twilio, etc.).

The bridge is off by default. Set `POLIS_WHATSAPP=on` to load it, with
`POLIS_WA_ANNOUNCE_JID` (announcements group), `POLIS_WA_COMMUNITY_JID`
(parent community for per-topic subgroups) and `POLIS_WA_SUPPORT_JID` (bug
reports) as needed. Off, the `/wa/*` routes don't exist, nothing is queued,
and WhatsApp numbers already on accounts are kept but not used. Queued
messages older than a day are dropped rather than delivered late.

Three integration points:

## 1. Inbound DMs

Forward a user's DM to the hub and send back the responses:

```js
const POLIS_BASE = 'http://localhost:9876';
const POLIS_ENTRY = /^(topics|vote|voting)$/i;

async function polisSessionActive(phone) {
  try {
    const r = await fetch(`${POLIS_BASE}/wa/state/${encodeURIComponent(phone)}`);
    const s = await r.json();
    return !!(s && (s.zinvite || (s.phase && s.phase !== 'idle')));
  } catch { return false; }
}

// In your DM handler — route voting traffic to the hub, everything else to
// your normal bot logic:
if (POLIS_ENTRY.test(text.trim()) || await polisSessionActive(phone)) {
  const r = await fetch(`${POLIS_BASE}/wa/dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, name, text }),
  });
  const { responses } = await r.json();
  // send each responses[i].text back to the user
}
```

The session check matters: once a user types `topics`, every following
message (topic numbers, `agree`/`disagree`/`skip`, free-text statements)
belongs to the voting flow until they type `stop`.

## 2. Outbound notifications

Poll the hub's queue from the component that can send DMs:

```js
const { notifications } = await (await fetch(
  `${POLIS_BASE}/wa/pending-notifications`)).json();
for (const n of notifications) sendWhatsAppDM(n.phone, n.text);
```

The queue drains on read — poll from exactly one place.

## 3. Group chats (optional)

`POST /wa/group` handles group messages (`topics` lists topics; a number
reply confirms in the group and DMs the first statement). Responses with a
`dmPhone` field should be sent as a DM to that number instead of the group.
