# ICHIGOガチャガチャ オンライン参加(Vercel版)

`online/index.html` + `bridge/server.js`の`/online-*`系エンドポイントのうち、
**オンライン参加(ウォレット接続→AI交渉→ICHIGO送金→記念画像受け取り)だけ**を、
Renderの常時稼働サーバー無しで動くようVercelのサーバーレス関数に移植したもの。

現地(ESP32と通信する実機ガチャガチャ)側は一切変更しておらず、今まで通り
`bridge/server.js`をRenderで動かし続けてよい。この`online-vercel/`は完全に独立した
別デプロイなので、ICHIGO MARTの「受講生マーケット」に出品するリンク先として
このデプロイのURLを使う想定。

## bridge/server.jsとの違い(サーバーレス化にあたっての設計変更)

- **状態保存をメモリのMapからRedis(Upstash)に変更**。Vercelのサーバーレス関数は
  リクエストごとに別インスタンスで動きうり、メモリを共有できないため。
- **TTL(有効期限)任せに簡素化**。元のコードにあった「一定時間ごとに古いセッションを
  掃除する(sweepStale*)」処理が不要になった(Redisのキーが自動的に消える=セッションが
  無い、として扱うだけでよい)。
- **同時実行の排他制御をRedisの`SET NX`ロックに変更**。元は単一Node.jsプロセスの
  同期処理(awaitを挟まない)で成立していたが、サーバーレスは本当に並行実行されうるため。
- **購入履歴(recentPurchases)は実装していない**。オンライン版のレシートは元々
  ブラウザのlocalStorageのみで完結しており、サーバー側の記録は使っていなかったため。
- 現地専用の値切り交渉・実機解除・NFTメタデータ配信などは移植していない(スコープ外)。

## セットアップ手順

### 1. Upstash Redis(状態保存用)を用意する

Vercelダッシュボード → 対象プロジェクト → **Storage**タブ → **Create Database** →
**Upstash for Redis**(Marketplace経由、無料枠あり)を選ぶと、
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` が自動でこのプロジェクトの
環境変数に追加される(自分で値をコピペする必要はない)。

### 2. Vercelプロジェクトを作成する

このリポジトリ(`ichigo_gatya`)は変更しなくてよい。Vercelダッシュボードで
**New Project** → このGitHubリポジトリを選択 → **Root Directory**を`online-vercel`に
設定してデプロイする(`payment/`を単独デプロイしたときと同じやり方)。

### 3. 環境変数を設定する

`.env.example`を参照。最低限これだけで動く:

- `NEGOTIATE_FLOOR_COST`(必須。これが無いとオンライン参加自体が無効になる)
- `ANTHROPIC_API_KEY`(推奨。無いとAI店番機能全体が無効になる)
- `ADMIN_SECRET`(スタッフ用の状況確認・強制終了エンドポイントの合言葉)

`COST` / `RPC_URL` / `TOKEN_ADDR` / `GAME_WALLET`は省略時、bridgeと同じ本番用の
値がデフォルトで使われる(`api/_lib/chain.js` / `api/_lib/config.js`参照)。

### 4. 動作確認

デプロイ後、`https://<デプロイ先>/online-status`にアクセスして
`{"enabled":true, ...}`が返ってくればAI周りの設定はOK。実際に本番のICHIGOで
少額の通しテスト(交渉→送金→景品表示)を一度行うことを推奨する。

## ローカル開発

```
npm install
cp .env.example .env  # 値を埋める(UPSTASH_*はUpstashダッシュボードから発行した値を使う)
npx vercel dev
```
