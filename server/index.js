import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document } from './document.js';
import { createLLMProvider } from '../ai/LLMProvider.js';
import { AuctionMockLLMProvider } from '../ai/AuctionMockLLMProvider.js';
import { PaintMockLLMProvider } from '../ai/PaintMockLLMProvider.js';
import { runAgentInstruction, AI_CLIENT_ID } from '../ai/AgentRunner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'client', 'public');
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const httpServer = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- ルーム(ワークスペース) --------------------------------------------
// 元々のcanvasデモに加えて、「Human+AIが同じ操作パイプラインを共有する」という
// アイデアを別の題材でも試した3つのおまけルームを用意している。
// いずれも server/document.js の同じ Document クラスと、既存の
// update-property/reparent/move-node/create-node/delete-node/select-node/
// cursor-move といった既存メッセージ型をそのまま使い回しており、
// ルーム固有の特別な同期ロジックはどこにも追加していない。
//
//   canvas  : 元々のFigma同期デモ(このファイルの本編)。無変更。
//   agent   : Kanban風のAI協働ワークスペース。
//   auction : 複数人+AIが同じ商品に入札するデモ。bidプロパティをLWWで
//             丸ごと上書きするだけで、金額の大小チェックは意図的にしていない。
//   paint   : マス目=ノード、色=プロパティのピクセルキャンバス。
//             セルの操作は既存のupdate-property/select-node/cursor-moveの
//             使い回しだけで成立している。

const AI_DISPLAY_NAME = 'AIエージェント';
const AI_COLOR = '#f97316';

function seedCanvas(doc) {
  doc.createNode('A', 'root', { name: 'A', color: '#3b82f6', x: 40, y: 40 });
  doc.createNode('B', 'root', { name: 'B', color: '#ef4444', x: 220, y: 40 });
}

function seedAgentBoard(doc) {
  const columns = [
    { id: 'col-todo', name: 'To Do', color: '#64748b' },
    { id: 'col-doing', name: 'In Progress', color: '#eab308' },
    { id: 'col-done', name: 'Done', color: '#22c55e' },
  ];
  for (const col of columns) {
    doc.createNode(col.id, 'root', { type: 'column', name: col.name, color: col.color });
  }
  doc.createNode('task-1', 'col-todo', { type: 'task', title: '記事の構成を決める' });
  doc.createNode('task-2', 'col-todo', { type: 'task', title: 'デモを実装する' });
  doc.createNode('task-3', 'col-doing', { type: 'task', title: 'READMEを書く' });
}

function seedAuction(doc) {
  const items = [
    { id: 'item-1', name: 'アンティーク時計', startBid: 1000 },
    { id: 'item-2', name: '限定スニーカー', startBid: 3000 },
    { id: 'item-3', name: '手作り陶器', startBid: 500 },
  ];
  for (const it of items) {
    doc.createNode(it.id, 'root', {
      type: 'item',
      name: it.name,
      startBid: it.startBid,
      bid: { amount: it.startBid, bidder: null, at: null },
    });
  }
}

const PAINT_GRID_SIZE = 14;
function seedPaint(doc) {
  for (let row = 0; row < PAINT_GRID_SIZE; row++) {
    for (let col = 0; col < PAINT_GRID_SIZE; col++) {
      doc.createNode(`p-${row}-${col}`, 'root', { type: 'cell', row, col, color: '#2a2a2a' });
    }
  }
}

function resetDocInPlace(doc) {
  doc.nodes.clear();
  doc.nodes.set(doc.rootId, { id: doc.rootId, parentId: null, order: null, properties: { name: 'Root' } });
}

function createRoom(name, seedFn) {
  const doc = new Document();
  seedFn(doc);
  return {
    name,
    doc,
    seedFn,
    clients: new Map(), // ws -> { clientId }
    aiStatus: 'idle',
  };
}

const rooms = {
  canvas: createRoom('canvas', seedCanvas),
  agent: createRoom('agent', seedAgentBoard),
  auction: createRoom('auction', seedAuction),
  paint: createRoom('paint', seedPaint),
};

// AI_MODE=mock (デフォルト、APIキー不要) / AI_MODE=live (要ANTHROPIC_API_KEY) はKanbanのみ。
// おまけの2ルームは題材が単純なので、専用の決定的なモックのみを提供している。
const kanbanProvider = await createLLMProvider();
const aiProviders = {
  agent: kanbanProvider,
  auction: new AuctionMockLLMProvider(),
  paint: new PaintMockLLMProvider(),
};

const ROOM_PATH_PREFIXES = {
  '/ws-agent': 'agent',
  '/ws-auction': 'auction',
  '/ws-paint': 'paint',
};

function roomForRequest(req) {
  const url = new URL(req.url, 'http://localhost');
  for (const [prefix, roomName] of Object.entries(ROOM_PATH_PREFIXES)) {
    if (url.pathname.startsWith(prefix)) return rooms[roomName];
  }
  return rooms.canvas;
}

function broadcast(room, message) {
  const payload = JSON.stringify(message);
  for (const ws of room.clients.keys()) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function broadcastExcept(room, message, exceptWs) {
  const payload = JSON.stringify(message);
  for (const ws of room.clients.keys()) {
    if (ws.readyState === ws.OPEN && ws !== exceptWs) ws.send(payload);
  }
}

function sendTo(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function hasAi(room) {
  return room !== rooms.canvas;
}

function presenceList(room) {
  const list = [...room.clients.values()].map((c) => ({ clientId: c.clientId }));
  if (hasAi(room)) {
    list.push({ clientId: AI_CLIENT_ID, displayName: AI_DISPLAY_NAME, color: AI_COLOR, isAi: true, status: room.aiStatus });
  }
  return list;
}

function logActivity(room, entry) {
  broadcast(room, { type: 'activity', ...entry, at: Date.now() });
}

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const room = roomForRequest(req);
  const clientId = randomUUID().slice(0, 8);
  room.clients.set(ws, { clientId });
  console.log(`[server] client connected: ${clientId} (room=${room.name})`);

  sendTo(ws, {
    type: 'init',
    clientId,
    document: room.doc.toJSON(),
    presence: presenceList(room),
    aiStatus: room.aiStatus,
  });

  if (hasAi(room)) {
    broadcastExcept(room, { type: 'client-joined', clientId }, ws);
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'update-property': {
        const node = room.doc.applyPropertyUpdate(msg.nodeId, msg.key, msg.value);
        if (node) {
          broadcast(room, { type: 'property-updated', nodeId: msg.nodeId, key: msg.key, value: msg.value, opId: msg.opId, fromClientId: clientId });
          if (hasAi(room)) logActivity(room, { actor: clientId, action: 'update-property', detail: `${msg.nodeId} の ${msg.key} を更新しました` });
        }
        break;
      }
      case 'reparent': {
        const node = room.doc.reparent(msg.nodeId, msg.newParentId);
        if (node) {
          broadcast(room, { type: 'reparent-applied', nodeId: msg.nodeId, newParentId: msg.newParentId, order: node.order, opId: msg.opId, fromClientId: clientId });
          if (hasAi(room)) logActivity(room, { actor: clientId, action: 'reparent', detail: `${msg.nodeId} を移動しました` });
        } else {
          sendTo(ws, { type: 'reparent-rejected', nodeId: msg.nodeId, newParentId: msg.newParentId, opId: msg.opId, reason: 'cycle' });
        }
        break;
      }
      case 'move-node': {
        const node = room.doc.moveNode(msg.nodeId, msg.beforeId, msg.afterId);
        if (node) {
          broadcast(room, { type: 'node-moved', nodeId: msg.nodeId, order: node.order, opId: msg.opId, fromClientId: clientId });
          if (hasAi(room)) logActivity(room, { actor: clientId, action: 'move-node', detail: `${msg.nodeId} を並び替えました` });
        }
        break;
      }
      case 'create-node': {
        const node = room.doc.createNode(msg.nodeId, msg.parentId, msg.properties);
        broadcast(room, { type: 'node-created', node, opId: msg.opId, fromClientId: clientId });
        if (hasAi(room)) logActivity(room, { actor: clientId, action: 'create-node', detail: `新しいタスク「${node.properties?.title ?? node.id}」を作成しました` });
        break;
      }
      case 'delete-node': {
        const existed = room.doc.nodes.has(msg.nodeId);
        const ok = existed && room.doc.deleteNode(msg.nodeId);
        if (ok) {
          broadcast(room, { type: 'node-deleted', nodeId: msg.nodeId, opId: msg.opId, fromClientId: clientId });
          if (hasAi(room)) logActivity(room, { actor: clientId, action: 'delete-node', detail: `${msg.nodeId} を削除しました` });
        }
        break;
      }
      case 'cursor-move': {
        broadcastExcept(room, { type: 'cursor-move', x: msg.x, y: msg.y, fromClientId: clientId }, ws);
        break;
      }
      case 'cursor-leave': {
        broadcastExcept(room, { type: 'cursor-leave', fromClientId: clientId }, ws);
        break;
      }
      case 'selection-update': {
        broadcastExcept(room, { type: 'selection-update', x: msg.x, y: msg.y, w: msg.w, h: msg.h, fromClientId: clientId }, ws);
        break;
      }
      case 'selection-end': {
        broadcastExcept(room, { type: 'selection-end', fromClientId: clientId }, ws);
        break;
      }
      case 'select-node': {
        broadcastExcept(room, { type: 'select-node', nodeId: msg.nodeId, fromClientId: clientId }, ws);
        break;
      }
      case 'deselect-node': {
        broadcastExcept(room, { type: 'deselect-node', fromClientId: clientId }, ws);
        break;
      }

      // ---- AI付きルーム共通 ----
      case 'seed-demo-data': {
        if (!hasAi(room)) break;
        resetDocInPlace(room.doc);
        room.seedFn(room.doc);
        broadcast(room, { type: 'board-reset', document: room.doc.toJSON() });
        logActivity(room, { actor: clientId, action: 'seed-demo-data', detail: 'デモデータを再投入しました' });
        break;
      }
      case 'ai-instruction': {
        if (!hasAi(room)) break;
        const provider = aiProviders[room.name];
        if (!provider) break;
        const text = String(msg.text || '').slice(0, 500).trim();
        if (!text) break;
        logActivity(room, { actor: clientId, action: 'ai-instruction', detail: `AIへ指示: 「${text}」` });
        runAgentInstruction({ room, instruction: text, provider, broadcast, logActivity }).catch((err) => {
          console.error('[server] agent run failed:', err);
          room.aiStatus = 'idle';
          broadcast(room, { type: 'ai-status', status: 'idle' });
        });
        break;
      }

      default:
        console.log(`[server] unknown message type: ${msg.type}`);
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    console.log(`[server] client disconnected: ${clientId} (room=${room.name})`);
    broadcast(room, { type: 'client-left', clientId });
  });
});

httpServer.listen(PORT, () => {
  console.log(`[server] http/ws listening on http://localhost:${PORT}`);
  console.log(`[server] canvas demo:        http://localhost:${PORT}/`);
  console.log(`[server] agent workspace:    http://localhost:${PORT}/agent.html`);
  console.log(`[server] auction demo:       http://localhost:${PORT}/auction.html`);
  console.log(`[server] paint canvas demo:  http://localhost:${PORT}/paint.html`);
});
