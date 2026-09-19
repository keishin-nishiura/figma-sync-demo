// Agent Workspace (Kanban) のクライアント実装。
// 既存の client/public/app.js と同じ考え方(WebSocket + 楽観的更新は行わず
// 確定を待って再描画する簡易版)を、Human+AIの共同編集ボード用に実装したもの。
// AIはサーバー側で人間と全く同じメッセージ型(node-created/property-updated/
// reparent-applied/node-deleted)をブロードキャストしてくるため、
// クライアント側はfromClientIdがAIかどうかを気にせず同じ描画パスで処理できる。

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
  presence: new Map(), // clientId -> { isAi, status }
  selectedNodeId: null,
  remoteNodeSelections: new Map(), // fromClientId -> nodeId
  aiStatus: 'idle',
};

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const presenceList = document.getElementById('presence-list');
const activityList = document.getElementById('activity-list');
const aiCursorEl = document.getElementById('ai-cursor');
const instructionInput = document.getElementById('ai-instruction');
const sendBtn = document.getElementById('ai-send');
const seedBtn = document.getElementById('seed-btn');

let ws;
function connect() {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProtocol}//${location.host}/ws-agent`);
  ws.addEventListener('open', () => { statusEl.textContent = '接続済み'; });
  ws.addEventListener('close', () => { statusEl.textContent = '切断されました'; });
  ws.addEventListener('message', (ev) => handleMessage(JSON.parse(ev.data)));
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function getChildren(parentId) {
  return [...state.nodes.values()]
    .filter((n) => n.parentId === parentId)
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
      renderAll();
      break;
    }
    case 'board-reset': {
      loadDocument(msg.document);
      state.remoteNodeSelections.clear();
      state.selectedNodeId = null;
      renderAll();
      break;
    }
    case 'node-created': {
      state.nodes.set(msg.node.id, structuredClone(msg.node));
      renderAll();
      break;
    }
    case 'property-updated': {
      const node = state.nodes.get(msg.nodeId);
      if (!node) break;
      node.properties[msg.key] = msg.value;
      renderAll();
      break;
    }
    case 'reparent-applied': {
      const node = state.nodes.get(msg.nodeId);
      if (!node) break;
      node.parentId = msg.newParentId;
      node.order = msg.order;
      renderAll();
      break;
    }
    case 'node-moved': {
      const node = state.nodes.get(msg.nodeId);
      if (!node) break;
      node.order = msg.order;
      renderAll();
      break;
    }
    case 'node-deleted': {
      state.nodes.delete(msg.nodeId);
      state.remoteNodeSelections.forEach((nodeId, clientId) => {
        if (nodeId === msg.nodeId) state.remoteNodeSelections.delete(clientId);
      });
      renderAll();
      break;
    }
    case 'select-node': {
      state.remoteNodeSelections.set(msg.fromClientId, msg.nodeId);
      renderAll();
      break;
    }
    case 'deselect-node': {
      state.remoteNodeSelections.delete(msg.fromClientId);
      renderAll();
      break;
    }
    case 'ai-cursor': {
      moveAiCursorTo(msg.nodeId);
      break;
    }
    case 'ai-status': {
      state.aiStatus = msg.status;
      updatePresenceAiStatus();
      if (msg.status === 'idle') hideAiCursor();
      break;
    }
    case 'client-joined': {
      state.presence.set(msg.clientId, {});
      renderPresence();
      break;
    }
    case 'client-left': {
      state.presence.delete(msg.clientId);
      state.remoteNodeSelections.delete(msg.clientId);
      renderPresence();
      renderAll();
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
  addPresenceRow(state.clientId, true, false, null); // 自分
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
  label.textContent = isAi ? `🤖 AIエージェント${self ? '' : ''}` : `${clientId}${self ? ' (自分)' : ''}`;
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
  while (activityList.children.length > 300) activityList.removeChild(activityList.lastChild);
}

function moveAiCursorTo(nodeId) {
  const el = document.querySelector(`[data-node-id="${nodeId}"]`);
  if (!el) return;
  const rect = el.getBoundingClientRect();
  aiCursorEl.style.display = 'flex';
  aiCursorEl.style.left = `${rect.left + rect.width / 2 - 7}px`;
  aiCursorEl.style.top = `${rect.top - 24}px`;
}

function hideAiCursor() {
  setTimeout(() => { aiCursorEl.style.display = 'none'; }, 500);
}

// ---- 操作 ----

function selectNode(nodeId) {
  if (state.selectedNodeId === nodeId) return;
  state.selectedNodeId = nodeId;
  send({ type: 'select-node', nodeId });
  renderAll();
}

function deselectNode() {
  if (state.selectedNodeId === null) return;
  state.selectedNodeId = null;
  send({ type: 'deselect-node' });
  renderAll();
}

function renameTask(nodeId) {
  const node = state.nodes.get(nodeId);
  if (!node) return;
  const next = prompt('タスク名を編集', node.properties.title ?? '');
  if (next == null || next.trim() === '') return;
  send({ type: 'update-property', nodeId, key: 'title', value: next.trim() });
}

function deleteTask(nodeId) {
  send({ type: 'delete-node', nodeId });
}

function moveTaskToColumn(nodeId, newParentId) {
  send({ type: 'reparent', nodeId, newParentId });
}

function reorderTask(nodeId, beforeId, afterId) {
  send({ type: 'move-node', nodeId, beforeId, afterId });
}

function addTask(columnId) {
  const title = prompt('新しいタスク名', '');
  if (!title || !title.trim()) return;
  const id = 'task-' + Math.random().toString(36).slice(2, 8);
  send({ type: 'create-node', nodeId: id, parentId: columnId, properties: { type: 'task', title: title.trim() } });
}

// ---- 描画 ----

function renderAll() {
  boardEl.innerHTML = '';
  const columns = getChildren('root').filter((n) => n.properties?.type === 'column');
  for (const col of columns) {
    boardEl.appendChild(renderColumn(col, columns));
  }
}

function renderColumn(col, allColumns) {
  const tasks = getChildren(col.id);
  const wrap = document.createElement('div');
  wrap.className = 'column';
  wrap.style.borderTopColor = col.properties.color || '#666';

  const header = document.createElement('div');
  header.className = 'column-header';
  header.innerHTML = `<span>${col.properties.name ?? col.id}</span><span class="column-count">${tasks.length}</span>`;

  const body = document.createElement('div');
  body.className = 'column-body';

  tasks.forEach((task, idx) => {
    body.appendChild(renderTask(task, tasks, idx, allColumns, col.id));
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'task-actions';
  addBtn.textContent = '+ タスク追加';
  addBtn.style.width = '100%';
  addBtn.style.marginTop = '4px';
  addBtn.onclick = () => addTask(col.id);

  wrap.append(header, body, addBtn);
  return wrap;
}

function renderTask(task, siblings, idx, allColumns, currentColId) {
  const el = document.createElement('div');
  el.className = 'task';
  el.dataset.nodeId = task.id;

  if (state.selectedNodeId === task.id) el.classList.add('selected-own');
  const selectedBy = [...state.remoteNodeSelections.entries()].find(([, nodeId]) => nodeId === task.id);
  if (selectedBy) {
    const [fromClientId] = selectedBy;
    const color = colorForClient(fromClientId);
    el.style.borderColor = color;
    el.style.boxShadow = `0 0 0 2px ${color}`;
    const badge = document.createElement('div');
    badge.className = 'selected-by-badge';
    badge.style.background = color;
    badge.textContent = fromClientId === AI_CLIENT_ID ? '🤖 AI' : fromClientId;
    el.appendChild(badge);
  }

  const title = document.createElement('div');
  title.textContent = task.properties.title ?? task.id;
  el.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'task-actions';

  const otherColumns = allColumns.filter((c) => c.id !== currentColId);
  const moveSelect = document.createElement('select');
  const placeholder = document.createElement('option');
  placeholder.textContent = '列を移動...';
  placeholder.value = '';
  moveSelect.appendChild(placeholder);
  for (const c of otherColumns) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `→ ${c.properties.name ?? c.id}`;
    moveSelect.appendChild(opt);
  }
  moveSelect.onchange = () => {
    if (moveSelect.value) moveTaskToColumn(task.id, moveSelect.value);
  };

  const upBtn = document.createElement('button');
  upBtn.textContent = '↑';
  upBtn.disabled = idx === 0;
  upBtn.onclick = () => reorderTask(task.id, siblings[idx - 2]?.id ?? null, siblings[idx - 1]?.id ?? null);

  const downBtn = document.createElement('button');
  downBtn.textContent = '↓';
  downBtn.disabled = idx === siblings.length - 1;
  downBtn.onclick = () => reorderTask(task.id, siblings[idx + 1]?.id ?? null, siblings[idx + 2]?.id ?? null);

  const editBtn = document.createElement('button');
  editBtn.textContent = '編集';
  editBtn.onclick = () => renameTask(task.id);

  const delBtn = document.createElement('button');
  delBtn.textContent = '削除';
  delBtn.onclick = () => deleteTask(task.id);

  actions.append(moveSelect, upBtn, downBtn, editBtn, delBtn);
  el.appendChild(actions);

  el.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
    if (state.selectedNodeId === task.id) deselectNode();
    else selectNode(task.id);
  });

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
