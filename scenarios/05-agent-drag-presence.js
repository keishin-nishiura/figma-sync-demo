// シナリオ5: Agent Workspace のドラッグ中プレゼンス
//
// Documentには触れず、drag-start / drag-hover / drag-end が
// cursor-move と同じく broadcastExcept で中継されることを確認する。
//
// (a) クライアントAが drag-start → drag-hover → drag-end を送ると、
//     同じルームのBにだけ fromClientId 付きで届く(別ルームには届かない)
// (b) AIへの指示で drag-start → drag-hover → reparent/move → drag-end の順に流れる
// (c) ドラッグ中にクライアントが切断しても、他クライアントに drag-end が届く

import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function startServerOnPort(port) {
  const proc = spawn('node', [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), AI_MODE: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(proc), 800);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.stderr?.on('data', () => {});
  });
}

class AgentWs {
  constructor(name, url) {
    this.name = name;
    this.url = url;
    this.ws = null;
    this.clientId = null;
    this.messages = [];
    this._waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', () => {});
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        this.messages.push(msg);
        if (msg.type === 'init') {
          this.clientId = msg.clientId;
          resolve();
        }
        const still = [];
        for (const w of this._waiters) {
          if (w.predict(msg)) w.resolve(msg);
          else still.push(w);
        }
        this._waiters = still;
      });
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(predict, timeoutMs = 5000) {
    const cached = this.messages.find(predict);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`[${this.name}] waitFor timed out`));
      }, timeoutMs);
      this._waiters.push({
        predict,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  }

  clear() {
    this.messages = [];
  }

  close() {
    this.ws?.close();
  }
}

function assert(cond, detail) {
  if (!cond) throw new Error(detail);
}

console.log('=== シナリオ5: Agent Workspace のドラッグ中プレゼンス ===\n');

const port = await getFreePort();
const server = await startServerOnPort(port);
const agentUrl = `ws://127.0.0.1:${port}/ws-agent`;
const paintUrl = `ws://127.0.0.1:${port}/ws-paint`;

let failed = false;
try {
  // ---- (a) 同じルームへ中継、別ルームには届かない ----
  console.log('--- (a) drag-start/hover/end のルーム内中継 ---');
  const a = new AgentWs('A', agentUrl);
  const b = new AgentWs('B', agentUrl);
  const paint = new AgentWs('paint', paintUrl);
  await Promise.all([a.connect(), b.connect(), paint.connect()]);
  await sleep(100);
  b.clear();
  paint.clear();

  a.send({ type: 'drag-start', nodeId: 'task-1' });
  const start = await b.waitFor((m) => m.type === 'drag-start' && m.nodeId === 'task-1');
  assert(start.fromClientId === a.clientId, `fromClientId mismatch: ${start.fromClientId}`);
  console.log(`  B が drag-start を受信 (fromClientId=${start.fromClientId})`);

  a.send({ type: 'drag-hover', nodeId: 'task-1', columnId: 'col-done', beforeId: null });
  const hover = await b.waitFor((m) => m.type === 'drag-hover' && m.columnId === 'col-done');
  assert(hover.fromClientId === a.clientId, 'drag-hover fromClientId mismatch');
  assert(hover.beforeId === null, 'drag-hover beforeId should be null');
  console.log('  B が drag-hover を受信');

  a.send({ type: 'drag-end', nodeId: 'task-1' });
  const end = await b.waitFor((m) => m.type === 'drag-end');
  assert(end.fromClientId === a.clientId, 'drag-end fromClientId mismatch');
  console.log('  B が drag-end を受信');

  await sleep(200);
  const leaked = paint.messages.filter((m) => m.type?.startsWith('drag-'));
  assert(leaked.length === 0, `paintルームへdragメッセージが漏れた: ${JSON.stringify(leaked)}`);
  console.log('  別ルーム(paint)には届いていない');

  // 存在しない nodeId は無視される
  b.clear();
  a.send({ type: 'drag-start', nodeId: 'no-such-node' });
  await sleep(200);
  assert(!b.messages.some((m) => m.type === 'drag-start'), '存在しないnodeIdのdrag-startが中継された');
  console.log('  存在しない nodeId は無視される');

  paint.close();

  // ---- (b) AI指示で drag → 確定 → drag-end の順 ----
  console.log('\n--- (b) AI移動時のイベント順序 ---');
  b.clear();
  a.send({ type: 'ai-instruction', text: '「デモを実装する」を完了にして' });

  const dragStart = await b.waitFor((m) => m.type === 'drag-start' && m.fromClientId === 'ai-agent', 10000);
  console.log(`  drag-start (nodeId=${dragStart.nodeId})`);
  const dragHover = await b.waitFor(
    (m) => m.type === 'drag-hover' && m.fromClientId === 'ai-agent' && m.columnId === 'col-done',
    10000
  );
  console.log(`  drag-hover (columnId=${dragHover.columnId})`);
  const applied = await b.waitFor(
    (m) =>
      (m.type === 'reparent-applied' || m.type === 'node-moved') &&
      m.fromClientId === 'ai-agent' &&
      m.nodeId === dragStart.nodeId,
    10000
  );
  console.log(`  ${applied.type} (確定)`);
  const dragEnd = await b.waitFor(
    (m) => m.type === 'drag-end' && m.fromClientId === 'ai-agent' && m.nodeId === dragStart.nodeId,
    10000
  );
  console.log(`  drag-end (nodeId=${dragEnd.nodeId})`);

  const iStart = b.messages.indexOf(dragStart);
  const iHover = b.messages.indexOf(dragHover);
  const iApplied = b.messages.indexOf(applied);
  const iEnd = b.messages.indexOf(dragEnd);
  assert(iStart < iHover && iHover < iApplied && iApplied < iEnd,
    `順序不正: start=${iStart} hover=${iHover} applied=${iApplied} end=${iEnd}`);
  console.log('  順序: drag-start → drag-hover → 確定 → drag-end');

  // ---- (c) 切断時に drag-end が流れる ----
  console.log('\n--- (c) ドラッグ中切断でゴーストが残らない ---');
  // デモデータを戻してから切断テスト
  a.send({ type: 'seed-demo-data' });
  await b.waitFor((m) => m.type === 'board-reset', 5000);
  await sleep(100);

  const c = new AgentWs('C', agentUrl);
  await c.connect();
  await sleep(100);
  b.clear();

  c.send({ type: 'drag-start', nodeId: 'task-1' });
  await b.waitFor((m) => m.type === 'drag-start' && m.fromClientId === c.clientId);
  c.send({ type: 'drag-hover', nodeId: 'task-1', columnId: 'col-doing', beforeId: null });
  await b.waitFor((m) => m.type === 'drag-hover' && m.fromClientId === c.clientId);

  c.close();
  const endOnClose = await b.waitFor(
    (m) => m.type === 'drag-end' && m.fromClientId === c.clientId,
    5000
  );
  assert(endOnClose.nodeId === 'task-1', '切断時drag-endのnodeIdが不一致');
  console.log(`  切断後に drag-end を受信 (nodeId=${endOnClose.nodeId})`);
  await b.waitFor((m) => m.type === 'client-left' && m.clientId === c.clientId, 5000);
  console.log('  client-left も受信');

  a.close();
  b.close();
  console.log('\nすべて成功');
} catch (err) {
  failed = true;
  console.error('\n失敗:', err.message);
} finally {
  server.kill();
  process.exit(failed ? 1 : 0);
}
