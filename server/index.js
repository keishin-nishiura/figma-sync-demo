import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document } from './document.js';
import { createLLMProvider } from '../ai/LLMProvider.js';
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
// 既存のcanvasデモ(index.html)と、新しいAI Agent Workspace(agent.html)は、
// それぞれ独立したDocumentインスタンスとクライアント集合を持つ「ルーム」として
// 管理する。既存のUIはこれまで通り `/` に接続して 'canvas' ルームへ、
// 新しいUIは `/ws-agent` に接続して 'agent' ルームへ割り当てられる。
// canvasルームのメッセージ処理・ブロードキャスト対象・挙動は一切変更していない。

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
    clients: new Map(), // ws -> { clientId }
    aiStatus: 'idle',
  };
}

const rooms = {
  canvas: createRoom('canvas', seedCanvas),
  agent: createRoom('agent', seedAgentBoard),
};

function roomForRequest(req) {
  const url = new URL(req.url, 'http://localhost');
  return url.pathname.startsWith('/ws-agent') ? rooms.agent : rooms.canvas;
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

function presenceList(room) {
  const list = [...room.clients.values()].map((c) => ({ clientId: c.clientId }));
  if (room === rooms.agent) {
    list.push({ clientId: AI_CLIENT_ID, displayName: AI_DISPLAY_NAME, color: AI_COLOR, isAi: true, status: room.aiStatus });
  }
  return list;
}

function logActivity(room, entry) {
  broadcast(room, { type: 'activity', ...entry, at: Date.now() });
}

// AI_MODE=mock (デフォルト、APIキー不要) / AI_MODE=live (要ANTHROPIC_API_KEY)
const aiProvider = await createLLMProvider();

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

  if (room === rooms.agent) {
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
          if (room === rooms.agent) logActivity(room, { actor: clientId, action: 'update-property', detail: `${msg.nodeId} の ${msg.key} を更新しました` });
        }
        break;
      }
      case 'reparent': {
        const node = room.doc.reparent(msg.nodeId, msg.newParentId);
        if (node) {
          broadcast(room, { type: 'reparent-applied', nodeId: msg.nodeId, newParentId: msg.newParentId, order: node.order, opId: msg.opId, fromClientId: clientId });
          if (room === rooms.agent) logActivity(room, { actor: clientId, action: 'reparent', detail: `${msg.nodeId} を移動しました` });
        } else {
          sendTo(ws, { type: 'reparent-rejected', nodeId: msg.nodeId, newParentId: msg.newParentId, opId: msg.opId, reason: 'cycle' });
        }
        break;
      }
      case 'move-node': {
        const node = room.doc.moveNode(msg.nodeId, msg.beforeId, msg.afterId);
        if (node) {
          broadcast(room, { type: 'node-moved', nodeId: msg.nodeId, order: node.order, opId: msg.opId, fromClientId: clientId });
          if (room === rooms.agent) logActivity(room, { actor: clientId, action: 'move-node', detail: `${msg.nodeId} を並び替えました` });
        }
        break;
      }
      case 'create-node': {
        const node = room.doc.createNode(msg.nodeId, msg.parentId, msg.properties);
        broadcast(room, { type: 'node-created', node, opId: msg.opId, fromClientId: clientId });
        if (room === rooms.agent) logActivity(room, { actor: clientId, action: 'create-node', detail: `新しいタスク「${node.properties?.title ?? node.id}」を作成しました` });
        break;
      }
      case 'delete-node': {
        const existed = room.doc.nodes.has(msg.nodeId);
        const ok = existed && room.doc.deleteNode(msg.nodeId);
        if (ok) {
          broadcast(room, { type: 'node-deleted', nodeId: msg.nodeId, opId: msg.opId, fromClientId: clientId });
          if (room === rooms.agent) logActivity(room, { actor: clientId, action: 'delete-node', detail: `${msg.nodeId} を削除しました` });
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

      // ---- Agent Workspace 専用 ----
      case 'seed-demo-data': {
        if (room !== rooms.agent) break;
        resetDocInPlace(room.doc);
        seedAgentBoard(room.doc);
        broadcast(room, { type: 'board-reset', document: room.doc.toJSON() });
        logActivity(room, { actor: clientId, action: 'seed-demo-data', detail: 'デモデータを再投入しました' });
        break;
      }
      case 'ai-instruction': {
        if (room !== rooms.agent) break;
        const text = String(msg.text || '').slice(0, 500).trim();
        if (!text) break;
        logActivity(room, { actor: clientId, action: 'ai-instruction', detail: `AIへ指示: 「${text}」` });
        runAgentInstruction({ room, instruction: text, provider: aiProvider, broadcast, logActivity }).catch((err) => {
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
});
