// 1ドキュメント = 1サーバープロセスというFigmaの前提を再現した
// 最小構成のサーバー。静的ファイル配信 (ブラウザUI) と WebSocket を
// 同じHTTPサーバー・同じポートで提供する。
//
// ポイント: サーバーに届いたメッセージを「届いた順」に処理してブロードキャストするだけ。
// これが Figma記事で説明されている「サーバー到着順を利用したLWW」の正体で、
// タイムスタンプの比較や競合解決の特別なロジックは一切書いていない。

import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document } from './document.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'client', 'public');
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const httpServer = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
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

const doc = new Document();

// デモ用に初期ノードを2つ用意 (A, B) しておく
doc.createNode('A', 'root', { name: 'A', color: '#3b82f6', x: 40, y: 40 });
doc.createNode('B', 'root', { name: 'B', color: '#ef4444', x: 220, y: 40 });

const wss = new WebSocketServer({ server: httpServer });

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

// カーソル位置や選択範囲は「ドキュメントの状態」ではなく一時的なプレゼンス情報なので、
// Documentには保存せず、他のクライアントへそのまま中継するだけでよい。
function broadcastExcept(message, exceptWs) {
  const payload = JSON.stringify(message);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN && ws !== exceptWs) {
      ws.send(payload);
    }
  }
}

function sendTo(ws, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

wss.on('connection', (ws) => {
  const clientId = randomUUID().slice(0, 8);
  console.log(`[server] client connected: ${clientId}`);

  sendTo(ws, { type: 'init', clientId, document: doc.toJSON() });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // ここでの処理順序 = サーバーに届いた順序。これがそのまま
    // 全クライアントに共有される「正解」の順序になる。
    switch (msg.type) {
      case 'update-property': {
        const node = doc.applyPropertyUpdate(msg.nodeId, msg.key, msg.value);
        if (node) {
          broadcast({
            type: 'property-updated',
            nodeId: msg.nodeId,
            key: msg.key,
            value: msg.value,
            opId: msg.opId,
            fromClientId: clientId,
          });
        }
        break;
      }

      case 'reparent': {
        const node = doc.reparent(msg.nodeId, msg.newParentId);
        if (node) {
          console.log(`[server] ${clientId} -> reparent ${msg.nodeId} -> ${msg.newParentId} (受理)`);
          broadcast({
            type: 'reparent-applied',
            nodeId: msg.nodeId,
            newParentId: msg.newParentId,
            order: node.order,
            opId: msg.opId,
            fromClientId: clientId,
          });
        } else {
          console.log(
            `[server] ${clientId} -> reparent ${msg.nodeId} -> ${msg.newParentId} (循環参照のため拒否)`
          );
          sendTo(ws, {
            type: 'reparent-rejected',
            nodeId: msg.nodeId,
            newParentId: msg.newParentId,
            opId: msg.opId,
            reason: 'cycle',
          });
        }
        break;
      }

      case 'move-node': {
        const node = doc.moveNode(msg.nodeId, msg.beforeId, msg.afterId);
        if (node) {
          broadcast({
            type: 'node-moved',
            nodeId: msg.nodeId,
            order: node.order,
            opId: msg.opId,
            fromClientId: clientId,
          });
        }
        break;
      }

      case 'create-node': {
        const node = doc.createNode(msg.nodeId, msg.parentId, msg.properties);
        console.log(`[server] ${clientId} -> create-node ${msg.nodeId}`);
        broadcast({ type: 'node-created', node, opId: msg.opId, fromClientId: clientId });
        break;
      }

      case 'cursor-move': {
        broadcastExcept({ type: 'cursor-move', x: msg.x, y: msg.y, fromClientId: clientId }, ws);
        break;
      }

      case 'cursor-leave': {
        broadcastExcept({ type: 'cursor-leave', fromClientId: clientId }, ws);
        break;
      }

      case 'selection-update': {
        broadcastExcept(
          { type: 'selection-update', x: msg.x, y: msg.y, w: msg.w, h: msg.h, fromClientId: clientId },
          ws
        );
        break;
      }

      case 'selection-end': {
        broadcastExcept({ type: 'selection-end', fromClientId: clientId }, ws);
        break;
      }

      case 'select-node': {
        // ドキュメントの状態(nodes)には保存しない。あくまで一時的なプレゼンス情報として中継するだけ。
        broadcastExcept({ type: 'select-node', nodeId: msg.nodeId, fromClientId: clientId }, ws);
        break;
      }

      case 'deselect-node': {
        broadcastExcept({ type: 'deselect-node', fromClientId: clientId }, ws);
        break;
      }

      default:
        console.log(`[server] unknown message type: ${msg.type}`);
    }
  });

  ws.on('close', () => {
    console.log(`[server] client disconnected: ${clientId}`);
    // カーソル/選択範囲を出しっぱなしのまま消えないよう、離脱を全員に知らせる
    broadcast({ type: 'client-left', clientId });
  });
});

httpServer.listen(PORT, () => {
  console.log(`[server] http/ws listening on http://localhost:${PORT}`);
});
