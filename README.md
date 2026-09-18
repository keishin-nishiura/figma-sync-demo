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
server/     WebSocketサーバーとドキュメントモデル (1ドキュメント=1サーバープロセス)
client/     クライアント側の楽観的更新・確定処理を持つ DemoClient
shared/     Fractional Indexingの実装、サーバー起動ヘルパー
scenarios/  4つの仕組みをそれぞれ確認できるシナリオスクリプト
```

## 注意事項

これは記事解説用の最小構成デモであり、認証・永続化・スケーラビリティ等は
考慮していません。Figma公式ブログで説明されている2019年時点の設計をベースに、
概念を理解しやすい形に単純化しています。実際のFigmaの内部実装とは異なる場合があります。
