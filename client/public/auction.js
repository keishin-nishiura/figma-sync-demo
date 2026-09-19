// オークションデモのクライアント実装。
// 「入札」は bid: { amount, bidder, at } という1つのプロパティへの
// update-propertyでしかない。サーバー側は金額の大小を一切検証しないため、
// 後から届いた入札(=このメッセージがサーバーに最後に到達したクライアント)が
// 常に勝つ。これは本編の「LWWによるプロパティ同期」と全く同じ仕組みだが、
// 題材を変えるだけで受け取る印象が大きく変わる、という対比を狙っている。

const AI_CLIENT_ID = 'ai-agent';
const AI_COLOR = '#f97316';
const COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#eab308', '#a855f7', '#ec4899'];

function colorForClient(id) {
  if (id === AI_CLIENT_ID) return AI_COLOR;
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

const state = {
  clientId: null,
  nodes: new Map(),
  presence: new Map(),
  aiStatus: 'idle',
};

const itemsEl = document.getElementById('items');
const statusEl = document.getElementById('status');
const presenceList = document.getElementById('presence-list');
const activityList = document.getElementById('activity-list');
const toastLayer = document.getElementById('toast-layer');
const instructionInput = document.getElementById('ai-instruction');
const sendBtn = document.getElementById('ai-send');
const seedBtn = document.getElementById('seed-btn');

let ws;
function connect() {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProtocol}//${location.host}/ws-auction`);
  ws.addEventListener('open', () => { statusEl.textContent = '接続済み'; });
  ws.addEventListener('close', () => { statusEl.textContent = '切断されました'; });
  ws.addEventListener('message', (ev) => handleMessage(JSON.parse(ev.data)));
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function getItems() {
  return [...state.nodes.values()]
    .filter((n) => n.properties?.type === 'item')
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
}

function loadDocument(nodeList) {
  state.nodes.clear();
  for (const node of nodeList) state.nodes.set(node.id, structuredClone(node));
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'init': {
      state.clientId = msg.clientId;
      loadDocument(msg.document);
      state.aiStatus = msg.aiStatus || 'idle';
      applyPresence(msg.presence || []);
      statusEl.textContent = `接続済み (${msg.clientId})`;
      renderItems();
      break;
    }
    case 'board-reset': {
      loadDocument(msg.document);
      renderItems();
      break;
    }
    case 'property-updated': {
      if (msg.key !== 'bid') break;
      const node = state.nodes.get(msg.nodeId);
      if (!node) break;
      const previousBidder = node.properties.bid?.bidder;
      node.properties.bid = msg.value;
      renderItems();
      flashItem(msg.nodeId);
      if (previousBidder === state.clientId && msg.value.bidder !== state.clientId) {
        showToast(`「${node.properties.name}」で他の入札に上書きされました(LWWなので後から届いた方が勝ちます)`);
      }
      break;
    }
    case 'ai-status': {
      state.aiStatus = msg.status;
      updatePresenceAiStatus();
      break;
    }
    case 'client-joined': {
      state.presence.set(msg.clientId, {});
      renderPresence();
      break;
    }
    case 'client-left': {
      state.presence.delete(msg.clientId);
      renderPresence();
      break;
    }
    case 'activity': {
      appendActivity(msg);
      break;
    }
    default:
      break;
  }
}

function applyPresence(list) {
  state.presence.clear();
  for (const p of list) {
    if (p.clientId === state.clientId) continue;
    state.presence.set(p.clientId, { isAi: !!p.isAi, status: p.status });
  }
  renderPresence();
}

function updatePresenceAiStatus() {
  const ai = state.presence.get(AI_CLIENT_ID);
  if (ai) ai.status = state.aiStatus;
  renderPresence();
}

function renderPresence() {
  presenceList.innerHTML = '';
  addPresenceRow(state.clientId, true, false, null);
  for (const [clientId, info] of state.presence) {
    addPresenceRow(clientId, false, !!info.isAi, info.status);
  }
}

function addPresenceRow(clientId, self, isAi, status) {
  if (clientId == null) return;
  const row = document.createElement('div');
  row.className = 'presence-row';
  const dot = document.createElement('div');
  dot.className = 'presence-dot';
  dot.style.background = colorForClient(clientId);
  const label = document.createElement('span');
  label.textContent = isAi ? '🤖 AIエージェント' : `${clientId}${self ? ' (自分)' : ''}`;
  row.append(dot, label);
  if (isAi) {
    const statusEl2 = document.createElement('span');
    statusEl2.className = 'ai-status';
    statusEl2.textContent = statusLabel(status || state.aiStatus);
    row.appendChild(statusEl2);
  }
  presenceList.appendChild(row);
}

function statusLabel(status) {
  if (status === 'thinking') return '考え中...';
  if (status === 'acting') return '入札中...';
  return '待機中';
}

function appendActivity(entry) {
  const line = document.createElement('div');
  const isAi = entry.actor === AI_CLIENT_ID;
  const cls = isAi ? 'ai' : entry.action?.includes('rejected') ? 'reject' : 'remote';
  line.className = `log-line ${cls}`;
  const time = new Date(entry.at || Date.now()).toLocaleTimeString('ja-JP', { hour12: false });
  const actorLabel = isAi ? '🤖 AI' : entry.actor;
  line.textContent = `[${time}] ${actorLabel}: ${entry.detail}`;
  activityList.prepend(line);
  while (activityList.children.length > 300) activityList.removeChild(activityList.lastChild);
}

function showToast(text) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = text;
  toastLayer.appendChild(toast);
  setTimeout(() => toast.remove(), 3700);
}

function flashItem(nodeId) {
  const el = document.querySelector(`[data-node-id="${nodeId}"]`);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// ---- 操作 ----

function placeBid(nodeId, amount) {
  send({ type: 'update-property', nodeId, key: 'bid', value: { amount, bidder: state.clientId, at: Date.now() } });
}

function bidIncrement(nodeId, currentAmount, delta) {
  placeBid(nodeId, currentAmount + delta);
}

function bidCustom(nodeId, inputEl) {
  const value = parseInt(inputEl.value, 10);
  if (Number.isNaN(value)) return;
  placeBid(nodeId, value);
  inputEl.value = '';
}

function bidLowball(nodeId) {
  placeBid(nodeId, 1);
}

// ---- 描画 ----

function renderItems() {
  itemsEl.innerHTML = '';
  for (const item of getItems()) {
    itemsEl.appendChild(renderItemCard(item));
  }
}

function renderItemCard(item) {
  const bid = item.properties.bid || { amount: item.properties.startBid, bidder: null };
  const el = document.createElement('div');
  el.className = 'item-card';
  el.dataset.nodeId = item.id;

  const name = document.createElement('div');
  name.className = 'item-name';
  name.textContent = item.properties.name ?? item.id;

  const amount = document.createElement('div');
  amount.className = 'item-bid-amount';
  amount.textContent = `¥${bid.amount.toLocaleString('ja-JP')}`;

  const bidder = document.createElement('div');
  const isMine = bid.bidder === state.clientId;
  bidder.className = 'item-bid-bidder' + (isMine ? ' mine' : '');
  bidder.textContent = bid.bidder
    ? `現在の最高額: ${bid.bidder === AI_CLIENT_ID ? '🤖 AI' : bid.bidder}${isMine ? ' (自分)' : ''}`
    : 'まだ入札がありません';

  const actions = document.createElement('div');
  actions.className = 'item-actions';
  for (const delta of [100, 500, 1000]) {
    const btn = document.createElement('button');
    btn.textContent = `+${delta}円で入札`;
    btn.onclick = () => bidIncrement(item.id, bid.amount, delta);
    actions.appendChild(btn);
  }
  const lowballBtn = document.createElement('button');
  lowballBtn.className = 'lowball';
  lowballBtn.textContent = '❗️1円で強引に入札';
  lowballBtn.title = 'LWWの弱点を実演: 金額に関係なく、これが最後に届けば勝ちます';
  lowballBtn.onclick = () => bidLowball(item.id);
  actions.appendChild(lowballBtn);

  const custom = document.createElement('div');
  custom.className = 'item-custom';
  const input = document.createElement('input');
  input.type = 'number';
  input.placeholder = '金額を指定';
  const customBtn = document.createElement('button');
  customBtn.textContent = '入札';
  customBtn.onclick = () => bidCustom(item.id, input);
  custom.append(input, customBtn);

  el.append(name, amount, bidder, actions, custom);
  return el;
}

sendBtn.addEventListener('click', () => {
  const text = instructionInput.value.trim();
  if (!text) return;
  send({ type: 'ai-instruction', text });
  instructionInput.value = '';
});
instructionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendBtn.click();
});
seedBtn.addEventListener('click', () => send({ type: 'seed-demo-data' }));

connect();
