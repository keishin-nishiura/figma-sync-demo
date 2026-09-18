// シナリオ3: reparent と循環参照の一時的な発生・解消
//
// Figma記事9章の図解と同じ状況を再現する。
// client1: 「A を B の子に」
// client2: 「B を A の子に」
// をほぼ同時に送ると、サーバーには先に届いた片方だけが受理され、
// 後から届いた方は循環参照を作ってしまうため拒否される。
// 拒否された側のクライアントは、楽観的に適用していた変更を巻き戻す。

import { startServer, sleep } from '../shared/startServer.js';
import { DemoClient } from '../client/DemoClient.js';

console.log('=== シナリオ3: reparent と循環参照の一時的な発生・解消 ===\n');

const server = await startServer();
const client1 = new DemoClient('client1');
const client2 = new DemoClient('client2');
await client1.connect();
await client2.connect();
await sleep(300);

console.log('\n--- client1: A を B の子に / client2: B を A の子に (ほぼ同時) ---\n');

client1.reparent('A', 'B');
client2.reparent('B', 'A');

await sleep(500);

console.log('\n--- 最終結果 ---');
console.log('client1 から見た A.parentId =', client1.nodes.get('A').parentId);
console.log('client1 から見た B.parentId =', client1.nodes.get('B').parentId);
console.log('client2 から見た A.parentId =', client2.nodes.get('A').parentId);
console.log('client2 から見た B.parentId =', client2.nodes.get('B').parentId);
console.log('\n※ 先にサーバーに届いた変更が受理され、後着で循環を作る変更は拒否・巻き戻されます');

client1.close();
client2.close();
server.kill();
process.exit(0);
