// ═══════════════════════════════════════════════════════════════
//  MEO CENTER — Core Module  (meo-center.js)
//  Drop this <script src="meo-center.js"> before </body> in your
//  index.html, after Supabase is already initialized as `sb`.
// ═══════════════════════════════════════════════════════════════

'use strict';

// ── Supabase client accessor ────────────────────────────────────
// window.supabaseClient is set by getSupaRT() in index.html, but
// meo-center.js may execute before it is ready. This helper waits
// up to 5 s for the client to appear before resolving.
async function meoGetSupabase() {
  if (window.supabaseClient) return window.supabaseClient;
  if (typeof getSupaRT === 'function') {
    const c = getSupaRT();
    if (c) return c;
  }
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = setInterval(() => {
      if (window.supabaseClient) { clearInterval(poll); resolve(window.supabaseClient); return; }
      if (typeof getSupaRT === 'function') {
        const c = getSupaRT();
        if (c) { clearInterval(poll); resolve(c); return; }
      }
      if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error('[MeoCenter] Supabase client not ready after 5s'));
      }
    }, 100);
  });
}


// ── Config ─────────────────────────────────────────────────────
const MEO = {
  // Anti-spam: ms between lobby messages
  CHAT_COOLDOWN_MS: 3000,
  // Max messages kept in memory per channel
  CHAT_HISTORY_LIMIT: 80,
  // Max arcade plays per game per day
  ARCADE_DAILY_LIMIT: 10,
  // Max coins earnable in arcade per day per game
  ARCADE_DAILY_COIN_CAP: 200,
};

// ── State ───────────────────────────────────────────────────────
const meoState = {
  currentRoom: null,
  lobbyChannel: null,
  roomChannel: null,
  chatCooldownUntil: 0,
  activeGame: null,
};

// ── Utilities ───────────────────────────────────────────────────
function meoEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function meoTimestamp(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  if (diffMs < 60000) return 'just now';
  if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function meoGetUser() {
  return {
    id:     window.state?.discordId || null,
    name:   window.state?.username  || 'Anon',
    avatar: window.state?.avatar    || null,
  };
}

function meoShowToast(msg) {
  if (typeof showToast === 'function') showToast(msg);
  else console.log('[MeoCenter]', msg);
}

// ── Page navigation (plugs into your existing showPage) ─────────
function showMeoCenter(section = 'lobby') {
  // Show the meo-center page using your existing nav system
  if (typeof showPage === 'function') showPage('meo-center');
  meoNavigate(section);
}

function meoNavigate(section) {
  document.querySelectorAll('.meo-section').forEach(el => {
    el.style.display = el.dataset.section === section ? '' : 'none';
  });
  document.querySelectorAll('.meo-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === section);
  });
  if (section === 'lobby') meoInitLobby();
  if (section === 'rooms') meoInitRooms();
  if (section === 'shops') meoInitShops();
  if (section === 'cinema') meoInitCinema();
  if (section === 'arcade') meoInitArcade();
}

// ════════════════════════════════════════════════════════════════
//  1. LOBBY PLAZA
// ════════════════════════════════════════════════════════════════

async function meoInitLobby() {
  await meoLoadMessages('lobby');
  meoSubscribeChat('lobby');
}

async function meoLoadMessages(channel) {
  const el = document.getElementById('meo-chat-messages');
  if (!el) return;

  try {
    const { data, error } = (await meoGetSupabase())
      .from('chat_messages')
      .select('*')
      .eq('channel', channel)
      .order('created_at', { ascending: false })
      .limit(MEO.CHAT_HISTORY_LIMIT);

    if (error) throw error;

    const msgs = (data || []).reverse();
    el.innerHTML = msgs.map(meoBuildMessageHTML).join('');
    el.scrollTop = el.scrollHeight;
  } catch (e) {
    console.error('[MeoCenter] loadMessages:', e);
  }
}

function meoBuildMessageHTML(msg) {
  const user = meoEscape(msg.username || 'Anon');
  const text = meoEscape(msg.message || '');
  const time = meoTimestamp(msg.created_at);
  const avatar = msg.avatar_url
    ? `<img src="${meoEscape(msg.avatar_url)}" class="meo-avatar" onerror="this.style.display='none'">`
    : `<div class="meo-avatar-placeholder">${user.charAt(0).toUpperCase()}</div>`;

  const typeTag = msg.msg_type && msg.msg_type !== 'chat'
    ? `<span class="meo-msg-type meo-type-${meoEscape(msg.msg_type)}">${meoEscape(msg.msg_type)}</span>`
    : '';

  return `
    <div class="meo-msg" data-id="${meoEscape(msg.id)}">
      ${avatar}
      <div class="meo-msg-body">
        <div class="meo-msg-header">
          <span class="meo-msg-username">${user}</span>
          ${typeTag}
          <span class="meo-msg-time">${time}</span>
        </div>
        <div class="meo-msg-text">${text}</div>
      </div>
    </div>`;
}

async function meoSubscribeChat(channel) {
  // Unsubscribe previous
  if (meoState.lobbyChannel) {
    meoState.lobbyChannel.unsubscribe();
  }

  const el = document.getElementById('meo-chat-messages');
  if (!el) return;

  meoState.lobbyChannel = (await meoGetSupabase())
    .channel(`meo-chat-${channel}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'chat_messages',
      filter: `channel=eq.${channel}`,
    }, payload => {
      const html = meoBuildMessageHTML(payload.new);
      el.insertAdjacentHTML('beforeend', html);
      // Auto-scroll if near bottom
      const threshold = 120;
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      if (isNearBottom) el.scrollTop = el.scrollHeight;
      // Trim old messages from DOM
      const msgs = el.querySelectorAll('.meo-msg');
      if (msgs.length > MEO.CHAT_HISTORY_LIMIT) {
        msgs[0].remove();
      }
    })
    .subscribe();
}

async function meoSendMessage(channel, messageText, msgType = 'chat') {
  const user = meoGetUser();
  if (!user.id) { meoShowToast('❌ Please log in first.'); return; }

  const now = Date.now();
  if (now < meoState.chatCooldownUntil) {
    const wait = Math.ceil((meoState.chatCooldownUntil - now) / 1000);
    meoShowToast(`⏳ Slow down! Wait ${wait}s`);
    return;
  }

  const text = messageText.trim();
  if (!text || text.length > 300) {
    meoShowToast('❌ Message must be 1–300 characters.');
    return;
  }

  meoState.chatCooldownUntil = now + MEO.CHAT_COOLDOWN_MS;

  try {
    const { error } = (await meoGetSupabase())
      .from('chat_messages')
      .insert({
        discord_id: user.id,
        username: user.name,
        avatar_url: user.avatar,
        message: text,
        channel: channel,
        msg_type: msgType,
      });
    if (error) throw error;
  } catch (e) {
    meoShowToast('❌ Failed to send: ' + e.message);
  }
}

// ════════════════════════════════════════════════════════════════
//  2. PLAYER ROOMS
// ════════════════════════════════════════════════════════════════

async function meoInitRooms() {
  await meoLoadRoomList();
  meoSubscribeRoomList();
}

async function meoLoadRoomList() {
  const el = document.getElementById('meo-room-list');
  if (!el) return;

  try {
    const { data, error } = (await meoGetSupabase())
      .from('meo_rooms')
      .select('*')
      .eq('is_public', true)
      .order('last_active', { ascending: false })
      .limit(30);

    if (error) throw error;

    if (!data || !data.length) {
      el.innerHTML = `<div class="meo-empty">No rooms open yet. Create the first one! ✨</div>`;
      return;
    }

    el.innerHTML = data.map(room => `
      <div class="meo-room-card" data-room-id="${meoEscape(room.id)}">
        <div class="meo-room-name">${meoEscape(room.name)}</div>
        <div class="meo-room-meta">
          <span>👑 ${meoEscape(room.owner_name)}</span>
          <span>👥 ${room.member_count}</span>
        </div>
        <button class="meo-btn meo-btn-sm" onclick="meoJoinRoom('${meoEscape(room.id)}','${meoEscape(room.name)}')">
          Enter
        </button>
      </div>`).join('');
  } catch (e) {
    el.innerHTML = `<div class="meo-empty" style="color:#e74c3c;">⚠️ ${meoEscape(e.message)}</div>`;
  }
}

async function meoSubscribeRoomList() {
  (await meoGetSupabase())
    .channel('meo-rooms-list')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'meo_rooms',
    }, () => meoLoadRoomList())
    .subscribe();
}

async function meoCreateRoom(name, isPublic = true) {
  const user = meoGetUser();
  if (!user.id) { meoShowToast('❌ Please log in first.'); return; }
  if (!name.trim()) { meoShowToast('❌ Room name is required.'); return; }

  try {
    const { data, error } = (await meoGetSupabase())
      .from('meo_rooms')
      .insert({
        name: name.trim().slice(0, 40),
        owner_id: user.id,
        owner_name: user.name,
        is_public: isPublic,
      })
      .select()
      .single();

    if (error) throw error;
    meoShowToast(`✅ Room "${data.name}" created!`);
    await meoJoinRoom(data.id, data.name);
  } catch (e) {
    meoShowToast('❌ ' + e.message);
  }
}

async function meoJoinRoom(roomId, roomName) {
  const user = meoGetUser();
  if (!user.id) { meoShowToast('❌ Please log in.'); return; }

  // Leave current room first
  if (meoState.currentRoom) await meoLeaveRoom();

  meoState.currentRoom = { id: roomId, name: roomName };

  // Upsert member presence
  (await meoGetSupabase()).from('meo_room_members').upsert({
    room_id: roomId,
    discord_id: user.id,
    username: user.name,
    avatar_url: user.avatar,
  });

  // Show room view
  document.getElementById('meo-room-lobby').style.display = 'none';
  document.getElementById('meo-room-active').style.display = '';
  document.getElementById('meo-room-title').textContent = roomName;

  // Load room chat
  const channel = `room:${roomId}`;
  await meoLoadMessages(channel);
  meoSubscribeChat(channel);
}

async function meoLeaveRoom() {
  if (!meoState.currentRoom) return;
  const user = meoGetUser();
  if (user.id) {
    (await meoGetSupabase())
      .from('meo_room_members')
      .delete()
      .match({ room_id: meoState.currentRoom.id, discord_id: user.id });
  }
  meoState.currentRoom = null;
  if (meoState.roomChannel) meoState.roomChannel.unsubscribe();
  document.getElementById('meo-room-lobby').style.display = '';
  document.getElementById('meo-room-active').style.display = 'none';
}

async function meoDeleteRoom(roomId) {
  const user = meoGetUser();
  if (!user.id) return;
  if (!confirm('Delete this room?')) return;

  const { error } = (await meoGetSupabase())
    .from('meo_rooms')
    .delete()
    .match({ id: roomId, owner_id: user.id });

  if (error) meoShowToast('❌ ' + error.message);
  else { meoShowToast('🗑️ Room deleted.'); await meoLeaveRoom(); }
}

// ════════════════════════════════════════════════════════════════
//  3. SHOPS DISTRICT
// ════════════════════════════════════════════════════════════════

async function meoInitShops(shopId = 'ramen') {
  await meoLoadShop(shopId);
}

async function meoLoadShop(shopId) {
  const el = document.getElementById('meo-shop-items');
  if (!el) return;

  try {
    const { data, error } = (await meoGetSupabase())
      .from('meo_shop_items')
      .select('*')
      .eq('shop_id', shopId)
      .eq('is_active', true)
      .order('sort_order');

    if (error) throw error;

    el.innerHTML = (data || []).map(item => `
      <div class="meo-shop-item" data-item-id="${meoEscape(item.id)}">
        <div class="meo-shop-emoji">${meoEscape(item.emoji)}</div>
        <div class="meo-shop-info">
          <div class="meo-shop-name">${meoEscape(item.name)}</div>
          <div class="meo-shop-desc">${meoEscape(item.description)}</div>
          <div class="meo-shop-effect">
            ${meoEffectLabel(item.effect_type, item.effect_value)}
          </div>
        </div>
        <button class="meo-btn" onclick="meoPurchaseItem('${meoEscape(item.id)}','${meoEscape(item.name)}',${item.price_coins})">
          🪙 ${item.price_coins}
        </button>
      </div>`).join('');
  } catch (e) {
    el.innerHTML = `<div class="meo-empty" style="color:#e74c3c;">⚠️ ${meoEscape(e.message)}</div>`;
  }
}

function meoEffectLabel(type, value) {
  const labels = {
    xp: `+${value} Card XP`,
    affection: `+${value} Affection`,
    boost: `${value}% boost`,
    coins: `+${value} Coins`,
  };
  return labels[type] || `+${value}`;
}

async function meoPurchaseItem(itemId, itemName, price) {
  const user = meoGetUser();
  if (!user.id) { meoShowToast('❌ Please log in.'); return; }

  // Check coins (using your existing coin system)
  const userCoins = window.currentUser?.coins ?? window.userCoins ?? 0;
  if (userCoins < price) {
    meoShowToast(`❌ Not enough coins! Need 🪙 ${price}`);
    return;
  }

  if (!confirm(`Buy "${itemName}" for 🪙 ${price}?`)) return;

  try {
    // Deduct coins (adapt to your coin system)
    // await deductCoins(price);  // ← call your existing function

    // Record purchase
    (await meoGetSupabase()).from('meo_purchases').insert({
      discord_id: user.id,
      item_id: itemId,
      coins_spent: price,
    });

    // Update inventory
    const { data: existing } = (await meoGetSupabase())
      .from('meo_inventory')
      .select('id, quantity')
      .match({ discord_id: user.id, item_id: itemId })
      .single();

    if (existing) {
      (await meoGetSupabase())
        .from('meo_inventory')
        .update({ quantity: existing.quantity + 1 })
        .eq('id', existing.id);
    } else {
      (await meoGetSupabase()).from('meo_inventory').insert({
        discord_id: user.id,
        item_id: itemId,
        quantity: 1,
      });
    }

    meoShowToast(`✅ Purchased "${itemName}"!`);
  } catch (e) {
    meoShowToast('❌ Purchase failed: ' + e.message);
  }
}

// ════════════════════════════════════════════════════════════════
//  4. CINEMA HALL
// ════════════════════════════════════════════════════════════════

async function meoInitCinema() {
  await meoLoadCinemaSlots();
}

async function meoLoadCinemaSlots() {
  const el = document.getElementById('meo-cinema-list');
  if (!el) return;

  try {
    const { data, error } = (await meoGetSupabase())
      .from('meo_cinema_slots')
      .select('*')
      .eq('is_active', true)
      .order('sort_order');

    if (error) throw error;

    el.innerHTML = (data || []).map(slot => `
      <div class="meo-cinema-card" onclick="meoPlayVideo('${meoEscape(slot.youtube_id)}','${meoEscape(slot.title)}')">
        <div class="meo-cinema-thumb">
          <img src="https://img.youtube.com/vi/${meoEscape(slot.youtube_id)}/mqdefault.jpg"
               onerror="this.src=''" alt="${meoEscape(slot.title)}">
          <div class="meo-cinema-play">▶</div>
        </div>
        <div class="meo-cinema-title">${meoEscape(slot.title)}</div>
        ${slot.description ? `<div class="meo-cinema-desc">${meoEscape(slot.description)}</div>` : ''}
      </div>`).join('');
  } catch (e) {
    el.innerHTML = `<div class="meo-empty" style="color:#e74c3c;">⚠️ ${meoEscape(e.message)}</div>`;
  }
}

function meoPlayVideo(youtubeId, title) {
  const player = document.getElementById('meo-cinema-player');
  const titleEl = document.getElementById('meo-cinema-now-playing');
  if (!player) return;

  if (titleEl) titleEl.textContent = title;
  player.innerHTML = `
    <iframe
      src="https://www.youtube.com/embed/${meoEscape(youtubeId)}?autoplay=1&rel=0"
      frameborder="0"
      allowfullscreen
      allow="autoplay; encrypted-media"
      style="width:100%;height:100%;border-radius:12px;">
    </iframe>`;

  // Switch to cinema view
  document.getElementById('meo-cinema-browser').style.display = 'none';
  document.getElementById('meo-cinema-view').style.display = '';

  // Load cinema chat
  const channel = `cinema:${youtubeId}`;
  meoLoadMessages(channel);
  meoSubscribeChat(channel);
}

function meoCloseCinema() {
  const player = document.getElementById('meo-cinema-player');
  if (player) player.innerHTML = '';
  document.getElementById('meo-cinema-browser').style.display = '';
  document.getElementById('meo-cinema-view').style.display = 'none';
}

// ════════════════════════════════════════════════════════════════
//  5. ARCADE FLOOR — Memory Card Game
// ════════════════════════════════════════════════════════════════

async function meoInitArcade() {
  // Just show the game selection, don't autostart
  document.getElementById('meo-arcade-game').style.display = 'none';
  document.getElementById('meo-arcade-select').style.display = '';
}

function meoStartGame(gameId) {
  meoState.activeGame = gameId;
  document.getElementById('meo-arcade-select').style.display = 'none';
  document.getElementById('meo-arcade-game').style.display = '';

  if (gameId === 'memory') meoStartMemoryGame();
  if (gameId === 'rhythm') meoStartRhythmGame();
}

function meoExitGame() {
  meoState.activeGame = null;
  document.getElementById('meo-arcade-select').style.display = '';
  document.getElementById('meo-arcade-game').style.display = 'none';
}

// ── Memory Card Game ──────────────────────────────────────────
const MEMORY_EMOJIS = ['🌸','⭐','🎀','🌙','💎','🔮','🦋','🌺'];

let memoryState = {
  cards: [],
  flipped: [],
  matched: 0,
  moves: 0,
  startTime: null,
  locked: false,
};

function meoStartMemoryGame() {
  const board = document.getElementById('meo-memory-board');
  if (!board) return;

  // Shuffle pairs
  const pairs = [...MEMORY_EMOJIS, ...MEMORY_EMOJIS];
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }

  memoryState = { cards: pairs, flipped: [], matched: 0, moves: 0, startTime: Date.now(), locked: false };

  board.innerHTML = pairs.map((emoji, i) => `
    <div class="meo-card" data-idx="${i}" data-emoji="${emoji}" onclick="meoFlipCard(this)">
      <div class="meo-card-inner">
        <div class="meo-card-front">✦</div>
        <div class="meo-card-back">${emoji}</div>
      </div>
    </div>`).join('');

  document.getElementById('meo-memory-moves').textContent = '0';
  document.getElementById('meo-memory-status').textContent = '';
}

function meoFlipCard(el) {
  if (memoryState.locked) return;
  if (el.classList.contains('flipped') || el.classList.contains('matched')) return;
  if (memoryState.flipped.length >= 2) return;

  el.classList.add('flipped');
  memoryState.flipped.push(el);

  if (memoryState.flipped.length === 2) {
    memoryState.moves++;
    document.getElementById('meo-memory-moves').textContent = memoryState.moves;
    memoryState.locked = true;

    const [a, b] = memoryState.flipped;
    if (a.dataset.emoji === b.dataset.emoji) {
      a.classList.add('matched');
      b.classList.add('matched');
      memoryState.matched++;
      memoryState.flipped = [];
      memoryState.locked = false;

      if (memoryState.matched === MEMORY_EMOJIS.length) {
        meoMemoryComplete();
      }
    } else {
      setTimeout(() => {
        a.classList.remove('flipped');
        b.classList.remove('flipped');
        memoryState.flipped = [];
        memoryState.locked = false;
      }, 900);
    }
  }
}

async function meoMemoryComplete() {
  const elapsed = Math.round((Date.now() - memoryState.startTime) / 1000);
  const score = Math.max(0, 1000 - (memoryState.moves * 20) - elapsed);
  const coins = Math.min(50, Math.max(5, Math.floor(score / 20)));

  document.getElementById('meo-memory-status').textContent =
    `✨ Complete! ${memoryState.moves} moves · ${elapsed}s · +${coins} coins`;

  const user = meoGetUser();
  if (user.id) {
    try {
      // Check daily limit
      const today = new Date().toISOString().slice(0, 10);
      const { data: daily } = (await meoGetSupabase())
        .from('meo_arcade_daily')
        .select('play_count, coins_today')
        .match({ discord_id: user.id, game_id: 'memory', play_date: today })
        .single();

      const playCount = daily?.play_count ?? 0;
      const coinsToday = daily?.coins_today ?? 0;

      if (playCount < MEO.ARCADE_DAILY_LIMIT && coinsToday < MEO.ARCADE_DAILY_COIN_CAP) {
        const actualCoins = Math.min(coins, MEO.ARCADE_DAILY_COIN_CAP - coinsToday);

        (await meoGetSupabase()).from('meo_arcade_scores').insert({
          discord_id: user.id,
          username: user.name,
          game_id: 'memory',
          score,
          coins_earned: actualCoins,
        });

        (await meoGetSupabase()).from('meo_arcade_daily').upsert({
          discord_id: user.id,
          game_id: 'memory',
          play_date: today,
          play_count: playCount + 1,
          coins_today: coinsToday + actualCoins,
        });

        // Award coins using your existing system
        // await addCoins(actualCoins);
        meoShowToast(`🎮 Memory complete! +${actualCoins} coins earned!`);
      } else {
        meoShowToast('🎮 Memory complete! (Daily coin limit reached)');
      }
    } catch (e) {
      console.error('[MeoCenter] arcade score:', e);
    }
  }
}

// ── Rhythm Game (simple tap game) ─────────────────────────────
// Placeholder — expand with your visual rhythm UI
function meoStartRhythmGame() {
  const board = document.getElementById('meo-arcade-game');
  if (board) {
    board.innerHTML = `
      <div style="text-align:center;padding:40px;">
        <div style="font-size:3em;margin-bottom:16px;">🎵</div>
        <div style="color:var(--pink);font-family:'Cinzel Decorative',serif;font-size:1.2em;margin-bottom:8px;">
          Rhythm Mode
        </div>
        <div style="color:var(--text-dim);font-size:0.9em;margin-bottom:32px;">
          Coming soon — tap to the beat!
        </div>
        <button class="btn-secondary" onclick="meoExitGame()">← Back to Arcade</button>
      </div>`;
  }
}

// ════════════════════════════════════════════════════════════════
//  LEADERBOARD (shared across arcade games)
// ════════════════════════════════════════════════════════════════
async function meoLoadLeaderboard(gameId) {
  const el = document.getElementById('meo-leaderboard');
  if (!el) return;

  const { data } = (await meoGetSupabase())
    .from('meo_arcade_scores')
    .select('username, score, played_at')
    .eq('game_id', gameId)
    .order('score', { ascending: false })
    .limit(10);

  el.innerHTML = `<div class="meo-leaderboard">
    ${(data || []).map((row, i) => `
      <div class="meo-lb-row">
        <span class="meo-lb-rank">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}</span>
        <span class="meo-lb-name">${meoEscape(row.username)}</span>
        <span class="meo-lb-score">${row.score.toLocaleString()}</span>
      </div>`).join('')}
  </div>`;
}

// ════════════════════════════════════════════════════════════════
//  INIT — Wire up DOM after load
// ════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  // Chat input enter key
  const lobbyInput = document.getElementById('meo-lobby-input');
  if (lobbyInput) {
    lobbyInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const channel = meoState.currentRoom ? `room:${meoState.currentRoom.id}` : 'lobby';
        meoSendMessage(channel, lobbyInput.value);
        lobbyInput.value = '';
      }
    });
  }

  // Expose globals for onclick handlers in HTML
  window.meoNavigate = meoNavigate;
  window.meoSendMessage = meoSendMessage;
  window.meoCreateRoom = meoCreateRoom;
  window.meoJoinRoom = meoJoinRoom;
  window.meoLeaveRoom = meoLeaveRoom;
  window.meoDeleteRoom = meoDeleteRoom;
  window.meoLoadShop = meoLoadShop;
  window.meoPurchaseItem = meoPurchaseItem;
  window.meoPlayVideo = meoPlayVideo;
  window.meoCloseCinema = meoCloseCinema;
  window.meoStartGame = meoStartGame;
  window.meoExitGame = meoExitGame;
  window.meoFlipCard = meoFlipCard;
  window.showMeoCenter = showMeoCenter;
});
