const test = require('node:test');
const assert = require('node:assert/strict');
const { startHub } = require('./hub.cjs');

const TOPIC = { conversation_id: 'abc123', topic: 'Pigeons in the park', is_active: true, created: 1 };
const fakePolis = (req) => {
  if (req.url.startsWith('/api/v3/conversations')) return [200, [TOPIC]];
  if (req.url.startsWith('/api/v3/participationInit')) {
    return [200, { auth: { token: 'tok' }, ptpt: { pid: 7 }, conversation: { topic: TOPIC.topic },
      nextComment: { tid: 1, txt: 'Feed them less', remaining: 1, total: 2 }, votes: [] }];
  }
  if (req.url.startsWith('/api/v3/votes')) return [200, { nextComment: { tid: 2, txt: 'Add a fountain', remaining: 0, total: 2 } }];
  return [200, {}];
};

const STATE = {
  userState: { '19145550100': { phase: 'idle', subscribed: true, zinvite: 'abc123' } },
  pendingNotifications: [{ phone: '19145550100', text: 'old nudge, no timestamp' }],
  waTopicGroups: { abc123: '120363000000000000@g.us' },
  webAccounts: {},
};

test('switched off: no /wa routes, and the bridge data is kept as it was', async (t) => {
  const hub = await startHub(t, { state: STATE, polis: fakePolis });
  assert.equal((await hub.post('/wa/dm', { phone: '19145550100', text: 'topics' })).status, 404);
  assert.equal((await fetch(hub.base + '/wa/pending-notifications')).status, 404);
  // Listing topics saves state (it mints the topic's slug); the WhatsApp
  // data must come back out exactly as it went in.
  assert.equal((await fetch(hub.base + '/public/topics')).status, 200);
  const s = hub.readState();
  assert.equal(s.topicSlugs['pigeons-in-the-park'], 'abc123', 'a save happened');
  assert.deepEqual(s.userState, STATE.userState);
  assert.deepEqual(s.pendingNotifications, STATE.pendingNotifications);
  assert.deepEqual(s.waTopicGroups, STATE.waTopicGroups);
  assert.match(hub.log(), /listening on/);
  assert.doesNotMatch(hub.log(), /WhatsApp bridge ON/);
});

test('switched on: voting by DM works end to end and stale queue items are dropped', async (t) => {
  const hub = await startHub(t, { state: STATE, polis: fakePolis, env: { POLIS_WHATSAPP: 'on' } });
  assert.match(hub.log(), /WhatsApp bridge ON/);
  const say = async (text) => {
    const r = await hub.post('/wa/dm', { phone: '19145550100', name: 'Maria', text });
    assert.equal(r.status, 200);
    const { responses } = await r.json();
    const all = responses.map((x) => x.text).join('\n');
    assert.doesNotMatch(all, /Something went wrong/, `reply to "${text}": ${all}`);
    return all;
  };
  assert.match(await say('topics'), /Pigeons in the park/);
  assert.match(await say('vote 1'), /Feed them less/);
  assert.match(await say('a'), /Add a fountain/);
  const vote = hub.calls.find((c) => c.url.startsWith('/api/v3/votes'));
  assert.equal(vote.body.vote, -1, 'a = agree = -1 in Polis');
  // The pre-shutdown backlog has no timestamp: dropped, not delivered weeks late.
  const drained = await (await fetch(hub.base + '/wa/pending-notifications')).json();
  assert.deepEqual(drained.notifications, []);
  // Fresh items go through.
  assert.equal((await hub.post('/wa/notify', { phone: '19145550100', text: 'hello' })).status, 200);
  const fresh = await (await fetch(hub.base + '/wa/pending-notifications')).json();
  assert.equal(fresh.notifications.length, 1);
  assert.equal(fresh.notifications[0].text, 'hello');
  assert.ok(fresh.notifications[0].ts);
});
