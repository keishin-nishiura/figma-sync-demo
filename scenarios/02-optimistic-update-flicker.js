// シナリオ2: 楽観的更新と flickering 防止
//
// クライアントは操作した瞬間にローカルへ即時反映する (楽観的更新)。
// その後サーバーから同じ内容の確定通知が返ってきても、値はすでに
// 画面に出ているため「再描画しない」。これが Figma のなめらかさの
// 正体の一つで、もし確定通知のたびに毎回再描画していたら
// 一瞬値が巻き戻ってから正しい値に戻る「チラつき (flickering)」が起きる。

import { startServer, sleep } from '../shared/startServer.js';
import { DemoClient } from '../client/DemoClient.js';

console.log('=== シナリオ2: 楽観的更新と flickering 防止 ===\n');

const server = await startServer();
const client1 = new DemoClient('client1');
await client1.connect();
await sleep(300);

console.log('\n--- client1 が B の x 座標を動かす ---');
console.log('(「楽観的に適用」の時点ですでに画面には反映済み。');
console.log(' その後サーバーから同じ値が返ってきても「確定 (再描画なし)」となり、チラつきが起きない)\n');

client1.updateProperty('B', 'x', 250);

await sleep(500);

client1.close();
server.kill();
process.exit(0);
