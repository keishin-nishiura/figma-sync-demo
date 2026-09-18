# figma-sync-demo

Figmaの同時編集の仕組みを、Node.js + WebSocketの最小構成で再現し、
動かしながら検証するためのリポジトリです。

対応するQiita記事:
「Figmaの同時編集、なめらかすぎない？Notion・スプレッドシートとの動画比較から、
Figmaの仕組みを調べてみた」の実装編（近日公開）

## 再現している4つの仕組み

Figma公式ブログ（[How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)）
で説明されている以下の4つを、それぞれ独立したシナリオスクリプトとして実装しています。

| # | 仕組み | 実装 | 確認スクリプト |
|---|---|---|---|
| 1 | LWW (Last-Writer-Wins) によるプロパティ同期 | `server/document.js` の `applyPropertyUpdate` | `npm run scenario:lww` |
| 2 | 楽観的更新と flickering 防止 | `client/DemoClient.js` の pendingOps による確定判定 | `npm run scenario:optimistic` |
| 3 | reparent と循環参照の一時的な発生・解消 | `server/document.js` の `reparent` / `isAncestor` | `npm run scenario:reparent` |
| 4 | Fractional Indexing による兄弟順序管理 | `shared/fractionalIndex.js` | `npm run scenario:fractional-index` |

## セットアップ

```bash
npm install
```

## ブラウザでUIを見ながら確認する (推奨)

`npm run server` でサーバーを起動し、ブラウザで `http://localhost:8080` を
**2つのタブ (または2つのウィンドウ) で開く** と、Figmaのように実際にドラッグ・
色変更・親子関係の変更をしながら、もう片方の画面にリアルタイムで反映される様子を
確認できます。

```bash
npm run server
# ブラウザで http://localhost:8080 を2つのタブで開く
```

- ノードをドラッグして動かす → 楽観的更新とflickering防止(もう片方のタブにもスムーズに反映される)
- ノードをダブルクリックして色を変える → LWW(2つのタブでほぼ同時に同じノードの色を変えると、後着の変更に収束する)
- サイドバーの「親」プルダウンを変更する、またはノードを別のノードの上にドロップする → reparent(2つのタブで同時に逆方向のreparentを行うと、片方が循環参照として拒否され、赤く光って巻き戻る)
- サイドバーの ↑↓ ボタンで並び替える → Fractional Indexingによる順序管理
- カーソルを動かす / 何もない場所をドラッグする → マルチプレイヤーカーソルと範囲選択の同期(Figmaでよく見る、他人のカーソルが動いているアレ)

画面右側にはイベントログが流れ、「楽観的に適用」「確定(再描画なし)」「受信して反映」
「拒否(循環参照)→巻き戻し」といったログで、裏側で何が起きているかも同時に確認できます。

## 動かし方

各シナリオはサーバーの起動からクライアントの接続・操作・終了まで
1本のスクリプトで完結しています。個別に実行できます。

```bash
npm run scenario:lww                # LWWによるプロパティ同期
npm run scenario:optimistic         # 楽観的更新とflickering防止
npm run scenario:reparent           # reparentと循環参照の解消
npm run scenario:fractional-index   # Fractional Indexingによる順序管理
```

サーバーを単独で立てて、自分で `client/DemoClient.js` を使った
スクリプトを書いて試したい場合は以下で起動できます。

```bash
npm run server
```

## 構成

```
server/         WebSocket/HTTPサーバーとドキュメントモデル (1ドキュメント=1サーバープロセス)
client/         クライアント側の楽観的更新・確定処理を持つ DemoClient (Node.js用)
client/public/  ブラウザで動くUI (index.html / app.js)。DemoClientと同じロジックをブラウザ向けに実装
shared/         Fractional Indexingの実装、サーバー起動ヘルパー
scenarios/      4つの仕組みをそれぞれ確認できるシナリオスクリプト
```

## 注意事項

これは記事解説用の最小構成デモであり、認証・永続化・スケーラビリティ等は
考慮していません。Figma公式ブログで説明されている2019年時点の設計をベースに、
概念を理解しやすい形に単純化しています。実際のFigmaの内部実装とは異なる場合があります。
