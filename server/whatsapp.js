// WhatsApp bridge — switched OFF unless POLIS_WHATSAPP=on.
//
// Everything the forum ever did over WhatsApp: voting by direct message (a
// small state machine), the community announcement group, per-topic
// subgroups, and the outgoing queue that WireClaw collects from
// GET /wa/pending-notifications. Retired in October 2026 for notifications on
// the phone itself (push.js), and kept here, working, so it can come back.
// Its data — DM sessions, the queue, the subgroup map — stays in the hub's
// state file whether or not the bridge is on.
//
// Same shape as petitions.js: init(ctx) with the hub's helpers, then
// handle(req, res) for the /wa/* routes, plus the calls the hub makes when
// something happens (a topic closes, statements arrive, a member signs up).

let ctx;
let userState, pendingNotifications, waTopicGroups;
let BRAND_NAME, PUBLIC_URL, PORT, WA_ANNOUNCE_JID, WA_COMMUNITY_JID, WA_SUPPORT_JID;
let saveState, readBody, getActiveConversations, initByXid, vote, getComments, submitComment, topicUrl, accounts, markAuthor;

// In-flight subgroup creation asks (zinvite -> ts), so a slow WireClaw
// doesn't get duplicate create actions every sync cycle.
const waTopicGroupRequests = {};

// A queued message older than this is news nobody needs any more: it is
// dropped instead of handed to WireClaw (also covers the backlog left from
// before the bridge was switched off, which carries no timestamp).
const QUEUE_MAX_AGE = 24 * 3600000;

function queue(n) {
  pendingNotifications.push({ ...n, ts: Date.now() });
}

function drain() {
  const now = Date.now();
  return pendingNotifications.splice(0).filter(n => n.ts && now - n.ts < QUEUE_MAX_AGE);
}

// --- What the hub tells the bridge ---

// A direct message to one member.
function dm(phone, text) { queue({ phone, text }); }

// Point the member's DM session at a topic unless they are mid-conversation,
// so a bare "vote" reply lands in the right place; then message them.
function alert(phone, zinvite, topic, text) {
  const st = userState[phone] || { phase: 'idle' };
  if (!st.zinvite || st.phase === 'idle') { st.zinvite = zinvite; st.topic = topic; }
  userState[phone] = st;
  dm(phone, text);
}

// First verified WhatsApp contact gets the onboarding DM.
function welcome(phone) { dm(phone, formatWelcome()); }

function announce(text) { if (WA_ANNOUNCE_JID) queue({ phone: WA_ANNOUNCE_JID, text }); }
function support(text) { if (WA_SUPPORT_JID) queue({ phone: WA_SUPPORT_JID, text }); }

// Legacy per-phone subscription, kept in step with web follows.
function setSubscribed(phone, on) {
  if (on) {
    const st = userState[phone] || { phase: 'idle' };
    st.subscribed = true;
    userState[phone] = st;
  } else if (userState[phone]) {
    userState[phone].subscribed = false;
  }
}

// New statements in a topic: DM sessions subscribed to it (the original
// per-phone subscriptions) and the topic's own subgroup. Returns the phones
// alerted, so the hub's follower fan-out doesn't message them twice.
// notifyCount is the hub's cooldown (shared with every other channel).
function newStatements(conv, newCount, notifyCount) {
  const notifiedPhones = [];
  for (const [phone, state] of Object.entries(userState)) {
    if (state.subscribed && state.zinvite === conv.zinvite) {
      notifiedPhones.push(phone); // counts for dedupe even when cooling down
      const n = notifyCount(phone, conv.zinvite, newCount);
      if (!n) continue;
      queue({
        phone,
        text: `🔔 *${n} new statement${n > 1 ? 's' : ''}* to vote on!\n\n_${conv.topic}_\n\nType *vote* to continue voting.`,
      });
    }
  }
  // Statement alerts go ONLY to the topic's own subgroup — the Announcements
  // feed is reserved for new topics. Voting is private: point people to DM or
  // the website, never a public group reply.
  const gJid = waTopicGroups[conv.zinvite];
  const gCount = gJid ? notifyCount(gJid, conv.zinvite, newCount) : 0;
  if (gCount) {
    queue({
      phone: gJid,
      text: `🔔 *${gCount} new statement${gCount > 1 ? 's' : ''}* to vote on in this topic.\n\nVoting is private — send me *vote* in a direct message, or vote anonymously at ${topicUrl(conv.zinvite, conv.topic)}`,
    });
  }
  return notifiedPhones;
}

// A topic closed: final message + [closed] rename for its subgroup, and any
// DM sessions parked on it go idle.
function topicClosed(z, topic, closeMsg) {
  if (waTopicGroups[z]) {
    queue({ phone: waTopicGroups[z], text: closeMsg });
    queue({
      action: 'rename-group',
      jid: waTopicGroups[z],
      subject: `[closed] ${topic}`.slice(0, 80),
    });
    delete waTopicGroups[z];
  }
  for (const st of Object.values(userState)) {
    if (st.zinvite === z) {
      st.subscribed = false;
      if (st.phase === 'voting' || st.phase === 'revoting') st.phase = 'idle';
    }
  }
}

// The weekly "statements waiting" nudge, WhatsApp edition.
function nudge(phone, backlog, total) {
  let text = `👋 You have *${total} statement${total > 1 ? 's' : ''}* waiting for your vote:\n`;
  backlog.forEach(b => { text += `\n• ${b.topic} — ${b.unvoted}`; });
  text += `\n\nReply *vote* to catch up, or *unsubscribe* to stop updates.`;
  alert(phone, backlog[0].z, backlog[0].topic, text);
}

// --- Voting over WhatsApp ---

// One person = one Polis participant, no matter the surface. A verified
// account carries a canonical xid (whatsapp → phone digits, email → the
// browser xid captured at signup); WhatsApp sessions resolve through it so
// web, email, and DM votes all land on the same participant.
function canonicalXid(phoneish) {
  const digits = String(phoneish).replace(/\D/g, '');
  if (digits) {
    for (const acct of Object.values(accounts())) {
      if (acct.whatsapp === digits && acct.whatsappVerified && acct.xid) {
        return acct.xid;
      }
    }
  }
  return String(phoneish);
}

async function initUserForConversation(phone, zinvite) {
  return initByXid(canonicalXid(phone), zinvite);
}

// --- WhatsApp voting handler ---

function formatStatement(comment, remaining, total) {
  const voted = total - remaining;
  return `📊 *Statement ${voted + 1} of ${total}*\n\n"${comment.txt}"\n\n*Do you agree?* Reply with one letter:\n\n*a* — 👍 agree\n*d* — 👎 disagree\n*p* — ⏭️ pass (skip this one)`;
}

const VOTE_LABEL = { '-1': '👍 agree', '1': '👎 disagree', '0': '⏭️ pass' };

function formatRevote(state) {
  const item = state.revoteList[state.revoteIndex];
  const n = state.revoteIndex + 1;
  return `🔁 *Reviewing your votes — ${n} of ${state.revoteList.length}*\n\n"${item.txt}"\n\nYour vote: ${VOTE_LABEL[String(item.vote)] || '—'}\n\nReply *a* / *d* / *p* to change it, *k* to keep it, or *done* to finish.`;
}

function formatTopicList(conversations, joined) {
  if (conversations.length === 0) {
    return '📭 No active topics right now. Check back later!';
  }
  let msg = '🗳️ *Open Community Topics*\n\n';
  conversations.forEach((c, i) => {
    const mark = joined && joined.has(c.zinvite) ? ' ✓' : '';
    msg += `*${i + 1}.* ${c.topic}${mark}\n`;
    if (c.description) msg += `   _${c.description.slice(0, 80)}${c.description.length > 80 ? '...' : ''}_\n`;
    msg += '\n';
  });
  msg += 'Reply *vote 1* (or just the number) to vote on topic 1.' +
    (joined && joined.size ? '\n✓ = topics you follow' : '');
  return msg;
}

function formatWelcome() {
  return `👋 *Welcome to ${BRAND_NAME}!*\n\nVote on community topics right here — your votes stay private.\n\n*topics* — see open topics\n*vote 2* — vote on topic #2\n*my topics* — topics you follow\n*revote* — review & change your votes\n*new* — write your own statement\n*unsubscribe* — stop updates\n\nFollow topics at ${PUBLIC_URL} to get updates here.`;
}

// Enter a topic with a purpose: 'vote' → first unvoted statement,
// 'write' → straight to the statement composer. Shared by explicit picks
// (vote N, numbered reply) and the single-open-topic shortcut.
async function enterTopic(phone, state, chosen, intent, responses) {
  const init = await initUserForConversation(phone, chosen.zinvite);
  state.zinvite = chosen.zinvite;
  state.topic = chosen.topic;
  state.token = init.token;
  state.pid = init.pid;
  delete state.pendingIntent;
  if (intent === 'write') {
    state.phase = 'writing';
    userState[phone] = state;
    saveState();
    responses.push({ text: `✏️ *${chosen.topic}*\n\nType your statement as a single message. Good statements:\n- Start with "I think..." or "The village should..."\n- Are under 140 characters\n- Express one clear idea\n\nType *cancel* to go back.` });
    return;
  }
  if (init.nextComment) {
    state.phase = 'voting';
    state.lastTid = init.nextComment.tid;
    state.lastStatement = init.nextComment.txt;
    userState[phone] = state;
    saveState();
    responses.push({ text: `✅ *Topic:* ${chosen.topic}\n\n${formatStatement(init.nextComment, init.nextComment.remaining, init.nextComment.total)}` });
  } else {
    state.phase = 'idle';
    userState[phone] = state;
    saveState();
    responses.push({ text: `✅ *Topic:* ${chosen.topic}\n\n🎉 You've voted on every statement! Type *new* to write your own, or *topics* for another topic.\n\n🔔 Want updates when new statements arrive? Follow this topic at ${topicUrl(chosen.zinvite, chosen.topic)}` });
  }
}

// Handle a DM message from a user in the voting flow
async function handleDM(phone, name, text) {
  const responses = []; // Array of { text } to send back as DMs
  const trimmed = text.trim().toLowerCase();
  const state = userState[phone] || { phase: 'idle' };

  try {
    // --- Commands that work in any phase ---
    if (trimmed === 'help' || trimmed === 'commands' || trimmed === '?') {
      responses.push({ text: formatWelcome() });
      return responses;
    }

    if (trimmed === 'topics' || trimmed === 'menu' || trimmed === 'start') {
      const convos = await getActiveConversations();
      state.phase = 'choosing';
      state.conversations = convos;
      userState[phone] = state;
      saveState();
      const joined = new Set();
      for (const acct of Object.values(accounts())) {
        if (acct.whatsapp && acct.whatsapp === String(phone).replace(/\D/g, '')) {
          (acct.subs || []).forEach(zz => joined.add(zz));
        }
      }
      if (state.subscribed && state.zinvite) joined.add(state.zinvite);
      responses.push({ text: formatTopicList(convos, joined) });
      return responses;
    }

    if (trimmed === 'stop' || trimmed === 'quit' || trimmed === 'exit') {
      delete userState[phone];
      saveState();
      responses.push({ text: '👋 You\'ve left the voting session. Type *topics* anytime to come back.' });
      return responses;
    }

    if (trimmed === 'subscribe' || trimmed === 'notify' || trimmed === 'notifications on') {
      // Subscriptions are managed on the website (deliberate: one system of
      // record, and unsubscribing here can't be silently undone in chat).
      responses.push({ text: `🔔 Updates are managed on the website — follow any topic at ${PUBLIC_URL} and its updates will arrive here.` });
      return responses;
    }

    if (trimmed === 'unsubscribe' || trimmed === 'notifications off') {
      state.subscribed = false;
      userState[phone] = state;
      // Also clear any web-hub group memberships tied to this phone
      for (const acct of Object.values(accounts())) {
        if (acct.whatsapp && acct.whatsapp === String(phone).replace(/\D/g, '')) {
          acct.subs = [];
          acct.allTopics = false;
        }
      }
      saveState();
      responses.push({ text: `🔕 *Unsubscribed.* You won't get any more updates here.\n\nYou can still vote anytime (type *topics*). To get updates again, follow a topic at ${PUBLIC_URL}` });
      return responses;
    }

    // vote N — jump straight into topic N from the numbered list
    const voteN = trimmed.match(/^vote\s+(\d+)$/);
    if (voteN) {
      // Prefer the list the user was just shown so numbering can't shift
      const convos = (state.phase === 'choosing' && state.conversations && state.conversations.length)
        ? state.conversations
        : await getActiveConversations();
      const num = parseInt(voteN[1], 10);
      if (!(num >= 1 && num <= convos.length)) {
        responses.push({ text: `There ${convos.length === 1 ? 'is only *1* open topic' : `are *${convos.length}* open topics`} — type *topics* to see the numbered list.` });
        return responses;
      }
      await enterTopic(phone, state, convos[num - 1], 'vote', responses);
      return responses;
    }

    // vote / write (bare) — ask WHICH topic, unless only one is open
    if (['vote', 'voting', 'new', 'write'].includes(trimmed)) {
      const intent = (trimmed === 'new' || trimmed === 'write') ? 'write' : 'vote';
      const convos = await getActiveConversations();
      if (!convos.length) {
        responses.push({ text: '📭 No open topics right now. Check back later!' });
        return responses;
      }
      if (convos.length === 1) {
        await enterTopic(phone, state, convos[0], intent, responses);
        return responses;
      }
      state.phase = 'choosing';
      state.conversations = convos;
      state.pendingIntent = intent;
      userState[phone] = state;
      saveState();
      const joined = new Set();
      for (const acct of Object.values(accounts())) {
        if (acct.whatsapp && acct.whatsapp === String(phone).replace(/\D/g, '')) {
          (acct.subs || []).forEach(zz => joined.add(zz));
        }
      }
      let msg = intent === 'write'
        ? '✏️ *Which topic do you want to write a statement in?*\n\n'
        : '🗳️ *Which topic do you want to vote on?*\n\n';
      convos.forEach(function (c, i) {
        msg += `*${i + 1}.* ${c.topic}${joined.has(c.zinvite) ? ' ✓' : ''}\n`;
      });
      msg += '\nReply with the number.';
      responses.push({ text: msg });
      return responses;
    }

    // my topics — the topics this person follows
    if (trimmed === 'my topics' || trimmed === 'mytopics') {
      const mine = new Set();
      for (const acct of Object.values(accounts())) {
        if (acct.whatsapp && acct.whatsapp === String(phone).replace(/\D/g, '')) {
          (acct.subs || []).forEach(z => mine.add(z));
        }
      }
      if (state.subscribed && state.zinvite) mine.add(state.zinvite);
      if (!mine.size) {
        responses.push({ text: `You're not following any topics yet.\n\nType *topics* to see what's open, or follow topics at ${PUBLIC_URL} to get updates here.` });
        return responses;
      }
      const convos = await getActiveConversations();
      let msg = '📌 *Your topics*\n\n';
      for (const z of mine) {
        const c = convos.find(cc => cc.zinvite === z);
        if (c) msg += `• ${c.topic}\n  ${topicUrl(z, c.topic)}\n`;
      }
      msg += '\nType *topics* for all open topics, or *vote N* to vote on topic N.';
      responses.push({ text: msg });
      return responses;
    }

    // revote — review past votes one by one and change any of them
    if (trimmed === 'revote' || trimmed === 'review') {
      if (!state.zinvite) {
        responses.push({ text: 'Pick a topic first — type *topics* to see what\'s open.' });
        return responses;
      }
      const z = state.zinvite;
      const init = await initUserForConversation(phone, z);
      if (init.token) state.token = init.token;
      const voted = init.votes || [];
      if (!voted.length) {
        responses.push({ text: 'You haven\'t voted on anything in this topic yet. Type *vote* to start.' });
        return responses;
      }
      const comments = await getComments(state.token, z);
      const byTid = {};
      comments.forEach(c => { byTid[c.tid] = c.txt; });
      state.zinvite = z;
      state.phase = 'revoting';
      state.revoteList = voted
        .filter(v => byTid[v.tid] !== undefined)
        .map(v => ({ tid: v.tid, vote: v.vote, txt: byTid[v.tid] }));
      state.revoteIndex = 0;
      userState[phone] = state;
      saveState();
      responses.push({ text: formatRevote(state) });
      return responses;
    }

    if (trimmed === 'status') {
      if (state.zinvite && state.token) {
        const init = await initUserForConversation(phone, state.zinvite);
        const voted = init.votes ? init.votes.length : 0;
        const total = init.nextComment ? voted + init.nextComment.remaining + 1 : voted;
        responses.push({ text: `📊 *Your progress:* ${voted}/${total} statements voted on\n\nTopic: _${state.topic || 'Unknown'}_\n\nType *vote* to continue or *topics* to switch.` });
      } else {
        responses.push({ text: 'You\'re not in a voting session. Type *topics* to get started.' });
      }
      return responses;
    }

    // --- Phase: choosing a topic ---
    if (state.phase === 'choosing') {
      const num = parseInt(trimmed);
      if (num >= 1 && num <= (state.conversations || []).length) {
        await enterTopic(phone, state, state.conversations[num - 1],
          state.pendingIntent || 'vote', responses);
        return responses;
      }
      // Not a valid number
      responses.push({ text: 'Please reply with a topic number, or type *topics* to see the list again.' });
      return responses;
    }

    // --- Phase: reviewing past votes ---
    if (state.phase === 'revoting' && state.revoteList && state.token) {
      const item = state.revoteList[state.revoteIndex];
      const advance = () => {
        state.revoteIndex++;
        if (state.revoteIndex >= state.revoteList.length) {
          state.phase = state.lastTid !== undefined ? 'voting' : 'idle';
          delete state.revoteList;
          delete state.revoteIndex;
          userState[phone] = state;
          saveState();
          responses.push({ text: '✅ *That\'s all your votes — review done!*\n\nType *vote* to continue voting, or *topics* to switch topics.' });
          return true;
        }
        userState[phone] = state;
        saveState();
        responses.push({ text: formatRevote(state) });
        return false;
      };

      if (trimmed === 'done' || trimmed === 'cancel' || trimmed === 'stop review') {
        state.phase = state.lastTid !== undefined ? 'voting' : 'idle';
        delete state.revoteList;
        delete state.revoteIndex;
        userState[phone] = state;
        saveState();
        responses.push({ text: 'Review closed. Type *vote* to continue voting, or *topics* to switch topics.' });
        return responses;
      }
      if (['k', 'keep', 'next', 'skip'].includes(trimmed)) {
        advance();
        return responses;
      }
      let newVote = null;
      if (['agree', 'yes', 'a', '👍', 'y'].includes(trimmed)) newVote = -1;
      else if (['disagree', 'no', 'd', '👎', 'n'].includes(trimmed)) newVote = 1;
      else if (['pass', 'p', '⏭️', '⏭'].includes(trimmed)) newVote = 0;
      if (newVote !== null) {
        if (newVote !== item.vote) {
          await vote(state.token, state.zinvite, item.tid, newVote);
          item.vote = newVote;
          responses.push({ text: `Changed to ${VOTE_LABEL[String(newVote)]}.` });
        }
        advance();
        return responses;
      }
      responses.push({ text: 'Reply *a* / *d* / *p* to change this vote, *k* to keep it, or *done* to finish.' });
      return responses;
    }

    // --- Phase: voting ---
    if (state.phase === 'voting' && state.token && state.lastTid !== undefined) {
      let voteValue = null;
      // Polis stores agree as -1 and disagree as +1 (see server report.ts)
      if (['agree', 'yes', 'a', '👍', 'y', '1'].includes(trimmed)) voteValue = -1;
      else if (['disagree', 'no', 'd', '👎', 'n', '-1'].includes(trimmed)) voteValue = 1;
      else if (['skip', 'pass', 's', '⏭️', '⏭', 'p', '0'].includes(trimmed)) voteValue = 0;
      // (bare "vote"/"new" are handled earlier — they open the topic picker)

      if (voteValue !== null) {
        // Pin the conversation for this exchange — background notifiers may
        // retarget state.zinvite while we await, and tids are per-conversation.
        const z = state.zinvite;
        const tid = state.lastTid;
        let result;
        try {
          result = await vote(state.token, z, tid, voteValue);
        } catch (e) {
          // Stale/expired participant token (or Polis restart) — re-mint via
          // XID and retry once instead of wedging the session forever.
          try {
            const init = await initUserForConversation(phone, z);
            if (init.token) state.token = init.token;
            result = await vote(state.token, z, tid, voteValue);
            userState[phone] = state;
            saveState();
          } catch (e2) {
            state.phase = 'idle';
            state.lastTid = undefined;
            state.lastStatement = undefined;
            userState[phone] = state;
            saveState();
            responses.push({ text: '⚠️ That vote didn\'t go through — the session was stale. Type *vote* to pick up where you left off.' });
            return responses;
          }
        }
        // Polis convention: -1 = agree, +1 = disagree
        const label = voteValue === -1 ? '👍 Agreed' : voteValue === 1 ? '👎 Disagreed' : '⏭️ Skipped';

        if (result.nextComment) {
          state.lastTid = result.nextComment.tid;
          state.lastStatement = result.nextComment.txt;
          saveState();
          responses.push({ text: `${label}\n\n${formatStatement(result.nextComment, result.nextComment.remaining, result.nextComment.total)}` });
        } else {
          state.lastTid = undefined;
          state.lastStatement = undefined;
          state.phase = 'idle';
          saveState();
          responses.push({ text: `${label}\n\n🎉 *You've voted on all statements!*\n\nType *new* to write your own statement, or *topics* for another topic.\n\n🔔 Want updates when new statements arrive? Follow this topic at ${topicUrl(z, state.topic)}` });
        }
        return responses;
      }

      // Unrecognized vote input
      responses.push({ text: 'To vote on the statement above, reply with one letter:\n\n*a* — 👍 agree\n*d* — 👎 disagree\n*p* — ⏭️ pass\n\nOr type *new* to write your own statement, or *stop* to leave.' });
      return responses;
    }

    // --- Phase: writing a statement ---
    if (state.phase === 'writing' && state.token) {
      if (trimmed === 'cancel' || trimmed === 'back') {
        state.phase = 'voting';
        userState[phone] = state;
        saveState();
        // Re-init to get the next comment
        const init = await initUserForConversation(phone, state.zinvite);
        if (init.nextComment) {
          state.lastTid = init.nextComment.tid;
          state.lastStatement = init.nextComment.txt;
          saveState();
          responses.push({ text: `Back to voting!\n\n${formatStatement(init.nextComment, init.nextComment.remaining, init.nextComment.total)}` });
        } else {
          responses.push({ text: 'Back to voting — but you\'ve voted on everything! Type *topics* for another topic.' });
        }
        return responses;
      }

      // Submit the statement
      const result = await submitComment(state.token, state.zinvite, text.trim());
      // Skip this author's next new-statement alert — it would be their own.
      markAuthor(phone, state.zinvite);
      state.phase = 'voting';
      userState[phone] = state;
      saveState();

      // Get next comment
      const init = await initUserForConversation(phone, state.zinvite);
      let followUp = '';
      if (init.nextComment) {
        state.lastTid = init.nextComment.tid;
        state.lastStatement = init.nextComment.txt;
        saveState();
        followUp = `\n\n${formatStatement(init.nextComment, init.nextComment.remaining, init.nextComment.total)}`;
      }
      responses.push({ text: `✅ *Statement submitted!* It will appear for others to vote on after moderation.${followUp}` });
      return responses;
    }

    // (bare "vote"/"new" are handled in the any-phase section above)

    // Default: show welcome/help
    responses.push({ text: formatWelcome() });
    return responses;

  } catch (err) {
    console.error('DM handler error:', err.message);
    responses.push({ text: '⚠️ Something went wrong. Type *topics* to start over.' });
    return responses;
  }
}

// Handle a group message (show topics, instructions)
// Responses can have { text } (reply in group) or { text, dmPhone } (send as DM)
async function handleGroup(phone, name, text) {
  const responses = [];
  const trimmed = text.trim().toLowerCase();

  try {
    if (trimmed === 'topics' || trimmed === 'vote' || trimmed === 'start') {
      const convos = await getActiveConversations();
      // Store conversations for this user so they can pick by number
      userState[phone] = userState[phone] || { phase: 'idle' };
      userState[phone].conversations = convos;
      userState[phone].phase = 'choosing';
      saveState();

      let msg = '🗳️ *Active Community Topics*\n\n';
      convos.forEach((c, i) => {
        msg += `*${i + 1}.* ${c.topic}\n`;
      });
      msg += '\nReply with the *number* to start voting.';
      responses.push({ text: msg });
      return responses;
    }

    // User picks a topic number — initiate DM with first statement
    const state = userState[phone] || {};
    if (state.phase === 'choosing' && state.conversations) {
      const num = parseInt(trimmed);
      if (num >= 1 && num <= state.conversations.length) {
        const chosen = state.conversations[num - 1];
        const init = await initUserForConversation(phone, chosen.zinvite);
        state.zinvite = chosen.zinvite;
        state.topic = chosen.topic;
        state.token = init.token;
        state.pid = init.pid;
        state.phase = 'voting';
        state.subscribed = true; // Auto-subscribe when picking a topic
        userState[phone] = state;
        saveState();

        // DM only — the group must not reveal who is voting.
        // DM the user with the first statement
        if (init.nextComment) {
          state.lastTid = init.nextComment.tid;
          state.lastStatement = init.nextComment.txt;
          saveState();
          responses.push({
            text: `🗳️ *Topic:* ${chosen.topic}\n\n${formatStatement(init.nextComment, init.nextComment.remaining, init.nextComment.total)}`,
            dmPhone: phone,
          });
        } else {
          responses.push({
            text: `🗳️ *Topic:* ${chosen.topic}\n\n🎉 You've already voted on all statements! Type *new* to write your own.`,
            dmPhone: phone,
          });
        }
        return responses;
      }
    }

    // Any other message — brief help
    responses.push({ text: '🗳️ Type *topics* to see active discussions and start voting!' });
    return responses;

  } catch (err) {
    console.error('Group handler error:', err.message);
    responses.push({ text: '⚠️ Something went wrong. Try again.' });
    return responses;
  }
}

// Handle a message inside a per-topic community subgroup: no menus — any
// voting intent starts (or resumes) a DM session on THIS topic.
async function handleTopicGroup(phone, name, text, zinvite) {
  const responses = [];
  const trimmed = text.trim().toLowerCase();
  try {
    if (['vote', 'voting', 'topics', 'start', 'help'].includes(trimmed)) {
      const state = userState[phone] || { phase: 'idle' };
      const init = await initUserForConversation(phone, zinvite);
      state.zinvite = zinvite;
      if (init.conversation && init.conversation.topic) state.topic = init.conversation.topic;
      state.token = init.token;
      state.pid = init.pid;
      state.subscribed = true; // voting from the topic group implies interest
      if (init.nextComment) {
        state.phase = 'voting';
        state.lastTid = init.nextComment.tid;
        state.lastStatement = init.nextComment.txt;
        userState[phone] = state;
        saveState();
        // DM only — never confirm in the group. Voting participation is
        // private; the group must not reveal who is voting.
        responses.push({
          text: `🗳️ *${state.topic || 'This topic'}*\n\n${formatStatement(init.nextComment, init.nextComment.remaining, init.nextComment.total)}`,
          dmPhone: phone,
        });
      } else {
        state.phase = 'idle';
        userState[phone] = state;
        saveState();
        responses.push({
          text: `🎉 You've voted on every statement here! Type *new* to write your own statement.`,
          dmPhone: phone,
        });
      }
      return responses;
    }

    // Anything else is people talking to each other — stay silent.
    return responses;
  } catch (err) {
    console.error('Topic group handler error:', err.message);
    responses.push({ text: '⚠️ Something went wrong. Try again in a moment.' });
    return responses;
  }
}

// --- Per-topic community subgroups ---

// Ask wireclaw (via the notification action channel) to create a community
// subgroup for every active topic that doesn't have one yet.
function syncTopicGroups(convos) {
  if (!WA_COMMUNITY_JID) return;
  for (const conv of convos) {
    if (!conv.zinvite || waTopicGroups[conv.zinvite]) continue;
    const asked = waTopicGroupRequests[conv.zinvite] || 0;
    if (Date.now() - asked < 30 * 60000) continue; // re-ask at most every 30 min
    waTopicGroupRequests[conv.zinvite] = Date.now();
    queue({
      action: 'create-topic-group',
      zinvite: conv.zinvite,
      topic: conv.topic,
      communityJid: WA_COMMUNITY_JID,
      webhookUrl: `http://localhost:${PORT}/wa/group`,
      reportUrl: `http://localhost:${PORT}/wa/topic-group`,
    });
    console.log(`Requested topic subgroup for ${conv.zinvite} "${conv.topic}"`);
  }
  saveState();
}

// --- Routes (loopback only: WireClaw and the router call these) ---

async function handle(req, res) {
  // POST /wa/group — handle group message. Messages from a per-topic
  // subgroup are scoped straight to that topic; other groups get the menu.
  if (req.method === 'POST' && req.url === '/wa/group') {
    const body = await readBody(req);
    if (!body.phone || !body.text) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'phone and text required' }));
    }
    const zinvite = body.chatJid &&
      Object.keys(waTopicGroups).find(z => waTopicGroups[z] === body.chatJid);
    const responses = zinvite
      ? await handleTopicGroup(body.phone, body.name || '', body.text, zinvite)
      : await handleGroup(body.phone, body.name || '', body.text);
    res.writeHead(200);
    return res.end(JSON.stringify({ responses }));
  }

  // POST /wa/topic-group — wireclaw reports a created topic subgroup
  if (req.method === 'POST' && req.url === '/wa/topic-group') {
    const body = await readBody(req);
    if (!body.zinvite || !body.jid) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'zinvite and jid required' }));
    }
    waTopicGroups[body.zinvite] = body.jid;
    delete waTopicGroupRequests[body.zinvite];
    saveState();
    console.log(`Topic subgroup mapped: ${body.zinvite} -> ${body.jid}`);
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true }));
  }

  // POST /wa/dm — handle DM message
  if (req.method === 'POST' && req.url === '/wa/dm') {
    const body = await readBody(req);
    if (!body.phone || !body.text) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'phone and text required' }));
    }
    const responses = await handleDM(body.phone, body.name || '', body.text);
    res.writeHead(200);
    return res.end(JSON.stringify({ responses }));
  }

  // GET /wa/pending-notifications — returns and clears pending DM notifications
  if (req.method === 'GET' && req.url === '/wa/pending-notifications') {
    const notifications = drain();
    if (notifications.length) saveState();
    res.writeHead(200);
    return res.end(JSON.stringify({ notifications }));
  }

  // POST /wa/notify — accept notifications from external services (e.g., router)
  if (req.method === "POST" && req.url === "/wa/notify") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const n = JSON.parse(body);
        if ((n.phone && n.text) || n.action) {
          queue(n);
          saveState();
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "phone and text required" }));
        }
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid JSON" }));
      }
    });
    return true;
  }

  // GET /wa/state/:phone — get user's voting state (used by the router
  // bridge to detect active sessions). WhatsApp identities aren't always
  // bare digits — LID users arrive as "12345…@lid" — so accept any single
  // path segment.
  const stateMatch = req.url?.match(/^\/wa\/state\/([^/]+)$/);
  if (req.method === 'GET' && stateMatch) {
    const phone = decodeURIComponent(stateMatch[1]);
    res.writeHead(200);
    return res.end(JSON.stringify(userState[phone] || { phase: 'idle' }));
  }
  return false;
}

function init(c) {
  ctx = c;
  ({ userState, pendingNotifications, waTopicGroups } = c.data);
  ({ BRAND_NAME, PUBLIC_URL, PORT, saveState, readBody, getActiveConversations, initByXid, vote,
    getComments, submitComment, topicUrl, accounts, markAuthor } = c);
  WA_ANNOUNCE_JID = process.env.POLIS_WA_ANNOUNCE_JID || '';
  WA_COMMUNITY_JID = process.env.POLIS_WA_COMMUNITY_JID || '';
  WA_SUPPORT_JID = process.env.POLIS_WA_SUPPORT_JID || '';
  console.log('WhatsApp bridge ON');
  return module.exports;
}

module.exports = {
  init, handle, dm, alert, welcome, announce, support, setSubscribed, newStatements, topicClosed, nudge, syncTopicGroups,
  announceJid: () => WA_ANNOUNCE_JID,
};
