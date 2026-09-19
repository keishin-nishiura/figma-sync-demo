// ピクセルキャンバスデモのクライアント実装。
// マス目=ノード、色=プロパティという最小限のモデルで、既存の
// update-property(色の変更)・select-node/deselect-node(誰がどのマスを
// 触っているか)・cursor-move/cursor-leave(誰がどこにいるか)を
// そのまま使い回している。サーバー側にこのデモ専用のロジックはほぼ無い。

const AI_CLIENT_ID = 'ai-agent';
const AI_COLOR = '#f97316';
const COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#eab308', '#a855f7', '#ec4899'];
const PALETTE = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#ffffff', '#1e1e1e'];

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
  selectedColor: PALETTE[0],
  remoteCursors: new Map(),
  remoteCellSelections: new Map(), // fromClientId -> nodeId
  isPainting: false,
};

const gridEl = document.getElementById('grid');
const cursorLayer = document.getElementById('cursor-layer');
const statusEl = document.getElementById('status');
const presenceList = document.getElementById('presence-list');
const activityList = document.getElementById('activity-list');
const paletteEl = document.getElementById('palette');
const instructionInput = document.getElementById('ai-instruction');
const sendBtn = document.getElementById('ai-send');
const seedBtn = document.getElementById('seed-btn');
const canvasWrap = document.getElementById('canvas-wrap');

let ws;
function connect() {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProtocol}//${location.host}/ws-paint`);
  ws.addEventListener('open', () => { statusEl.textContent = '接続済み'; });
  ws.addEventListener('close', () => { statusEl.textContent = '切断されました'; });
  ws.addEventListener('message', (ev) => handleMessage(JSON.parse(ev.data)));
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function getCells() {
  return [...state.nodes.values()].filter((n) => n.properties?.type === 'cell');
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
      renderGrid();
      break;
    }
    case 'board-reset': {
      loadDocument(msg.document);
      state.remoteCellSelections.clear();
      renderGrid();
      break;
    }
    case 'property-updated': {
      if (msg.key !== 'color') break;
      const node = state.nodes.get(msg.nodeId);
      if (!node) break;
      node.properties.color = msg.value;
      updateCellColor(msg.nodeId, msg.value);
      break;
    }
    case 'select-node': {
      state.remoteCellSelections.set(msg.fromClientId, msg.nodeId);
      renderSelectedByBorders();
      break;
    }
    case 'deselect-node': {
      state.remoteCellSelections.delete(msg.fromClientId);
      renderSelectedByBorders();
      break;
    }
    case 'cursor-move': {
      const color = colorForClient(msg.fromClientId);
      state.remoteCursors.set(msg.fromClientId, { x: msg.x, y: msg.y, color });
      renderCursors();
      break;
    }
    case 'cursor-leave': {
      state.remoteCursors.delete(msg.fromClientId);
      renderCursors();
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
      state.remoteCursors.delete(msg.clientId);
      state.remoteCellSelections.delete(msg.clientId);
      renderPresence();
      renderCursors();
      renderSelectedByBorders();
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
  if (status === 'acting') return '作業中...';
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
  while (activityList.children.length > 500) activityList.removeChild(activityList.lastChild);
}

// ---- パレット ----

function renderPalette() {
  paletteEl.innerHTML = '';
  for (const color of PALETTE) {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (color === state.selectedColor ? ' selected' : '');
    sw.style.background = color;
    sw.onclick = () => {
      state.selectedColor = color;
      renderPalette();
    };
    paletteEl.appendChild(sw);
  }
}

// ---- 描画 ----

function renderGrid() {
  const cells = getCells();
  if (cells.length === 0) return;
  const gridSize = Math.max(...cells.map((c) => c.properties.row)) + 1;
  gridEl.style.gridTemplateColumns = `repeat(${gridSize}, 28px)`;
  gridEl.innerHTML = '';
  const sorted = [...cells].sort((a, b) => a.properties.row - b.properties.row || a.properties.col - b.properties.col);
  for (const cell of sorted) {
    const el = document.createElement('div');
    el.className = 'cell';
    el.dataset.nodeId = cell.id;
    el.style.background = cell.properties.color;
    el.addEventListener('mousedown', (e) => { e.preventDefault(); startPaint(cell.id); });
    el.addEventListener('mouseenter', () => { if (state.isPainting) paintCell(cell.id); });
    gridEl.appendChild(el);
  }
  renderSelectedByBorders();
}

function updateCellColor(nodeId, color) {
  const el = gridEl.querySelector(`[data-node-id="${nodeId}"]`);
  if (el) el.style.background = color;
}

function renderSelectedByBorders() {
  gridEl.querySelectorAll('.cell.selected-by').forEach((el) => {
    el.classList.remove('selected-by');
    el.style.boxShadow = '';
  });
  for (const [fromClientId, nodeId] of state.remoteCellSelections) {
    const el = gridEl.querySelector(`[data-node-id="${nodeId}"]`);
    if (!el) continue;
    el.classList.add('selected-by');
    el.style.boxShadow = `inset 0 0 0 2px ${colorForClient(fromClientId)}`;
  }
}

function renderCursors() {
  cursorLayer.innerHTML = '';
  for (const [clientId, cursor] of state.remoteCursors) {
    const el = document.createElement('div');
    el.className = 'remote-cursor';
    el.style.left = `${cursor.x}px`;
    el.style.top = `${cursor.y}px`;
    el.innerHTML = `
      <svg class="cursor-icon" width="18" height="18" viewBox="0 0 18 18">
        <path d="M1 1 L1 13.5 L4.5 10.5 L7 16 L9.3 15 L6.8 9.5 L12 9.2 Z" fill="${cursor.color}" stroke="white" stroke-width="1" stroke-linejoin="round" />
      </svg>
      <span class="label">${clientId}</span>
    `;
    const labelEl = el.querySelector('.label');
    if (labelEl) labelEl.style.background = cursor.color;
    cursorLayer.appendChild(el);
  }
}

// ---- ペイント操作 ----

function paintCell(nodeId) {
  const node = state.nodes.get(nodeId);
  if (!node || node.properties.color === state.selectedColor) return;
  send({ type: 'update-property', nodeId, key: 'color', value: state.selectedColor });
}

function startPaint(nodeId) {
  state.isPainting = true;
  paintCell(nodeId);
  send({ type: 'select-node', nodeId });
  window.addEventListener('mouseup', stopPaint, { once: true });
}

function stopPaint() {
  state.isPainting = false;
  send({ type: 'deselect-node' });
}

// ---- カーソル位置の同期 ----

let lastCursorSent = 0;
canvasWrap.addEventListener('mousemove', (e) => {
  const rect = canvasWrap.getBoundingClientRect();
  const x = Math.round(e.clientX - rect.left);
  const y = Math.round(e.clientY - rect.top);
  const now = performance.now();
  if (now - lastCursorSent > 40) {
    lastCursorSent = now;
    send({ type: 'cursor-move', x, y });
  }
});
canvasWrap.addEventListener('mouseleave', () => {
  send({ type: 'cursor-leave' });
});

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

renderPalette();
connect();
