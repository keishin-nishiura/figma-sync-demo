// ブラウザ側のクライアント実装。
// Node.js版の client/DemoClient.js と同じ考え方 (楽観的更新 + pendingOpsによる
// 確定/巻き戻し判定) を、実際に目で見て動かせるUIとして再現したもの。

const COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#eab308', '#a855f7', '#ec4899'];

const state = {
  clientId: null,
  nodes: new Map(), // id -> node
  pending: new Map(), // opId -> 巻き戻し用の情報
  opCounter: 0,
  remoteCursors: new Map(), // fromClientId -> { x, y, color }
  remoteSelections: new Map(), // fromClientId -> { x, y, w, h, color }
};

function colorForClient(id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

const canvas = document.getElementById('canvas');
const linksSvg = document.getElementById('links');
const layersList = document.getElementById('layers-list');
const logList = document.getElementById('log-list');
const statusEl = document.getElementById('status');
const cursorLayer = document.getElementById('cursor-layer');
const selectionLayer = document.getElementById('selection-layer');
const canvasWrap = document.getElementById('canvas-wrap');

function nextOpId() {
  state.opCounter += 1;
  return `${state.clientId ?? 'client'}-${state.opCounter}`;
}

function log(kind, text) {
  const line = document.createElement('div');
  line.className = `log-line ${kind}`;
  const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  line.textContent = `[${time}] ${text}`;
  logList.prepend(line);
  while (logList.children.length > 200) logList.removeChild(logList.lastChild);
}

function getChildren(parentId) {
  return [...state.nodes.values()]
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
}

// candidateId が nodeId の子孫かどうか (UI側の簡易チェック。最終判定は必ずサーバー側で行う)
function isDescendant(candidateId, nodeId) {
  let current = state.nodes.get(candidateId);
  while (current && current.parentId != null) {
    if (current.parentId === nodeId) return true;
    current = state.nodes.get(current.parentId);
  }
  return false;
}

let ws;
function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.addEventListener('open', () => { statusEl.textContent = '接続済み'; });
  ws.addEventListener('close', () => { statusEl.textContent = '切断されました'; });
  ws.addEventListener('message', (ev) => handleMessage(JSON.parse(ev.data)));
}

function send(msg) {
  ws.send(JSON.stringify(msg));
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'init': {
      state.clientId = msg.clientId;
      for (const node of msg.document) state.nodes.set(node.id, structuredClone(node));
      statusEl.textContent = `接続済み (${msg.clientId})`;
      log('confirm', `接続完了 clientId=${msg.clientId}`);
      renderAll();
      break;
    }
    case 'property-updated': {
      const node = state.nodes.get(msg.nodeId);
      if (!node) break;
      const wasPending = state.pending.has(msg.opId);
      node.properties[msg.key] = msg.value;
      state.pending.delete(msg.opId);
      if (wasPending) {
        log('confirm', `確定(再描画なし): ${msg.nodeId}.${msg.key}`);
      } else {
        log('remote', `受信: ${msg.nodeId}.${msg.key} = ${JSON.stringify(msg.value)} (from ${msg.fromClientId})`);
        renderAll();
      }
      break;
    }
    case 'reparent-applied': {
      const node = state.nodes.get(msg.nodeId);
      if (!node) break;
      const wasPending = state.pending.has(msg.opId);
      node.parentId = msg.newParentId;
      node.order = msg.order;
      state.pending.delete(msg.opId);
      log(wasPending ? 'confirm' : 'remote', `${wasPending ? '確定' : '受信'}: ${msg.nodeId} の親 -> ${msg.newParentId}`);
      renderAll();
      break;
    }
    case 'reparent-rejected': {
      const pending = state.pending.get(msg.opId);
      state.pending.delete(msg.opId);
      if (pending) {
        const node = state.nodes.get(msg.nodeId);
        if (node) {
          node.parentId = pending.previousParentId;
          node.order = pending.previousOrder;
        }
        log('reject', `拒否(循環参照)→巻き戻し: ${msg.nodeId} の親を ${pending.previousParentId} に戻しました`);
        flashRejected(msg.nodeId);
        renderAll();
      }
      break;
    }
    case 'node-moved': {
      const node = state.nodes.get(msg.nodeId);
      if (!node) break;
      const wasPending = state.pending.has(msg.opId);
      node.order = msg.order;
      state.pending.delete(msg.opId);
      log(wasPending ? 'confirm' : 'remote', `${wasPending ? '確定' : '受信'}: ${msg.nodeId} の順序 -> ${msg.order}`);
      renderLayers();
      break;
    }
    case 'node-created': {
      state.nodes.set(msg.node.id, structuredClone(msg.node));
      state.pending.delete(msg.opId);
      log('confirm', `ノード追加: ${msg.node.id}`);
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
    case 'selection-update': {
      const color = colorForClient(msg.fromClientId);
      state.remoteSelections.set(msg.fromClientId, { x: msg.x, y: msg.y, w: msg.w, h: msg.h, color });
      renderSelections();
      break;
    }
    case 'selection-end': {
      state.remoteSelections.delete(msg.fromClientId);
      renderSelections();
      break;
    }
    case 'client-left': {
      state.remoteCursors.delete(msg.clientId);
      state.remoteSelections.delete(msg.clientId);
      renderCursors();
      renderSelections();
      break;
    }
    default:
      break;
  }
}

function flashRejected(nodeId) {
  const el = document.querySelector(`[data-node-id="${nodeId}"]`);
  if (!el) return;
  el.classList.add('rejected');
  setTimeout(() => el.classList.remove('rejected'), 320);
}

// ---- 操作 (すべて楽観的更新: ローカルに即時反映してから送信する) ----

function updateProperty(nodeId, key, value) {
  const node = state.nodes.get(nodeId);
  if (!node) return;
  const opId = nextOpId();
  node.properties[key] = value;
  state.pending.set(opId, { type: 'update-property' });
  log('opt', `楽観的に適用: ${nodeId}.${key} = ${JSON.stringify(value)}`);
  send({ type: 'update-property', nodeId, key, value, opId });
}

function reparent(nodeId, newParentId) {
  const node = state.nodes.get(nodeId);
  if (!node || node.parentId === newParentId) return;
  if (nodeId === newParentId || isDescendant(newParentId, nodeId)) {
    log('reject', `循環参照になるため送信前に取消: ${nodeId} -> ${newParentId}`);
    flashRejected(nodeId);
    return;
  }
  const opId = nextOpId();
  state.pending.set(opId, { type: 'reparent', previousParentId: node.parentId, previousOrder: node.order });
  node.parentId = newParentId;
  log('opt', `楽観的に適用: ${nodeId} の親 -> ${newParentId}`);
  send({ type: 'reparent', nodeId, newParentId, opId });
  renderAll();
}

function moveNode(nodeId, beforeId, afterId) {
  const opId = nextOpId();
  state.pending.set(opId, { type: 'move-node' });
  send({ type: 'move-node', nodeId, beforeId, afterId, opId });
}

function createNode() {
  const id = 'N' + Math.random().toString(36).slice(2, 6);
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const x = Math.round(40 + Math.random() * 400);
  const y = Math.round(40 + Math.random() * 240);
  const opId = nextOpId();
  state.pending.set(opId, { type: 'create-node' });
  send({ type: 'create-node', nodeId: id, parentId: 'root', properties: { name: id, color, x, y }, opId });
}

// ---- 描画 ----

function renderAll() {
  renderCanvas();
  renderLayers();
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

function renderSelections() {
  selectionLayer.innerHTML = '';
  for (const sel of state.remoteSelections.values()) {
    const el = document.createElement('div');
    el.className = 'selection-box remote';
    el.style.left = `${sel.x}px`;
    el.style.top = `${sel.y}px`;
    el.style.width = `${sel.w}px`;
    el.style.height = `${sel.h}px`;
    el.style.color = sel.color;
    selectionLayer.appendChild(el);
  }
  renderOwnSelectionBox();
}

let ownSelectionRect = null;
function renderOwnSelectionBox() {
  const existing = document.getElementById('own-selection-box');
  if (existing) existing.remove();
  if (!ownSelectionRect) return;
  const el = document.createElement('div');
  el.id = 'own-selection-box';
  el.className = 'selection-box own';
  el.style.left = `${ownSelectionRect.x}px`;
  el.style.top = `${ownSelectionRect.y}px`;
  el.style.width = `${ownSelectionRect.w}px`;
  el.style.height = `${ownSelectionRect.h}px`;
  selectionLayer.appendChild(el);
}

function renderCanvas() {
  canvas.innerHTML = '';
  const allNodes = [...state.nodes.values()].filter((n) => n.id !== 'root');
  for (const node of allNodes) {
    const el = document.createElement('div');
    el.className = 'node';
    el.dataset.nodeId = node.id;
    el.style.left = `${node.properties.x ?? 0}px`;
    el.style.top = `${node.properties.y ?? 0}px`;
    el.style.background = node.properties.color ?? '#666';
    el.innerHTML = `<div>${node.properties.name ?? node.id}</div><small>parent: ${node.parentId}</small>`;
    el.addEventListener('mousedown', (e) => startDrag(e, node.id));
    el.addEventListener('dblclick', () => {
      const current = node.properties.color;
      const idx = COLORS.indexOf(current);
      const next = COLORS[(idx + 1 + COLORS.length) % COLORS.length];
      updateProperty(node.id, 'color', next);
    });
    canvas.appendChild(el);
  }
  drawLinks(allNodes);
}

function drawLinks(allNodes) {
  linksSvg.innerHTML = '';
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  linksSvg.setAttribute('width', w);
  linksSvg.setAttribute('height', h);
  for (const node of allNodes) {
    if (node.parentId === 'root' || node.parentId == null) continue;
    const parent = state.nodes.get(node.parentId);
    if (!parent) continue;
    const x1 = (node.properties.x ?? 0) + 60;
    const y1 = (node.properties.y ?? 0) + 35;
    const x2 = (parent.properties.x ?? 0) + 60;
    const y2 = (parent.properties.y ?? 0) + 35;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    line.setAttribute('stroke', '#888');
    line.setAttribute('stroke-width', '2');
    linksSvg.appendChild(line);
  }
}

function renderLayers() {
  layersList.innerHTML = '';
  const children = getChildren('root');
  children.forEach((node, idx) => {
    const row = document.createElement('div');
    row.className = 'layer-row';

    const swatch = document.createElement('div');
    swatch.className = 'swatch';
    swatch.style.background = node.properties.color ?? '#666';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${node.properties.name ?? node.id} (order=${node.order})`;

    const up = document.createElement('button');
    up.textContent = '↑';
    up.disabled = idx === 0;
    up.onclick = () => {
      const before = children[idx - 2]?.id ?? null;
      const after = children[idx - 1].id;
      moveNode(node.id, before, after);
    };

    const down = document.createElement('button');
    down.textContent = '↓';
    down.disabled = idx === children.length - 1;
    down.onclick = () => {
      const before = children[idx + 1].id;
      const after = children[idx + 2]?.id ?? null;
      moveNode(node.id, before, after);
    };

    const parentSelect = document.createElement('select');
    const options = [
      { id: 'root', properties: { name: 'root' } },
      ...[...state.nodes.values()].filter((n) => n.id !== 'root' && n.id !== node.id),
    ];
    for (const opt of options) {
      const optionEl = document.createElement('option');
      optionEl.value = opt.id;
      optionEl.textContent = `親: ${opt.properties?.name ?? opt.id}`;
      optionEl.selected = node.parentId === opt.id;
      parentSelect.appendChild(optionEl);
    }
    parentSelect.onchange = () => reparent(node.id, parentSelect.value);

    row.append(swatch, name, parentSelect, up, down);
    layersList.appendChild(row);
  });

  const nested = [...state.nodes.values()].filter((n) => n.id !== 'root' && n.parentId !== 'root');
  for (const node of nested) {
    const row = document.createElement('div');
    row.className = 'layer-row nested';
    row.textContent = `↳ ${node.properties.name ?? node.id} は ${node.parentId} の子`;
    layersList.appendChild(row);
  }
}

// ---- ドラッグ操作 (楽観的更新の核心部分) ----

let dragState = null;
let lastSent = 0;

function startDrag(e, nodeId) {
  e.preventDefault();
  e.stopPropagation();
  const node = state.nodes.get(nodeId);
  const rect = canvas.getBoundingClientRect();
  dragState = {
    nodeId,
    offsetX: e.clientX - rect.left - (node.properties.x ?? 0),
    offsetY: e.clientY - rect.top - (node.properties.y ?? 0),
  };
  document.querySelector(`[data-node-id="${nodeId}"]`)?.classList.add('dragging');
  window.addEventListener('mousemove', onDrag);
  window.addEventListener('mouseup', endDrag);
}

function onDrag(e) {
  if (!dragState) return;
  const node = state.nodes.get(dragState.nodeId);
  const rect = canvas.getBoundingClientRect();
  const x = Math.round(e.clientX - rect.left - dragState.offsetX);
  const y = Math.round(e.clientY - rect.top - dragState.offsetY);
  node.properties.x = x;
  node.properties.y = y;
  renderCanvas(); // ローカルには毎フレーム即時反映 (楽観的更新)

  const now = performance.now();
  if (now - lastSent > 40) {
    lastSent = now;
    sendPositionUpdate(dragState.nodeId, x, y);
  }
}

function sendPositionUpdate(nodeId, x, y) {
  const opIdX = nextOpId();
  state.pending.set(opIdX, { type: 'update-property' });
  send({ type: 'update-property', nodeId, key: 'x', value: x, opId: opIdX });
  const opIdY = nextOpId();
  state.pending.set(opIdY, { type: 'update-property' });
  send({ type: 'update-property', nodeId, key: 'y', value: y, opId: opIdY });
}

function endDrag(e) {
  if (!dragState) return;
  const nodeId = dragState.nodeId;
  const node = state.nodes.get(nodeId);
  sendPositionUpdate(nodeId, node.properties.x, node.properties.y);

  const target = document.elementFromPoint(e.clientX, e.clientY);
  const targetEl = target?.closest('.node');
  if (targetEl && targetEl.dataset.nodeId !== nodeId) {
    reparent(nodeId, targetEl.dataset.nodeId);
  }

  document.querySelector(`[data-node-id="${nodeId}"]`)?.classList.remove('dragging');
  window.removeEventListener('mousemove', onDrag);
  window.removeEventListener('mouseup', endDrag);
  dragState = null;
}

document.getElementById('add-node').addEventListener('click', createNode);

// ---- カーソル位置の同期 (Figmaのマルチプレイヤーカーソルの再現) ----

let lastCursorSent = 0;
canvasWrap.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
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

// ---- 範囲選択 (マーキー選択) の同期 ----

let marqueeState = null;
let lastSelectionSent = 0;

canvas.addEventListener('mousedown', (e) => {
  if (e.target !== canvas) return; // ノードの上でのmousedownはstartDrag側で処理する
  const rect = canvas.getBoundingClientRect();
  marqueeState = { startX: e.clientX - rect.left, startY: e.clientY - rect.top };
  window.addEventListener('mousemove', onMarqueeMove);
  window.addEventListener('mouseup', onMarqueeEnd);
});

function onMarqueeMove(e) {
  if (!marqueeState) return;
  const rect = canvas.getBoundingClientRect();
  const curX = e.clientX - rect.left;
  const curY = e.clientY - rect.top;
  const x = Math.min(marqueeState.startX, curX);
  const y = Math.min(marqueeState.startY, curY);
  const w = Math.abs(curX - marqueeState.startX);
  const h = Math.abs(curY - marqueeState.startY);
  ownSelectionRect = { x, y, w, h };
  renderOwnSelectionBox();

  const now = performance.now();
  if (now - lastSelectionSent > 40) {
    lastSelectionSent = now;
    send({ type: 'selection-update', x, y, w, h });
  }
}

function onMarqueeEnd() {
  if (!marqueeState) return;
  marqueeState = null;
  ownSelectionRect = null;
  renderOwnSelectionBox();
  send({ type: 'selection-end' });
  window.removeEventListener('mousemove', onMarqueeMove);
  window.removeEventListener('mouseup', onMarqueeEnd);
}

connect();
