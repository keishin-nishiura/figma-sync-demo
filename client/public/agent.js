// Agent Workspace (Kanban) のクライアント実装。
// 既存の client/public/app.js と同じ考え方(WebSocket + 確定を待って再描画)を、
// Human+AIの共同編集ボード用に実装したもの。
// AIはサーバー側で人間と全く同じメッセージ型(node-created/property-updated/
// reparent-applied/node-moved/node-deleted)をブロードキャストしてくるため、
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
  while (activityList.children.length > 300) activityList.removeChild(activityList.lastChild);
}

function moveAiCursorTo(nodeId) {
  const el = document.querySelector(`[data-node-id="${nodeId}"]`);
  if (!el) return;
  const rect = el.getBoundingClientRect();
  aiCursorEl.style.display = 'flex';
  aiCursorEl.style.left = `${rect.left + rect.width / 2 - 7}px`;
  aiCursorEl.style.top = `${rect.top - 24}px`;
  el.classList.add('ai-focused');
  setTimeout(() => el.classList.remove('ai-focused'), 900);
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

function addTask(columnId) {
  const title = prompt('新しいタスク名', '');
  if (!title || !title.trim()) return;
  const id = 'task-' + Math.random().toString(36).slice(2, 8);
  send({ type: 'create-node', nodeId: id, parentId: columnId, properties: { type: 'task', title: title.trim() } });
}

// ---- ドラッグ&ドロップ (タスクの列移動・並び替え) ----
// HTML5 Drag and Drop APIを使用。ドラッグ中は「挿入位置」を示す
// プレースホルダーをDOM上に差し込み、ドロップ時にそのプレースホルダーの
// 前後にいるノードのidから beforeId/afterId を算出して move-node を送る。
// 列をまたぐ場合は reparent を先に送り、続けて同じ beforeId/afterId で
// move-node を送って位置を確定させる(サーバーは同一コネクションからの
// メッセージを受信順に処理するため、この2通のメッセージは順序通り適用される)。

let draggingNodeId = null;
const placeholder = document.createElement('div');
placeholder.className = 'drop-placeholder';

function computeDropPosition(columnBodyEl, clientY) {
  const taskEls = [...columnBodyEl.querySelectorAll('.task')].filter((el) => el.dataset.nodeId !== draggingNodeId);
  let afterEl = null;
  for (const el of taskEls) {
    const box = el.getBoundingClientRect();
    if (clientY < box.top + box.height / 2) { afterEl = el; break; }
  }
  const afterIdx = afterEl ? taskEls.indexOf(afterEl) : taskEls.length;
  const beforeEl = afterIdx > 0 ? taskEls[afterIdx - 1] : null;
  return {
    beforeId: beforeEl ? beforeEl.dataset.nodeId : null,
    afterId: afterEl ? afterEl.dataset.nodeId : null,
    afterEl,
  };
}

function clearDragVisuals() {
  placeholder.remove();
  document.querySelectorAll('.column-body.drag-over').forEach((el) => el.classList.remove('drag-over'));
}

function attachColumnDropZone(bodyEl, columnId) {
  bodyEl.addEventListener('dragover', (e) => {
    if (!draggingNodeId) return;
    e.preventDefault();
    bodyEl.classList.add('drag-over');
    const { afterEl } = computeDropPosition(bodyEl, e.clientY);
    if (afterEl) bodyEl.insertBefore(placeholder, afterEl);
    else bodyEl.appendChild(placeholder);
  });
  bodyEl.addEventListener('dragleave', (e) => {
    if (e.target === bodyEl) bodyEl.classList.remove('drag-over');
  });
  bodyEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!draggingNodeId) return;
    const nodeId = draggingNodeId;
    const node = state.nodes.get(nodeId);
    const { beforeId, afterId } = computeDropPosition(bodyEl, e.clientY);
    clearDragVisuals();
    if (!node) return;
    if (node.parentId !== columnId) {
      send({ type: 'reparent', nodeId, newParentId: columnId });
    }
    send({ type: 'move-node', nodeId, beforeId, afterId });
  });
}

// ---- 描画 ----

function renderAll() {
  boardEl.innerHTML = '';
  const columns = getChildren('root').filter((n) => n.properties?.type === 'column');
  for (const col of columns) {
    boardEl.appendChild(renderColumn(col));
  }
}

function renderColumn(col) {
  const tasks = getChildren(col.id);
  const wrap = document.createElement('div');
  wrap.className = 'column';
  wrap.style.borderTopColor = col.properties.color || '#666';

  const header = document.createElement('div');
  header.className = 'column-header';
  header.innerHTML = `<span>${col.properties.name ?? col.id}</span><span class="column-count">${tasks.length}</span>`;

  const body = document.createElement('div');
  body.className = 'column-body';
  body.dataset.columnId = col.id;

  if (tasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'column-empty';
    empty.textContent = 'ここにドラッグ';
    body.appendChild(empty);
  }

  for (const task of tasks) {
    body.appendChild(renderTask(task));
  }

  attachColumnDropZone(body, col.id);

  const addBtn = document.createElement('button');
  addBtn.className = 'add-task-btn';
  addBtn.textContent = '+ タスク追加';
  addBtn.onclick = () => addTask(col.id);

  wrap.append(header, body, addBtn);
  return wrap;
}

function renderTask(task) {
  const el = document.createElement('div');
  el.className = 'task';
  el.dataset.nodeId = task.id;
  el.draggable = true;
  if (task.properties.priority === 'high') el.classList.add('priority-high');

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
  title.className = 'task-title';
  title.textContent = (task.properties.priority === 'high' ? '⭐ ' : '') + (task.properties.title ?? task.id);
  el.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'task-actions';

  const editBtn = document.createElement('button');
  editBtn.textContent = '編集';
  editBtn.onclick = (e) => { e.stopPropagation(); renameTask(task.id); };

  const delBtn = document.createElement('button');
  delBtn.textContent = '削除';
  delBtn.onclick = (e) => { e.stopPropagation(); deleteTask(task.id); };

  actions.append(editBtn, delBtn);
  el.appendChild(actions);

  el.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    if (state.selectedNodeId === task.id) deselectNode();
    else selectNode(task.id);
  });

  el.addEventListener('dragstart', (e) => {
    draggingNodeId = task.id;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
  });
  el.addEventListener('dragend', () => {
    draggingNodeId = null;
    el.classList.remove('dragging');
    clearDragVisuals();
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
