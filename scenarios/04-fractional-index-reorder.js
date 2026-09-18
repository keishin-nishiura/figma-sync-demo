// シナリオ4: Fractional Indexing による兄弟順序の管理
//
// 兄弟要素の並び替えや、要素と要素の「間」への新規挿入を、
// 全体を書き換えることなく、挿入したい2要素の順序キーの
// 中間値を計算するだけで実現できることを確認する。

import { startServer, sleep } from '../shared/startServer.js';
import { DemoClient } from '../client/DemoClient.js';

console.log('=== シナリオ4: Fractional Indexing による兄弟順序の管理 ===\n');

const server = await startServer();
const client1 = new DemoClient('client1');
await client1.connect();
await sleep(300);

function printOrder(label) {
  const children = client1.getChildren('root');
  console.log(label, children.map((n) => `${n.id}(order=${n.order})`).join(', '));
}

printOrder('初期状態:');

console.log('\n--- B を A より前に移動する ---');
client1.moveNode('B', null, 'A'); // 先頭 〜 A の間に挿入
await sleep(300);
printOrder('移動後:');

console.log('\n--- さらに B と A の間に新しいノード C を挿入する ---');
client1.createNode('C', 'root', { name: 'C', color: '#22c55e' });
await sleep(300);
client1.moveNode('C', 'B', 'A');
await sleep(300);
printOrder('C挿入後:');

console.log('\n※ 挿入のたびに桁が伸びるだけで、いつでも間に新しい要素を差し込める (精度は枯渇しない)');

client1.close();
server.kill();
process.exit(0);
