// シナリオ1: LWW によるプロパティ同期
//
// 2つのクライアントがほぼ同時に同じノードの同じプロパティを書き換えたとき、
// サーバーに後から届いた更新がそのまま採用され、両クライアントとも
// 最終的に同じ値へ収束することを確認する。

import { startServer, sleep } from '../shared/startServer.js';
import { DemoClient } from '../client/DemoClient.js';

console.log('=== シナリオ1: LWW によるプロパティ同期 ===\n');

const server = await startServer();

const client1 = new DemoClient('client1');
const client2 = new DemoClient('client2');
await client1.connect();
await client2.connect();
await sleep(300);

console.log('\n--- client1 と client2 がほぼ同時に A の color を書き換える ---\n');

client1.updateProperty('A', 'color', '#00ff00'); // 緑
client2.updateProperty('A', 'color', '#ff00ff'); // マゼンタ

await sleep(500);

console.log('\n--- 最終結果 (両クライアントとも同じ値に収束しているはず) ---');
console.log('client1 の A.color =', client1.nodes.get('A').properties.color);
console.log('client2 の A.color =', client2.nodes.get('A').properties.color);
console.log('\n※ サーバーに後から届いた更新が最終的に反映されます (Last-Writer-Wins)');

client1.close();
client2.close();
server.kill();
process.exit(0);
