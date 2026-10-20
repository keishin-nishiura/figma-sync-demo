// Agent Workspace (Kanban) のクライアント実装。
// 既存の client/public/app.js と同じ考え方(WebSocket + 確定を待って再描画)を、
// Human+AIの共同編集ボード用に実装したもの。
// AIはサーバー側で人間と全く同じメッセージ型(node-created/property-updated/
// reparent-applied/node-moved/node-deleted)をブロードキャストしてくるため、
// クライアント側はfromClientIdがAIかどうかを気にせず同じ描画パスで処理できる。
//
// ドラッグ中の「運んでいる途中」描写は Document ではなくプレゼンス
// (drag-start / drag-hover / drag-end)として扱い、サーバーは中継するだけ。

const AI_CLIENT_ID = 'ai-agent';
const AI_COLOR = '#f97316';
const COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#eab308', '#a855f7', '#ec4899'];
const DRAG_HOVER_MIN_INTERVAL_MS = 50;
const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  // fromClientId -> { nodeId, columnId, beforeId }
  // beforeId = 挿入位置の直後のカードID(末尾なら null)。Documentのmove-node.beforeIdとは別意味。
  remoteDrags: new Map(),
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
      state.remoteDrags.clear();
      state.selectedNodeId = null;
      clearAllDragGhosts();
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
      // 確定が先に届いた場合はゴーストを消し、FLIPの着地に任せる
      clearRemoteDragForNode(msg.nodeId, msg.fromClientId);
      renderAll();
      break;
    }
    case 'node-moved': {
      const node = state.nodes.get(msg.nodeId);
      if (!node) break;
      node.order = msg.order;
      clearRemoteDragForNode(msg.nodeId, msg.fromClientId);
      renderAll();
      break;
    }
    case 'node-deleted': {
      state.nodes.delete(msg.nodeId);
      state.remoteNodeSelections.forEach((nodeId, clientId) => {
        if (nodeId === msg.nodeId) state.remoteNodeSelections.delete(clientId);
      });
      for (const [clientId, drag] of [...state.remoteDrags]) {
        if (drag.nodeId === msg.nodeId) endRemoteDrag(clientId);
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
      beginRemoteDrag(msg.fromClientId, msg.nodeId);
      break;
    }
    case 'drag-hover': {
      if (msg.fromClientId === state.clientId) break;
      if (!state.nodes.has(msg.nodeId)) break;
      updateRemoteDragHover(msg.fromClientId, msg.nodeId, msg.columnId, msg.beforeId ?? null);
      break;
    }
    case 'drag-end': {
      if (msg.fromClientId === state.clientId) break;
      endRemoteDrag(msg.fromClientId);
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
      endRemoteDrag(msg.clientId);
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
  aiCursorEl.style.display = 'flex';
  aiCursorEl.style.left = `${rect.left + rect.width / 2 - 7}px`;
  aiCursorEl.style.top = `${rect.top - 24}px`;
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

// ---- ドラッグ&ドロップ (タスクの列移動・並び替え) ----
// HTML5 Drag and Drop APIを使用。ドラッグ中は「挿入位置」を示す
// プレースホルダーをDOM上に差し込み、ドロップ時にそのプレースホルダーの
// 前後にいるノードのidから beforeId/afterId を算出して move-node を送る。
// 列をまたぐ場合は reparent を先に送り、続けて同じ beforeId/afterId で
// move-node を送って位置を確定させる(サーバーは同一コネクションからの
// メッセージを受信順に処理するため、この2通のメッセージは順序通り適用される)。
//
// 加えて、他クライアント向けに drag-start / drag-hover / drag-end を
// プレゼンスとして送り、「運んでいる途中」を共有する。HTML5 DnD中は
// mousemove が発火しないため、dragover 内で cursor-move も送る。

let draggingNodeId = null;
let lastDragHoverKey = null;
let lastDragHoverSentAt = 0;
const placeholder = document.createElement('div');
placeholder.className = 'drop-placeholder';

function computeDropPosition(columnBodyEl, clientY, excludeNodeId) {
  const skipId = excludeNodeId ?? draggingNodeId;
  const taskEls = [...columnBodyEl.querySelectorAll('.task')].filter((el) => el.dataset.nodeId !== skipId);
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

function sendCursorAt(clientX, clientY) {
  send({ type: 'cursor-move', x: Math.round(clientX), y: Math.round(clientY) });
}

function maybeSendDragHover(columnId, insertBeforeId) {
  const key = `${draggingNodeId}|${columnId}|${insertBeforeId ?? ''}`;
  if (key === lastDragHoverKey) return; // 挿入位置が変わっていない
  const now = performance.now();
  if (now - lastDragHoverSentAt < DRAG_HOVER_MIN_INTERVAL_MS) return; // 最大でも約50msに1回
  lastDragHoverKey = key;
  lastDragHoverSentAt = now;
  send({
    type: 'drag-hover',
    nodeId: draggingNodeId,
    columnId,
    beforeId: insertBeforeId,
  });
}

function attachColumnDropZone(bodyEl, columnId) {
  bodyEl.addEventListener('dragover', (e) => {
    if (!draggingNodeId) return;
    e.preventDefault();
    bodyEl.classList.add('drag-over');
    const { afterEl, afterId } = computeDropPosition(bodyEl, e.clientY);
    if (afterEl) bodyEl.insertBefore(placeholder, afterEl);
    else bodyEl.appendChild(placeholder);
    // プレゼンス: 挿入位置の直後カードID(= afterId)を beforeId として送る
    maybeSendDragHover(columnId, afterId);
    // HTML5 DnD中は mousemove が来ないので、ここでカーソルも更新する
    sendCursorAt(e.clientX, e.clientY);
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

// ---- リモートドラッグ描画 (プレゼンス) ----

function clearRemoteDragForNode(nodeId, fromClientId) {
  if (fromClientId && state.remoteDrags.has(fromClientId)) {
    const drag = state.remoteDrags.get(fromClientId);
    if (drag.nodeId === nodeId) endRemoteDrag(fromClientId);
    return;
  }
  for (const [clientId, drag] of [...state.remoteDrags]) {
    if (drag.nodeId === nodeId) endRemoteDrag(clientId);
  }
}

function beginRemoteDrag(fromClientId, nodeId) {
  const node = state.nodes.get(nodeId);
  if (!node) return;
  state.remoteDrags.set(fromClientId, {
    nodeId,
    columnId: node.parentId,
    beforeId: null,
    started: true,
  });
  ensureDragGhost(fromClientId, node);
  applyRemoteDragVisuals();
}

function updateRemoteDragHover(fromClientId, nodeId, columnId, beforeId) {
  let drag = state.remoteDrags.get(fromClientId);
  if (!drag) {
    beginRemoteDrag(fromClientId, nodeId);
    drag = state.remoteDrags.get(fromClientId);
  }
  if (!drag) return;
  drag.nodeId = nodeId;
  drag.columnId = columnId;
  drag.beforeId = beforeId;
  applyRemoteDragVisuals();
  positionDragGhost(fromClientId);
}

function endRemoteDrag(fromClientId) {
  if (!state.remoteDrags.has(fromClientId)) return;
  state.remoteDrags.delete(fromClientId);
  removeDragGhost(fromClientId);
  applyRemoteDragVisuals();
}

function clearAllDragGhosts() {
  dragGhostLayer.innerHTML = '';
}

function ensureDragGhost(fromClientId, node) {
  let ghost = dragGhostLayer.querySelector(`[data-ghost-for="${fromClientId}"]`);
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.dataset.ghostFor = fromClientId;
    dragGhostLayer.appendChild(ghost);
  }
  const color = colorForClient(fromClientId);
  ghost.style.borderColor = color;
  ghost.style.boxShadow = `0 12px 28px rgba(0,0,0,.45), 0 0 0 2px ${color}`;
  if (prefersReducedMotion()) ghost.style.transition = 'none';
  ghost.innerHTML = '';
  const badge = document.createElement('div');
  badge.className = 'ghost-badge';
  badge.style.background = color;
  badge.textContent = displayNameForClient(fromClientId);
  const title = document.createElement('div');
  title.className = 'task-title';
  title.textContent = (node.properties.priority === 'high' ? '⭐ ' : '') + (node.properties.title ?? node.id);
  ghost.append(badge, title);

  const sourceEl = boardEl.querySelector(`.task[data-node-id="${node.id}"]`);
  if (sourceEl) {
    const rect = sourceEl.getBoundingClientRect();
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${rect.width}px`;
  }
}

function removeDragGhost(fromClientId) {
  const ghost = dragGhostLayer.querySelector(`[data-ghost-for="${fromClientId}"]`);
  if (ghost) ghost.remove();
}

function positionDragGhost(fromClientId) {
  const drag = state.remoteDrags.get(fromClientId);
  const ghost = dragGhostLayer.querySelector(`[data-ghost-for="${fromClientId}"]`);
  if (!drag || !ghost) return;

  const gap = boardEl.querySelector(`.drop-placeholder.remote[data-for="${fromClientId}"]`);
  const targetEl = gap
    || boardEl.querySelector(`.column-body[data-column-id="${drag.columnId}"]`)
    || boardEl.querySelector(`.task[data-node-id="${drag.nodeId}"]`);
  if (!targetEl) return;
  const rect = targetEl.getBoundingClientRect();
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  if (rect.width > 40) ghost.style.width = `${rect.width}px`;

  if (fromClientId === AI_CLIENT_ID) {
    moveAiCursorToPoint(rect.left + rect.width / 2 - 7, rect.top - 24);
  }
}

function syncRemoteDragDom() {
  // 既存のリモート用プレースホルダーとソース装飾を一旦外す
  boardEl.querySelectorAll('.drop-placeholder.remote').forEach((el) => el.remove());
  boardEl.querySelectorAll('.task.remote-drag-source').forEach((el) => {
    el.classList.remove('remote-drag-source');
    const label = el.querySelector('.remote-drag-label');
    if (label) label.remove();
  });

  for (const [fromClientId, drag] of state.remoteDrags) {
    const sourceEl = boardEl.querySelector(`.task[data-node-id="${drag.nodeId}"]`);
    if (sourceEl) {
      sourceEl.classList.add('remote-drag-source');
      if (!sourceEl.querySelector('.remote-drag-label')) {
        const label = document.createElement('div');
        label.className = 'remote-drag-label';
        label.textContent = `${displayNameForClient(fromClientId)}が移動中`;
        sourceEl.appendChild(label);
      }
    }

    const bodyEl = boardEl.querySelector(`.column-body[data-column-id="${drag.columnId}"]`);
    if (!bodyEl) continue;
    const gap = document.createElement('div');
    gap.className = 'drop-placeholder remote';
    gap.dataset.for = fromClientId;

    // beforeId = 挿入位置の直後のカード。それがソース自身なら無視して末尾扱い。
    const afterEl = drag.beforeId && drag.beforeId !== drag.nodeId
      ? bodyEl.querySelector(`.task[data-node-id="${drag.beforeId}"]`)
      : null;
    if (afterEl) bodyEl.insertBefore(gap, afterEl);
    else bodyEl.appendChild(gap);

    // 空列のヒントは隙間があるときは隠す
    const empty = bodyEl.querySelector('.column-empty');
    if (empty) empty.style.display = 'none';
  }
}

function applyRemoteDragVisuals() {
  const oldRects = captureTaskRects();
  syncRemoteDragDom();
  playTaskTransitions(oldRects);
  for (const fromClientId of state.remoteDrags.keys()) {
    positionDragGhost(fromClientId);
  }
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
      // 新規に現れたタスク: フェード + 拡大しながら登場させる
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
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return; // 位置が変わっていなければ何もしない

    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    el.getBoundingClientRect(); // 強制リフローで上の指定を確定させてからトランジションに戻す
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
  // ギャップ挿入後にまとめてFLIPし、再描画でリモートドラッグ描写が消えないようにする
  if (state.remoteDrags.size > 0) syncRemoteDragDom();
  playTaskTransitions(oldRects);
  for (const fromClientId of state.remoteDrags.keys()) {
    const drag = state.remoteDrags.get(fromClientId);
    const node = drag && state.nodes.get(drag.nodeId);
    if (node) ensureDragGhost(fromClientId, node);
    positionDragGhost(fromClientId);
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
    lastDragHoverKey = null;
    lastDragHoverSentAt = 0;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
    send({ type: 'drag-start', nodeId: task.id });
  });
  el.addEventListener('dragend', () => {
    if (draggingNodeId) {
      send({ type: 'drag-end', nodeId: draggingNodeId });
    }
    draggingNodeId = null;
    lastDragHoverKey = null;
    el.classList.remove('dragging');
    clearDragVisuals();
  });

  return el;
}

// ---- カーソル位置の同期 ----
// 通常時は mousemove。HTML5 DnD 中は mousemove が止まるため、
// 列の dragover ハンドラ側でも cursor-move を送っている。

let lastCursorSent = 0;
boardWrapEl.addEventListener('mousemove', (e) => {
  if (draggingNodeId) return; // dragover 側に任せる
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
