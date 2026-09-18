# figma-sync-demo

Figmaの同時編集の仕組み（LWWによるプロパティ同期、楽観的更新とflickering防止、
循環参照の一時的な許容と解消、Fractional Indexingによる兄弟順序管理）を
Node.js + WebSocketで最小構成として再現し、動かしながら検証するためのリポジトリです。

Qiita記事の実装編（近日公開）に対応します。
