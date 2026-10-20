// Agent Workspace (Kanban) のクライアント実装。
// 既存の client/public/app.js と同じ考え方(WebSocket + 確定を待って再描画)を、
// Human+AIの共同編集ボード用に実装したもの。
// AIはサーバー側で人間と全く同じメッセージ型(node-created/property-updated/
// reparent-applied/node-moved/node-deleted)をブロードキャストしてくるため、
// クライアント側はfromClientIdがAIかどうかを気にせず同じ描画パスで処理できる。
//
// ドラッグ中の「運んでいる途中」描写は Document ではなくプレゼンス
// (drag-start / drag-hover / drag-end)として扱い、サーバーは中継するだけ。
// 本人・他人・AIで同じゴースト/プレースホルダー部品を使い、見た目と動きを揃える。

const AI_CLIENT_ID = 'ai-agent';
const AI_COLOR = '#f97316';
const COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#eab308', '#a855f7', '#ec4899'];
const DRAG_HOVER_MIN_INTERVAL_MS = 40;
const DRAG_END_GRACE_MS = 100;
const AI_INTERPOLATE_MS = 450;
const GHOST_RETURN_MS = 220;
const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ブラウザ標準のドラッグ画像を消すための 1x1 透明 GIF
const TRANSPARENT_DRAG_IMAGE = new Image();
TRANSPARENT_DRAG_IMAGE.src =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function colorForClient(id) {
  if (id === AI_CLIENT_ID) return AI_COLOR;
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function displayNameForClient(clientId) {
  if (clientId === AI_CLIENT_ID) return 'AI';
  return clientId;
}

const state = {
  clientId: null,
  nodes: new Map(),
  presence: new Map(), // clientId -> { isAi, status }
  selectedNodeId: null,
  remoteNodeSelections: new Map(), // fromClientId -> nodeId
  remoteCursors: new Map(), // fromClientId -> { x, y, color }
  // clientId -> ドラッグ中状態(自分・他人・AI共通)
  // { nodeId, columnId, beforeId, bx, by, grabOffsetX, grabOffsetY,
  //   originLeft, originTop, originWidth, confirmed, endingTimer, anim }
  activeDrags: new Map(),
  aiStatus: 'idle',
};

const boardEl = document.getElementById('board');
const boardWrapEl = document.getElementById('board-wrap');
const statusEl = document.getElementById('status');
const presenceList = document.getElementById('presence-list');
const activityList = document.getElementById('activity-list');
const aiCursorEl = document.getElementById('ai-cursor');
const dragGhostLayer = document.getElementById('drag-ghost-layer');
const cursorLayer = document.getElementById('cursor-layer');
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
      clearAllDrags();
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
      // 確定 → ゴーストは即消し、FLIPの着地に任せる
      confirmDragForNode(msg.nodeId, msg.fromClientId);
      renderAll();
      break;
    }
    case 'node-moved': {
      const node = state.nodes.get(msg.nodeId);
      if (!node) break;
      node.order = msg.order;
      confirmDragForNode(msg.nodeId, msg.fromClientId);
      renderAll();
      break;
    }
    case 'node-deleted': {
      state.nodes.delete(msg.nodeId);
      state.remoteNodeSelections.forEach((nodeId, clientId) => {
        if (nodeId === msg.nodeId) state.remoteNodeSelections.delete(clientId);
      });
      for (const [clientId, drag] of [...state.activeDrags]) {
        if (drag.nodeId === msg.nodeId) clearDrag(clientId);
      }
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
    case 'drag-start': {
      if (msg.fromClientId === state.clientId) break;
      if (!state.nodes.has(msg.nodeId)) break;
      beginDrag(msg.fromClientId, msg.nodeId, {
        follow: false,
        grabOffsetX: typeof msg.ox === 'number' ? msg.ox : 0,
        grabOffsetY: typeof msg.oy === 'number' ? msg.oy : 0,
      });
      break;
    }
    case 'drag-hover': {
      if (msg.fromClientId === state.clientId) break;
      if (!state.nodes.has(msg.nodeId)) break;
      updateDragHover(msg.fromClientId, {
        nodeId: msg.nodeId,
        columnId: msg.columnId,
        beforeId: msg.beforeId ?? null,
        bx: typeof msg.bx === 'number' ? msg.bx : null,
        by: typeof msg.by === 'number' ? msg.by : null,
      });
      break;
    }
    case 'drag-end': {
      if (msg.fromClientId === state.clientId) break;
      endDragWithGrace(msg.fromClientId);
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
      state.remoteCursors.delete(msg.clientId);
      clearDrag(msg.clientId);
      renderPresence();
      renderCursors();
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
  moveAiCursorToPoint(rect.left + rect.width / 2 - 7, rect.top - 24);
  el.classList.add('ai-focused');
  setTimeout(() => el.classList.remove('ai-focused'), 900);
}

function moveAiCursorToPoint(x, y) {
  aiCursorEl.style.display = 'flex';
  aiCursorEl.style.left = `${x}px`;
  aiCursorEl.style.top = `${y}px`;
}

function hideAiCursor() {
  setTimeout(() => { aiCursorEl.style.display = 'none'; }, 500);
}

function renderCursors() {
  cursorLayer.innerHTML = '';
  for (const [clientId, cursor] of state.remoteCursors) {
    const el = document.createElement('div');
    el.className = 'remote-cursor';
    el.style.left = `${cursor.x}px`;
    el.style.top = `${cursor.y}px`;
    el.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 18 18">
        <path d="M1 1 L1 13.5 L4.5 10.5 L7 16 L9.3 15 L6.8 9.5 L12 9.2 Z" fill="${cursor.color}" stroke="white" stroke-width="1" stroke-linejoin="round" />
      </svg>
      <span class="label">${displayNameForClient(clientId)}</span>
    `;
    const labelEl = el.querySelector('.label');
    if (labelEl) labelEl.style.background = cursor.color;
    cursorLayer.appendChild(el);
  }
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

// ---- ボード座標 ----

function pointerToBoardRatio(clientX, clientY) {
  const rect = boardEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { bx: 0.5, by: 0.5 };
  return {
    bx: (clientX - rect.left) / rect.width,
    by: (clientY - rect.top) / rect.height,
  };
}

function boardRatioToClient(bx, by) {
  const rect = boardEl.getBoundingClientRect();
  return {
    x: rect.left + bx * rect.width,
    y: rect.top + by * rect.height,
  };
}

// ---- ドラッグ&ドロップ + 共通ゴースト描画 ----
// HTML5 DnDで確定(reparent/move-node)を送りつつ、本人・他人とも同じ
// ゴースト/プレースホルダー/挿入ギャップで「運んでいる途中」を描く。
// ポインタ軌跡は drag-hover の bx/by(ボード割合)で共有する。

let draggingNodeId = null;
let localDropSucceeded = false;
let lastDragHoverKey = null;
let lastDragHoverSentAt = 0;
let pendingDragHover = null;
let pendingDragHoverTimer = null;
let lastPointer = { x: 0, y: 0 };

function computeDropPosition(columnBodyEl, clientY, excludeNodeId) {
  const skipId = excludeNodeId ?? draggingNodeId;
  const taskEls = [...columnBodyEl.querySelectorAll('.task')].filter((el) => {
    if (el.dataset.nodeId === skipId) return false;
    // プレースホルダー化されたソースもスキップ(同じnodeId)
    return true;
  });
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

function sendCursorAt(clientX, clientY) {
  send({ type: 'cursor-move', x: Math.round(clientX), y: Math.round(clientY) });
}

function flushDragHover() {
  if (!draggingNodeId || !pendingDragHover) return;
  const { columnId, insertBeforeId, bx, by } = pendingDragHover;
  const key = `${draggingNodeId}|${columnId}|${insertBeforeId ?? ''}|${bx.toFixed(3)}|${by.toFixed(3)}`;
  if (key === lastDragHoverKey) {
    pendingDragHover = null;
    return;
  }
  lastDragHoverKey = key;
  lastDragHoverSentAt = performance.now();
  const payload = {
    type: 'drag-hover',
    nodeId: draggingNodeId,
    columnId,
    beforeId: insertBeforeId,
    bx,
    by,
  };
  pendingDragHover = null;
  send(payload);
}

function maybeSendDragHover(columnId, insertBeforeId, bx, by) {
  pendingDragHover = { columnId, insertBeforeId, bx, by };
  const key = `${draggingNodeId}|${columnId}|${insertBeforeId ?? ''}|${bx.toFixed(3)}|${by.toFixed(3)}`;
  if (key === lastDragHoverKey) return;
  const now = performance.now();
  const wait = DRAG_HOVER_MIN_INTERVAL_MS - (now - lastDragHoverSentAt);
  if (wait > 0) {
    if (!pendingDragHoverTimer) {
      pendingDragHoverTimer = setTimeout(() => {
        pendingDragHoverTimer = null;
        flushDragHover();
      }, wait);
    }
    return;
  }
  flushDragHover();
}

function updateLocalDragFromPointer(clientX, clientY, columnId, insertBeforeId) {
  lastPointer = { x: clientX, y: clientY };
  const drag = state.activeDrags.get(state.clientId);
  if (!drag) return;
  const gapChanged = columnId != null
    && (drag.columnId !== columnId || drag.beforeId !== insertBeforeId);
  if (columnId != null) {
    drag.columnId = columnId;
    drag.beforeId = insertBeforeId;
  }
  const { bx, by } = pointerToBoardRatio(clientX, clientY);
  drag.bx = bx;
  drag.by = by;
  positionGhostAtPointer(state.clientId, clientX, clientY);
  if (gapChanged) applyDragVisuals({ animateFlip: true });
  if (drag.columnId) {
    maybeSendDragHover(drag.columnId, drag.beforeId, bx, by);
  }
  sendCursorAt(clientX, clientY);
}

function attachColumnDropZone(bodyEl, columnId) {
  bodyEl.addEventListener('dragover', (e) => {
    if (!draggingNodeId) return;
    e.preventDefault();
    e.stopPropagation();
    bodyEl.classList.add('drag-over');
    const { afterId } = computeDropPosition(bodyEl, e.clientY);
    updateLocalDragFromPointer(e.clientX, e.clientY, columnId, afterId);
  });
  bodyEl.addEventListener('dragleave', (e) => {
    if (e.target === bodyEl) bodyEl.classList.remove('drag-over');
  });
  bodyEl.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggingNodeId) return;
    const nodeId = draggingNodeId;
    const node = state.nodes.get(nodeId);
    const { beforeId, afterId } = computeDropPosition(bodyEl, e.clientY);
    if (!node) return;
    localDropSucceeded = true;
    if (node.parentId !== columnId) {
      send({ type: 'reparent', nodeId, newParentId: columnId });
    }
    send({ type: 'move-node', nodeId, beforeId, afterId });
  });
}

// 列の外でもゴースト追従・座標送信を続ける
boardWrapEl.addEventListener('dragover', (e) => {
  if (!draggingNodeId) return;
  e.preventDefault();
  updateLocalDragFromPointer(e.clientX, e.clientY, null, null);
});

// ---- 共通ドラッグ状態 / ゴースト ----

function beginDrag(ownerId, nodeId, { follow, grabOffsetX = 0, grabOffsetY = 0, clientX = null, clientY = null } = {}) {
  const node = state.nodes.get(nodeId);
  if (!node) return;
  const sourceEl = boardEl.querySelector(`.task[data-node-id="${nodeId}"]`);
  const rect = sourceEl ? sourceEl.getBoundingClientRect() : { left: 0, top: 0, width: 230, height: 48 };
  const drag = {
    nodeId,
    columnId: node.parentId,
    beforeId: null,
    bx: null,
    by: null,
    grabOffsetX,
    grabOffsetY,
    originLeft: rect.left,
    originTop: rect.top,
    originWidth: rect.width,
    confirmed: false,
    endingTimer: null,
    anim: null,
    follow: !!follow,
  };
  state.activeDrags.set(ownerId, drag);
  ensureDragGhost(ownerId, node);
  if (follow && clientX != null && clientY != null) {
    positionGhostAtPointer(ownerId, clientX, clientY);
  } else {
    setGhostPosition(ownerId, rect.left, rect.top, { immediate: true });
  }
  applyDragVisuals({ animateFlip: false });
}

function updateDragHover(ownerId, { nodeId, columnId, beforeId, bx, by }) {
  let drag = state.activeDrags.get(ownerId);
  if (!drag) {
    beginDrag(ownerId, nodeId, { follow: false });
    drag = state.activeDrags.get(ownerId);
  }
  if (!drag) return;
  drag.nodeId = nodeId;
  drag.columnId = columnId;
  drag.beforeId = beforeId;
  drag.bx = bx;
  drag.by = by;
  applyDragVisuals({ animateFlip: true });

  if (bx != null && by != null) {
    cancelGhostAnim(ownerId);
    const point = boardRatioToClient(bx, by);
    const left = point.x - drag.grabOffsetX;
    const top = point.y - drag.grabOffsetY;
    setGhostPosition(ownerId, left, top, { immediate: prefersReducedMotion(), smooth: true });
  } else {
    // AIなど座標無し: 元位置→挿入ギャップへクライアント側で補間
    interpolateGhostToGap(ownerId);
  }
}

function confirmDragForNode(nodeId, fromClientId) {
  if (fromClientId && state.activeDrags.has(fromClientId)) {
    const drag = state.activeDrags.get(fromClientId);
    if (drag.nodeId === nodeId) {
      drag.confirmed = true;
      clearDrag(fromClientId);
      return;
    }
  }
  for (const [clientId, drag] of [...state.activeDrags]) {
    if (drag.nodeId === nodeId) {
      drag.confirmed = true;
      clearDrag(clientId);
    }
  }
}

function endDragWithGrace(ownerId) {
  const drag = state.activeDrags.get(ownerId);
  if (!drag) return;
  if (drag.confirmed) {
    clearDrag(ownerId);
    return;
  }
  if (drag.endingTimer) clearTimeout(drag.endingTimer);
  drag.endingTimer = setTimeout(() => {
    const current = state.activeDrags.get(ownerId);
    if (!current) return;
    if (current.confirmed) {
      clearDrag(ownerId);
    } else {
      returnGhostThenClear(ownerId);
    }
  }, DRAG_END_GRACE_MS);
}

function clearDrag(ownerId) {
  const drag = state.activeDrags.get(ownerId);
  if (!drag) return;
  if (drag.endingTimer) clearTimeout(drag.endingTimer);
  cancelGhostAnim(ownerId);
  state.activeDrags.delete(ownerId);
  removeDragGhost(ownerId);
  applyDragVisuals({ animateFlip: true });
}

function clearAllDrags() {
  for (const ownerId of [...state.activeDrags.keys()]) {
    const drag = state.activeDrags.get(ownerId);
    if (drag?.endingTimer) clearTimeout(drag.endingTimer);
    cancelGhostAnim(ownerId);
  }
  state.activeDrags.clear();
  dragGhostLayer.innerHTML = '';
}

function ensureDragGhost(ownerId, node) {
  let ghost = dragGhostLayer.querySelector(`[data-ghost-for="${ownerId}"]`);
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.dataset.ghostFor = ownerId;
    dragGhostLayer.appendChild(ghost);
  }
  const drag = state.activeDrags.get(ownerId);
  ghost.classList.toggle('follow', !!(drag && drag.follow));
  ghost.classList.remove('returning');

  const color = colorForClient(ownerId);
  ghost.style.borderColor = color;
  ghost.style.boxShadow = `0 12px 28px rgba(0,0,0,.45), 0 0 0 2px ${color}`;
  if (prefersReducedMotion()) ghost.style.transition = 'none';

  ghost.innerHTML = '';
  const badge = document.createElement('div');
  badge.className = 'ghost-badge';
  badge.style.background = color;
  badge.textContent = ownerId === state.clientId ? `${displayNameForClient(ownerId)} (自分)` : displayNameForClient(ownerId);
  const title = document.createElement('div');
  title.className = 'task-title';
  title.textContent = (node.properties.priority === 'high' ? '⭐ ' : '') + (node.properties.title ?? node.id);
  ghost.append(badge, title);

  if (drag?.originWidth) ghost.style.width = `${drag.originWidth}px`;
}

function removeDragGhost(ownerId) {
  const ghost = dragGhostLayer.querySelector(`[data-ghost-for="${ownerId}"]`);
  if (ghost) ghost.remove();
}

function setGhostPosition(ownerId, left, top, { immediate = false, smooth = false, returning = false } = {}) {
  const ghost = dragGhostLayer.querySelector(`[data-ghost-for="${ownerId}"]`);
  const drag = state.activeDrags.get(ownerId);
  if (!ghost) return;

  ghost.classList.toggle('follow', !!(drag && drag.follow) && !returning);
  ghost.classList.toggle('returning', returning && !prefersReducedMotion());
  if (prefersReducedMotion() || immediate) {
    const prev = ghost.style.transition;
    ghost.style.transition = 'none';
    ghost.style.left = `${left}px`;
    ghost.style.top = `${top}px`;
    ghost.getBoundingClientRect();
    ghost.style.transition = prev;
  } else {
    if (smooth && !drag?.follow) {
      ghost.style.transition = '';
    }
    ghost.style.left = `${left}px`;
    ghost.style.top = `${top}px`;
  }

  if (ownerId === AI_CLIENT_ID) {
    moveAiCursorToPoint(left + (drag?.originWidth || 230) / 2 - 7, top - 24);
  }
}

function positionGhostAtPointer(ownerId, clientX, clientY) {
  const drag = state.activeDrags.get(ownerId);
  if (!drag) return;
  setGhostPosition(ownerId, clientX - drag.grabOffsetX, clientY - drag.grabOffsetY, { immediate: true });
}

function cancelGhostAnim(ownerId) {
  const drag = state.activeDrags.get(ownerId);
  if (drag?.anim) {
    cancelAnimationFrame(drag.anim.raf);
    drag.anim = null;
  }
}

function interpolateGhostToGap(ownerId) {
  const drag = state.activeDrags.get(ownerId);
  const ghost = dragGhostLayer.querySelector(`[data-ghost-for="${ownerId}"]`);
  if (!drag || !ghost) return;

  const gap = boardEl.querySelector(`.drop-placeholder[data-for="${ownerId}"]`);
  const targetEl = gap
    || boardEl.querySelector(`.column-body[data-column-id="${drag.columnId}"]`)
    || null;
  if (!targetEl) return;

  const target = targetEl.getBoundingClientRect();
  const fromLeft = parseFloat(ghost.style.left) || drag.originLeft;
  const fromTop = parseFloat(ghost.style.top) || drag.originTop;
  const toLeft = target.left;
  const toTop = target.top;

  if (prefersReducedMotion()) {
    setGhostPosition(ownerId, toLeft, toTop, { immediate: true });
    return;
  }

  cancelGhostAnim(ownerId);
  const duration = AI_INTERPOLATE_MS;
  const start = performance.now();
  ghost.classList.remove('follow', 'returning');
  ghost.style.transition = 'none';

  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

  const tick = (now) => {
    const current = state.activeDrags.get(ownerId);
    if (!current || current !== drag) return;
    const t = Math.min(1, (now - start) / duration);
    const e = easeInOut(t);
    const left = fromLeft + (toLeft - fromLeft) * e;
    const top = fromTop + (toTop - fromTop) * e;
    ghost.style.left = `${left}px`;
    ghost.style.top = `${top}px`;
    if (ownerId === AI_CLIENT_ID) {
      moveAiCursorToPoint(left + (drag.originWidth || 230) / 2 - 7, top - 24);
    }
    if (t < 1) {
      drag.anim = { raf: requestAnimationFrame(tick) };
    } else {
      drag.anim = null;
      ghost.style.transition = '';
    }
  };
  drag.anim = { raf: requestAnimationFrame(tick) };
}

function returnGhostThenClear(ownerId) {
  const drag = state.activeDrags.get(ownerId);
  const ghost = dragGhostLayer.querySelector(`[data-ghost-for="${ownerId}"]`);
  if (!drag) return;
  cancelGhostAnim(ownerId);

  const finish = () => clearDrag(ownerId);
  if (!ghost || prefersReducedMotion()) {
    finish();
    return;
  }

  setGhostPosition(ownerId, drag.originLeft, drag.originTop, { returning: true });
  const onEnd = (ev) => {
    if (ev.propertyName !== 'top' && ev.propertyName !== 'left') return;
    ghost.removeEventListener('transitionend', onEnd);
    finish();
  };
  ghost.addEventListener('transitionend', onEnd);
  setTimeout(finish, GHOST_RETURN_MS + 80);
}

function syncDragDom() {
  boardEl.querySelectorAll('.drop-placeholder[data-for]').forEach((el) => el.remove());
  boardEl.querySelectorAll('.task.drag-source').forEach((el) => {
    el.classList.remove('drag-source');
    const label = el.querySelector('.drag-source-label');
    if (label) label.remove();
  });
  document.querySelectorAll('.column-body.drag-over').forEach((el) => el.classList.remove('drag-over'));

  for (const [ownerId, drag] of state.activeDrags) {
    const sourceEl = boardEl.querySelector(`.task[data-node-id="${drag.nodeId}"]`);
    if (sourceEl) {
      sourceEl.classList.add('drag-source');
      if (!sourceEl.querySelector('.drag-source-label')) {
        const label = document.createElement('div');
        label.className = 'drag-source-label';
        label.textContent = ownerId === state.clientId
          ? '移動中'
          : `${displayNameForClient(ownerId)}が移動中`;
        sourceEl.appendChild(label);
      }
    }

    if (!drag.columnId) continue;
    const bodyEl = boardEl.querySelector(`.column-body[data-column-id="${drag.columnId}"]`);
    if (!bodyEl) continue;
    const gap = document.createElement('div');
    gap.className = 'drop-placeholder';
    gap.dataset.for = ownerId;

    const afterEl = drag.beforeId && drag.beforeId !== drag.nodeId
      ? bodyEl.querySelector(`.task[data-node-id="${drag.beforeId}"]`)
      : null;
    if (afterEl) bodyEl.insertBefore(gap, afterEl);
    else bodyEl.appendChild(gap);

    const empty = bodyEl.querySelector('.column-empty');
    if (empty) empty.style.display = 'none';

    if (ownerId === state.clientId) bodyEl.classList.add('drag-over');
  }
}

function applyDragVisuals({ animateFlip = true } = {}) {
  const oldRects = animateFlip ? captureTaskRects() : null;
  syncDragDom();
  if (animateFlip && oldRects) playTaskTransitions(oldRects);
}

// ---- 描画 ----
//
// タスクカードの再描画はDOMを毎回作り直す単純な方式だが、それだけだと
// AIや人間がタスクを別の列へ動かしたときに「瞬間移動」に見えてしまい、
// 「何が起きたか」が伝わりにくい。そこでFLIP(First-Last-Invert-Play)手法で、
// 再描画の前後でのカードの画面上の位置の差分を測り、逆方向にずらした状態から
// 実際の位置へトランジションさせることで、実際にスライド移動して見えるようにする。

function captureTaskRects() {
  const rects = new Map();
  boardEl.querySelectorAll('.task').forEach((el) => {
    rects.set(el.dataset.nodeId, el.getBoundingClientRect());
  });
  return rects;
}

function playTaskTransitions(oldRects) {
  if (prefersReducedMotion()) return;
  boardEl.querySelectorAll('.task').forEach((el) => {
    const nodeId = el.dataset.nodeId;
    const oldRect = oldRects.get(nodeId);

    if (!oldRect) {
      el.classList.add('task-enter');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => el.classList.add('task-enter-active'));
      });
      el.addEventListener(
        'transitionend',
        () => el.classList.remove('task-enter', 'task-enter-active'),
        { once: true }
      );
      return;
    }

    const newRect = el.getBoundingClientRect();
    const dx = oldRect.left - newRect.left;
    const dy = oldRect.top - newRect.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;

    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    el.getBoundingClientRect();
    requestAnimationFrame(() => {
      el.style.transition = 'transform 380ms cubic-bezier(.2,.8,.2,1)';
      el.style.transform = '';
    });
    el.addEventListener(
      'transitionend',
      () => { el.style.transition = ''; },
      { once: true }
    );
  });
}

function renderAll() {
  const oldRects = captureTaskRects();
  boardEl.innerHTML = '';
  const columns = getChildren('root').filter((n) => n.properties?.type === 'column');
  for (const col of columns) {
    boardEl.appendChild(renderColumn(col));
  }
  if (state.activeDrags.size > 0) syncDragDom();
  playTaskTransitions(oldRects);
  for (const [ownerId, drag] of state.activeDrags) {
    const node = state.nodes.get(drag.nodeId);
    if (node) ensureDragGhost(ownerId, node);
    if (drag.follow && draggingNodeId === drag.nodeId) {
      positionGhostAtPointer(ownerId, lastPointer.x, lastPointer.y);
    } else if (drag.bx != null && drag.by != null) {
      const point = boardRatioToClient(drag.bx, drag.by);
      setGhostPosition(ownerId, point.x - drag.grabOffsetX, point.y - drag.grabOffsetY, { immediate: true });
    } else {
      const gap = boardEl.querySelector(`.drop-placeholder[data-for="${ownerId}"]`);
      if (gap) {
        const rect = gap.getBoundingClientRect();
        setGhostPosition(ownerId, rect.left, rect.top, { immediate: true });
      }
    }
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
    localDropSucceeded = false;
    lastDragHoverKey = null;
    lastDragHoverSentAt = 0;
    pendingDragHover = null;
    if (pendingDragHoverTimer) {
      clearTimeout(pendingDragHoverTimer);
      pendingDragHoverTimer = null;
    }

    const rect = el.getBoundingClientRect();
    const grabOffsetX = e.clientX - rect.left;
    const grabOffsetY = e.clientY - rect.top;
    lastPointer = { x: e.clientX, y: e.clientY };

    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
    // ブラウザ標準のドラッグ画像を消し、共通ゴーストだけを見せる
    e.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMAGE, 0, 0);

    beginDrag(state.clientId, task.id, {
      follow: true,
      grabOffsetX,
      grabOffsetY,
      clientX: e.clientX,
      clientY: e.clientY,
    });
    send({ type: 'drag-start', nodeId: task.id, ox: grabOffsetX, oy: grabOffsetY });
  });

  el.addEventListener('dragend', () => {
    if (pendingDragHoverTimer) {
      clearTimeout(pendingDragHoverTimer);
      pendingDragHoverTimer = null;
    }
    flushDragHover();

    const nodeId = draggingNodeId;
    if (nodeId) send({ type: 'drag-end', nodeId });

    draggingNodeId = null;
    lastDragHoverKey = null;
    pendingDragHover = null;

    if (localDropSucceeded) {
      // 確定は reparent/move の受信で confirm → FLIP 着地。ゴーストは即消し。
      const drag = state.activeDrags.get(state.clientId);
      if (drag) drag.confirmed = true;
      clearDrag(state.clientId);
    } else {
      // キャンセル: 本人画面でも元位置へ戻してから消す
      returnGhostThenClear(state.clientId);
    }
    localDropSucceeded = false;
  });

  return el;
}

// ---- カーソル位置の同期 ----
// 通常時は mousemove。HTML5 DnD 中は mousemove が止まるため、
// dragover ハンドラ側でも cursor-move を送っている。

let lastCursorSent = 0;
boardWrapEl.addEventListener('mousemove', (e) => {
  if (draggingNodeId) return;
  const now = performance.now();
  if (now - lastCursorSent > 40) {
    lastCursorSent = now;
    sendCursorAt(e.clientX, e.clientY);
  }
});
boardWrapEl.addEventListener('mouseleave', () => {
  if (!draggingNodeId) send({ type: 'cursor-leave' });
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

connect();
