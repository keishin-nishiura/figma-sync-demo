// クライアント側の最小実装。
//
// ポイントは2つ:
// 1. 操作した瞬間にローカルの状態を即時反映する (楽観的更新)
// 2. サーバーからの確定通知が「自分が出した操作の確定」であれば、
//    値は既に画面に出ているので再描画しない (flickering防止)
//    「他人からの操作」であれば、ここで初めて反映する

import WebSocket from 'ws';

export class DemoClient {
  constructor(name, url = 'ws://localhost:8080') {
    this.name = name;
    this.url = url;
    this.ws = null;
    this.clientId = null;
    this.nodes = new Map(); // ローカルに保持している楽観的な状態
    this.pendingOps = new Map(); // opId -> 確定待ちの情報 (巻き戻し用のデータを含む)
    this._opCounter = 0;
    this._readyResolve = null;
  }

  log(...args) {
    console.log(`[${this.name}]`, ...args);
  }

  connect() {
    return new Promise((resolve) => {
      this.ws = new WebSocket(this.url);
      this._readyResolve = resolve;
      this.ws.on('message', (raw) => this._handleMessage(JSON.parse(raw.toString())));
    });
  }

  nextOpId() {
    this._opCounter += 1;
    return `${this.name}-${this._opCounter}`;
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'init': {
        this.clientId = msg.clientId;
        for (const node of msg.document) {
          this.nodes.set(node.id, structuredClone(node));
        }
        this.log(`接続完了 (clientId=${this.clientId})`);
        this._readyResolve?.();
        break;
      }

      case 'property-updated': {
        const node = this.nodes.get(msg.nodeId);
        if (!node) break;
        const wasPending = this.pendingOps.has(msg.opId);
        node.properties[msg.key] = msg.value;
        this.pendingOps.delete(msg.opId);
        if (wasPending) {
          this.log(`確定 (再描画なし): ${msg.nodeId}.${msg.key} = ${JSON.stringify(msg.value)}`);
        } else {
          this.log(
            `受信して反映: ${msg.nodeId}.${msg.key} = ${JSON.stringify(msg.value)} (from ${msg.fromClientId})`
          );
        }
        break;
      }

      case 'reparent-applied': {
        const node = this.nodes.get(msg.nodeId);
        if (!node) break;
        const wasPending = this.pendingOps.has(msg.opId);
        node.parentId = msg.newParentId;
        node.order = msg.order;
        this.pendingOps.delete(msg.opId);
        this.log(
          `${wasPending ? '確定 (再描画なし)' : '受信して反映'}: ${msg.nodeId} の親 -> ${msg.newParentId}`
        );
        break;
      }

      case 'reparent-rejected': {
        const pending = this.pendingOps.get(msg.opId);
        this.pendingOps.delete(msg.opId);
        if (pending) {
          // 楽観的に適用していた変更を取り消して元に戻す (巻き戻り)
          const node = this.nodes.get(msg.nodeId);
          if (node) {
            node.parentId = pending.previousParentId;
            node.order = pending.previousOrder;
          }
          this.log(
            `拒否 (循環参照) → 巻き戻し: ${msg.nodeId} の親を ${pending.previousParentId} に戻しました`
          );
        }
        break;
      }

      case 'node-moved': {
        const node = this.nodes.get(msg.nodeId);
        if (!node) break;
        const wasPending = this.pendingOps.has(msg.opId);
        node.order = msg.order;
        this.pendingOps.delete(msg.opId);
        this.log(
          `${wasPending ? '確定 (再描画なし)' : '受信して反映'}: ${msg.nodeId} の順序 -> ${msg.order}`
        );
        break;
      }

      case 'node-created': {
        const wasPending = this.pendingOps.has(msg.opId);
        this.pendingOps.delete(msg.opId);
        this.nodes.set(msg.node.id, structuredClone(msg.node));
        this.log(`${wasPending ? '確定' : '受信して反映'}: ノード ${msg.node.id} を作成`);
        break;
      }

      default:
        break;
    }
  }

  // 楽観的更新: ローカルに即時反映してから送信する
  updateProperty(nodeId, key, value) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const opId = this.nextOpId();
    node.properties[key] = value; // 即時反映
    this.pendingOps.set(opId, { type: 'update-property' });
    this.log(`楽観的に適用: ${nodeId}.${key} = ${JSON.stringify(value)}`);
    this.ws.send(JSON.stringify({ type: 'update-property', nodeId, key, value, opId }));
  }

  reparent(nodeId, newParentId) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const opId = this.nextOpId();
    this.pendingOps.set(opId, {
      type: 'reparent',
      previousParentId: node.parentId,
      previousOrder: node.order,
    });
    node.parentId = newParentId; // 即時反映 (楽観的更新)
    this.log(`楽観的に適用: ${nodeId} の親 -> ${newParentId}`);
    this.ws.send(JSON.stringify({ type: 'reparent', nodeId, newParentId, opId }));
  }

  moveNode(nodeId, beforeId, afterId) {
    const opId = this.nextOpId();
    this.pendingOps.set(opId, { type: 'move-node' });
    this.ws.send(JSON.stringify({ type: 'move-node', nodeId, beforeId, afterId, opId }));
  }

  createNode(nodeId, parentId, properties = {}) {
    const opId = this.nextOpId();
    this.pendingOps.set(opId, { type: 'create-node' });
    this.ws.send(JSON.stringify({ type: 'create-node', nodeId, parentId, properties, opId }));
  }

  getChildren(parentId) {
    return [...this.nodes.values()]
      .filter((n) => n.parentId === parentId)
      .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  }

  close() {
    this.ws.close();
  }
}
