// 1ドキュメント = 1サーバープロセスというFigmaの前提を再現した
// 最小構成のWebSocketサーバー。
//
// ポイント: サーバーに届いたメッセージを「届いた順」に処理してブロードキャストするだけ。
// これが Figma記事で説明されている「サーバー到着順を利用したLWW」の正体で、
// タイムスタンプの比較や競合解決の特別なロジックは一切書いていない。

import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { Document } from './document.js';

const PORT = process.env.PORT || 8080;
const doc = new Document();

// デモ用に初期ノードを2つ用意 (A, B) しておく
doc.createNode('A', 'root', { name: 'A', color: '#3b82f6', x: 0, y: 0 });
doc.createNode('B', 'root', { name: 'B', color: '#ef4444', x: 100, y: 0 });

const wss = new WebSocketServer({ port: PORT });

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) {
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
          console.log(
            `[server] ${clientId} -> update-property ${msg.nodeId}.${msg.key} = ${JSON.stringify(msg.value)}`
          );
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
          console.log(`[server] ${clientId} -> move-node ${msg.nodeId} order=${node.order}`);
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

      default:
        console.log(`[server] unknown message type: ${msg.type}`);
    }
  });

  ws.on('close', () => {
    console.log(`[server] client disconnected: ${clientId}`);
  });
});

console.log(`[server] listening on ws://localhost:${PORT}`);
