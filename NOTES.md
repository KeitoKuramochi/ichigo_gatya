# ICHIGOガチャガチャ プロジェクトメモ

このファイルは会話をまたいで参照する共有メモ。仕様や決定事項が増えるたびに追記していく。

## 目的

講義内通貨ICHIGO（Optimism上のERC-20トークン）の送金を確認したら、段ボール製の実機ガチャガチャからカプセルを1個排出する。

## 決済ページについて(方針転換)

当初は友人(MaedaReno)開発の [ICHIGO_game](https://github.com/MaedaReno/ICHIGO_game) の `gacha.html` を流用する予定だったが、**友人のゲームには一切依存しない、決済専用の自作ページ**に変更した。

- `payment/index.html`: ウォレット接続・残高確認・ICHIGO送金・(任意で)ブリッジサーバーへの通知のみを行う、レア度抽選やインベントリなどのゲーム要素を持たない単一HTMLファイル
- ethers.js(CDN)以外の依存なし。CDN読み込みには改ざん対策のSRI(`integrity`属性)を付与済み
- `http://localhost` 前提ではなく、ブリッジサーバー(`bridge/server.js`)が`express.static`でこのファイルを配信する形にした(スマホなど他端末からも同じIP:PORTで開ける)
- ローカルのICHIGO_gameクローン自体はディスク上に残っているが、以後の開発では参照・使用しない

### 主要アドレス（Optimism, chainId 10）
- GAME_WALLET: `0x70775B1d24176De0fda2776303B8a603C671cFFb`(授業のDiscord IDに紐づく自分のウォレット。友人のゲーム用アドレスとは別)
- ICHIGOトークン: `0x836700463Dce76D9Cc3CDf6F6EDF946312c01869`

## 手持ちの部品（2026-07-01到着）
- ESP32開発ボード（ideaspark ESP32 0.96インチOLEDボード, WiFi+BLE, CH340, ピンヘッダーはんだ付け済み）
- SG90 マイクロサーボモーター × 4個(YFFSFDC製、付属デュポンケーブルは両端オス-オスのジャンパー線)
- ブレッドボード（400穴）× 3個

### ネットワークまわりの注意(重要)
- **iPhoneのインターネット共有(Personal Hotspot)にMacを繋ぐと、同じApple IDでサインインしている場合「インスタントホットスポット」という特殊な省電力接続になり、Macが`192.0.0.2`のような別サブネットのIP(WiFi名は同じでも実際は別ネットワーク)になることがある**。この場合ESP32(`172.20.10.x`)と直接通信できない(ping不通)。Bluetoothオフ/Handoffオフでも直らないことがあった。
- 対策として `gachapon.ino` に `AP_MODE` という切り替えを追加した。`AP_MODE = true` にするとESP32自身がWiFi(SSID: `ICHIGO-GACHAPON`, パスワード: `ichigo1234`)を発信し、PC/スマホをそこに直接繋げば上記の問題を回避できる(ESP32のデフォルトIPは`192.168.4.1`)。`AP_MODE = false`で従来通り既存WiFiに子機として参加する(bridgeサーバーと組み合わせる本番用、bridgeサーバーがインターネットに出る必要があるため)。
- 本番でbridgeサーバー(インターネット接続が必要)と組み合わせるときは`AP_MODE = false`にして、MacとESP32両方を同じ「普通の」WiFi(Apple製品同士のインスタントホットスポットに巻き込まれないネットワーク)に接続すること。

### 実機の配線情報(このボード固有)
- このボードには「5V」という名前のピンは無い。5V相当は **VIN**(左列の一番下)
- サーボ信号は **D18**(=GPIO18、右列の上から9番目)
- GNDは左右どちらの列にもある(D18の近くは右列のGND)
- USBシリアルポートは実機で `/dev/cu.usbserial-21410` (`/dev/cu.wlan-debug` ではない)
- OLEDは基板内蔵、追加配線不要(内部でSDA=GPIO21, SCL=GPIO22, I2Cアドレス0x3C)
- 付属デュポンケーブルが両端オス-オスのため、ESP32本体をブレッドボードに挿してピンを"延長"し、そこにサーボの線をジャンパーで挿す方式で配線した(直結ではなくブレッドボード経由)

## アーキテクチャ（第一段階: PCあり）

```
gacha.html（ブラウザ）
  → tx.wait()成功後、tx.hashをブリッジにPOST
  → bridge/server.js（ローカルPC, Node.js/Express）がOptimism公開RPCでオンチェーン検証
    - GAME_WALLET宛のICHIGO Transferイベントか
    - 金額がCOST以上か
    - 同じtxHashの二重使用でないか
  → OKならESP32の /unlock にHTTPリクエスト
  → ESP32（Arduino）がサーボを一瞬動かしロック解除 → カプセル1個排出
```

段ボール製ガチャガチャは、本物と同じ「コイン投入式のロック機構」で自作済み(完成)。サーボの役目は「コインを投入する」動作の代役のみ:ロックのキー部分を1回下げて解除位置→ロック位置に戻す、という`unlockOnce()`の一往復だけでよい。ノブを回してカプセルを落とす動作や、カプセル排出後に再びロックがかかる動作は段ボール機構自体が機械的に行うため、コード側で制御する必要はない。

## 発展編（時間があれば）
ESP32自身がgacha.html一式をLittleFS/SPIFFSから配信し、スマホが同一WiFi上のESP32に直接アクセス→同一オリジンで `/unlock` を叩く構成に変更。PC(ブリッジサーバー)不要になる。トレードオフ: オンチェーン検証を挟まなくなるので送金なしでも直接叩けば動いてしまう（教室内デモとしては許容という前提）。

## 決済完了と実機解除の整合性(重要な設計変更)

これまでは「bridgeがオンチェーン検証OKを返す」→即座に決済ページが「支払い完了」表示、という作りだった。しかしESP32はポーリング方式で非同期に解除を実行するため、ESP32がオフライン・通信エラー・タイムアウトなどで実際には解除できなかった場合でも、ユーザーには「成功」が見えてしまう(=イチゴだけ取られてロックが開かない事故が検知できない)という欠陥があった。これを解消するため、以下の状態管理を追加した。

- `bridge/server.js`: 解除リクエストを`txHash`ごとに状態管理するMap(`unlockRequests`)を追加。状態は`pending`(検証OK、ESP32のポーリング待ち)→`dispatched`(ESP32が`/poll-unlock`で取得、実行結果待ち)→`unlocked`/`failed`と遷移する。ESP32が一定時間(`UNLOCK_ESP32_TIMEOUT_MS`=15秒)結果を報告しない場合や、`pending`のまま一定時間(`PENDING_MAX_AGE_MS`=5分、ESP32オフライン等)経過した場合は自動的に`failed`に倒す(後から無関係なタイミングで古い支払いの解除が実行される事故も防止)。`/unlock-result`(ESP32からの結果報告)と`/unlock-status`(決済ページが結果を確認するポーリング用)の2エンドポイントを追加。
- `firmware/gachapon/gachapon.ino`: `/poll-unlock`のレスポンスから`requestId`(=txHash)を取り出し、`unlockOnce()`実行後に`/unlock-result`へ成功/失敗を報告するようにした(1回失敗しても1回だけ再送)。
- `payment/index.html`: `/verify-and-unlock`が`ok:true`を返しても即座に完了表示せず、`/unlock-status`を最大30秒ポーリングして`unlocked`になるのを待ってから「支払い完了」を表示する。失敗/タイムアウト時は「送金は完了しているが解除できなかった」旨とtxHashを表示し、スタッフへの申告を促す。

## bridgeのホスティング(Render.com vs 研究室の常時稼働PC)

現在bridgeはRender.comの無料枠で常設デプロイしている。無料枠は一定時間アクセスが無いとスリープし、次のリクエストで起動に30秒前後かかることがある点に注意。研究室にずっと動いているPCがあるなら、そこでbridgeを動かし`cloudflared`等のトンネルで公開すれば、コストゼロかつスリープなし(コールドスタート遅延の心配がない)構成にできる。ただしその場合もPC自体が落ちる/再起動する/トンネルプロセスが死ぬ、といった別のリスクは残るため、どちらのホスティングでも「決済完了と実機解除の整合性」のしくみ(上記)は必須という結論。

## 進め方のルール
- このNOTES.mdは会話のたびに更新し、仕様や決定事項を追記する
- Claude Codeはこの`ichigo`フォルダ配下以外のファイルを編集しない（`.claude/settings.json`のフックで強制。新規に作った直後のセッションでは反映が遅れることがあるので、その場合は`/hooks`を一度開くか再起動する）

## AI店番エージェント(値切り交渉チャット、2026-07-05追加)

無人運営(教室・イベントでの展示中、係員が付きっきりでいなくても回せるようにする)の一環として、決済の前段に「AI店番とチャットで値切り交渉する」ステップを追加した。当初は「講義内容のクイズに正解したら割引/権利を得られる」という案もあったが、より具体化された要望では自由な値切り交渉チャットのみになったため、クイズは別UIとして実装せず、AI店番のキャラクター内で講義トピック(このichigoプロジェクトの元になっているweb3/AI概論の授業内容)を雑談として絡める程度に留めた。「講義の構成のように」という発言は、講義で紹介されたAIエージェント事例「isbot」のアーキテクチャ(端末→nanoclaw(入口/隔離)→deshi(ブレイン×記憶))を指すと判断し、その構成の考え方(薄い入口層とブレイン層を分離する)だけを参考にした(nanoclaw/deshi自体はisbot社の自社プロダクトで外部から呼べるAPIではないため、直接の連携は行っていない)。

- `negotiate/index.html`(新規): スマホ用のチャット+決済ページ。QRコードの飛び先として想定。`payment/index.html`と同じウォレット接続パターンを流用し、①ウォレット接続→②AI店番とチャットで3〜4ターンの値切り交渉→③確定価格で送金、という流れを1ページ内(別ページへのリダイレクトなし)で行う。`/negotiate-start`が404(=機能無効)の場合は通常の決済ページ(`/`)へのリンクを出す。
- `spectator/index.html`(新規): 会場のプロジェクター/モニターに映す読み取り専用ページ。ウォレット関連のコードは一切持たず、`/negotiate-current`を2秒おきにポーリングして、現在進行中の交渉のチャット内容・提示価格をそのまま大きな文字で表示するだけ。
- `bridge/negotiation.js`(新規): Anthropic Messages APIを呼ぶ薄いモジュール。価格はモデルの自由文から抜き出さず、tool-forcing(`quote`ツールを強制呼び出し)で`{reply, price, done}`を構造化取得する。`@anthropic-ai/sdk`は追加せず、Node組み込みの`fetch`で直接呼んでいる(既存bridgeの依存を増やさない方針)。
- `bridge/server.js`: `negotiationSessions`という新しいMapを既存の`unlockRequests`等と同じパターンで追加(`negotiating`→`awaiting-payment`→`redeemed`/`expired`の状態遷移、`sweepStaleNegotiationSessions()`で放置セッションを掃除)。実機は1台なので同時に1交渉のみ(`currentSessionId`で単一管理)という前提にした。
  - `POST /negotiate-start` `{wallet}` / `POST /negotiate-message` `{sessionId, message}` / `POST /negotiate-finalize` `{sessionId}` / `GET /negotiate-current` を追加。いずれもX-Secret認証は不要(参加者本人が使うことを想定したエンドポイント)。
  - `POST /verify-and-unlock`が`{txHash, sessionId?}`に対応。`sessionId`が付いている場合のみ、`findValidTransfer()`の最低額をグローバルなCOSTではなくそのセッションの確定価格(`finalPriceWei`)にし、送金元アドレスが交渉時のウォレットと一致することも必須にする(**これが無いと、sessionIdを知っている誰でも他人の値切り済み価格を使い回せてしまうため**)。成功後はセッションを`redeemed`にして再利用を防ぐ。`sessionId`が無い場合(従来の`payment/index.html`)は挙動を一切変えていない。
  - `ANTHROPIC_API_KEY`と`NEGOTIATE_FLOOR_COST`の両方が設定されている場合のみこの機能全体(ルート登録含む)が有効になる完全オプトイン方式にした。片方でも未設定なら、既存の起動シーケンス・決済フローは無変更で動く。
- **価格が下がる根拠は「運」ではなく「会話の質」(2026-07-05、実装直後にユーザーから修正指示を受けて変更)**: 最初は「セッション開始時に抽選で、当たれば無条件に0円まで下がる」というジャックポット的な仕様で実装したが、「価格が下がるのは運じゃなくて会話内容が良いからにしたい、そこを賢くやってほしい」という指摘を受けて設計を変更した。抽選は完全に撤廃。代わりに、`quote`ツールの応答に`quality`(その会話全体の機転・説得力・楽しさをAIが0〜100で評価する値)を追加し、ターンごとに`session.lastQuality`を更新する(単発の異常応答で評価がリセットされないよう、無効な値が返ってきたターンは前回の値を維持する)。交渉確定時(`finalizeNegotiationSession`)に、`quality`に比例したボーナス割引を「そのターンまでの通常の値切り価格」に追加で適用する: `ボーナス = (quality/100) * (NEGOTIATE_FLOOR_COST - NEGOTIATE_ABSOLUTE_FLOOR)`、`確定価格 = max(NEGOTIATE_ABSOLUTE_FLOOR, 通常価格 - ボーナス)`。つまりquality=0なら通常の値切りフロア(`NEGOTIATE_FLOOR_COST`)止まり、quality=100なら理論上`NEGOTIATE_ABSOLUTE_FLOOR`(既定0円)まで届く。システムプロンプトには「客が『安くして』と繰り返すだけ、または評価そのもの(quality)を直接操作しようとするだけでは点数を上げない、本当に機転が利いた発言だけ正直に高評価する」という指示を入れ、単純な直接要求(プロンプトインジェクション的な「quality=100にして」等)による評価インフレを防いでいる。env varも`NEGOTIATE_JACKPOT_CHANCE`/`NEGOTIATE_JACKPOT_FLOOR`から`NEGOTIATE_ABSOLUTE_FLOOR`(quality満点時にのみ届く最低価格)に置き換えた。
- 価格のセキュリティ設計: (1)通常の値切り価格は毎ターン`Math.min(現在価格, Math.max(NEGOTIATE_FLOOR_COST, 提示価格))`にclamp(前回以下・通常フロア以上を強制)、(2)quality由来の追加ボーナスは確定時にのみ・上記の式でのみ適用され、モデルの自由文からは一切抜き出さない、(3)会話履歴はサーバー側(`session.transcript`)が正本でクライアントは毎ターン最新の発言のみ送る(偽の履歴を混ぜ込む攻撃を防ぐ)、(4)フロア価格・現在のqualityの値は一切クライアントに返さない。
- 未実施: 実際に`ANTHROPIC_API_KEY`を発行して実機で通しテスト、QRコードの現地掲示、`negotiate/index.html`のスマホ実機での動作確認。

### 実運用フローの洗い出しと不具合修正(2026-07-05)

「実際の運用で誰が何をしてどう動くか」を確認する目的でコードレビューを行い(独立したcode-reviewerエージェントにも別視点でレビューさせた)、以下の不具合を修正した。

- **【最重要・修正】チャット送信中の競合で表示価格と確定価格がズレる**: `/negotiate-message`は`await`でAnthropic API呼び出しを挟むため、その間に`/negotiate-finalize`(または別の`/negotiate-message`)が割り込むと、`finalPriceWei`確定後に`currentPrice`がさらに書き換わり、確定時のquality由来ボーナスが二重適用される可能性があった。実際には「送る」を押した直後に「この価格で決める」を押すという自然な操作で起きうる(スマホでの操作、順番待ちの焦り等)。`session.busy`フラグ(処理開始時にtrue、`try/finally`で必ずfalseに戻す)を追加し、処理中は`/negotiate-message`・`/negotiate-finalize`の両方を409で弾くようにした。`negotiate/index.html`側も「この価格で決める」ボタンを送信中はdisabledにする二重の防御を入れた。
- **【最重要・修正】スタッフが進行中の交渉を強制終了する手段が無かった**: 実機は1台で同時に1交渉のみという制約上、参加者のスマホが止まる・離脱すると、次の人は自動タイムアウトを待つしかなかった(列ができる実運用では現実的でない)。既存の`admin/refill-lock.html`と同じX-Secret認証パターンで`POST /negotiate-admin-cancel`を追加し、`admin/refill-lock.html`に現在の交渉状況の表示(`/negotiate-current`をポーリング、認証不要)と「今の交渉を強制終了」ボタンを追加した。
- **修正: アイドルタイムアウトが「セッション作成からの総経過時間」になっていた**: `sweepStaleNegotiationSessions()`が`createdAt`基準で`negotiating`セッションを期限切れにしていたため、参加者が途切れず会話を続けていても作成から10分経つと強制終了されうる不整合があった(コード上の意図は「放置」の検出だった)。`lastActivityAt`(`/negotiate-message`・`/negotiate-finalize`の成功時に更新)を新設し、そちらを基準にするよう修正。
- **修正: AI呼び出し失敗時にもターン数を消費していた**: Anthropic API呼び出しがタイムアウト等で失敗(`null`)した場合でも`turnCount`が加算されていた。参加者の落ち度ではない失敗でターンを消費しないよう、`result`が`null`の場合は`turnCount`の加算・確定判定をスキップするよう修正(詫び文言は表示する)。
- **修正: チャット送信失敗時、送れていない発言が画面に残り続けた**: `negotiate/index.html`は楽観的にユーザーの発言バブルを表示してから送信していたため、失敗時(会場Wi-Fi/トンネル越しの通信エラー等)にサーバー側には記録されていない発言が画面に残ったままになっていた。失敗時にその吹き出しを削除し、入力欄に文面を戻して再送しやすくした。
- **修正: ウォレット切り替え時にページの状態が壊れていた**: `accountsChanged`ハンドラは`signer`/`account`/残高だけ更新していたが、`sessionId`やチャット/支払いUIの状態、さらに接続時に1度だけ生成される`token`(ethers Contractインスタンス)は古いsignerを参照し続けるため、アカウント切り替え後に送金しようとすると古いアカウントで署名しようとして失敗する不具合があった。個別に直すのではなく、`accountsChanged`で単純に`location.reload()`する方式に変更した。
- 動作確認: ローカルでbridgeを起動し、(1)`/negotiate-message`と`/negotiate-finalize`を意図的に同時に叩いてbusyロックで後者が409になること、(2)`/negotiate-admin-cancel`が正しい/誤ったX-Secretで期待通り動作すること、(3)AI呼び出し失敗時に`turn`が加算されないこと、をcurl+Nodeスクリプトで確認済み。`negotiate/index.html`のUI変更(ボタンのdisabled制御・吹き出しロールバック・reload)はブラウザでの実機確認が必要(未実施)。

### Geminiフォールバック追加(2026-07-05)

「メインはAnthropic、失敗した時用にGeminiも入れておきたい」という要望を受け、`bridge/negotiation.js`にフォールバック機構を追加した。

- 内部を`callAnthropic()`(メイン)と`callGemini()`(フォールバック)に分割し、`getNegotiationReply()`が両者をオーケストレーションする: まずAnthropicを呼び、失敗(タイムアウト・障害・応答形式不正)した場合のみ、`GEMINI_API_KEY`が設定されていればGeminiを試す。両方失敗した場合は既存通りnullを返し、server.js側の詫び文言フォールバック(ターン非消費)に委ねる
- Gemini呼び出しは`generativelanguage.googleapis.com`の`generateContent`エンドポイントに、`toolConfig.functionCallingConfig.mode: "ANY"`で`quote`関数を強制呼び出しさせる形で実装(Anthropicの`tool_choice: {type:"tool"}`と同じ役割)。ロール名がAnthropicの`user`/`assistant`ではなく`user`/`model`である点だけ変換している
- 両プロバイダの応答を`normalizeQuoteInput()`という共通関数で同じ`{reply, price, quality, done}`形に正規化しており、server.js側の呼び出し・価格clamp・quality反映ロジックは無変更で動く
- 新規env var: `GEMINI_API_KEY`(未設定ならフォールバック自体が無効)、`GEMINI_MODEL`(既定`gemini-2.0-flash`)
- 動作確認: 両方のAPIキーをダミーにしてローカルで叩き、Anthropic実エンドポイントで401→Geminiへフォールバック→Gemini実エンドポイントでも400(無効なキー)→最終的に詫び文言かつターン非消費、という一連の流れをログで確認済み。**実際に有効なGEMINI_API_KEYでの成功レスポンス(関数呼び出しの実データ)は未確認**(未実施)。イベント前に本物のキーで一度試すこと。

## 作ったファイル一覧

- `ICHIGO_game/`（新規, GitHubからclone）: 友人のゲーム本体。`gacha.html`の`tx.wait()`成功直後にブリッジへの`fetch`呼び出しを1箇所追加済み
- `firmware/step0_servo_test/step0_servo_test.ino`: サーボ単体動作確認用。シリアルモニタで`u`+Enterを送るとロック解除動作を1回行う
- `firmware/gachapon/gachapon.ino`: 本番用。WiFi接続+`POST /unlock`(要`X-Secret`ヘッダー)でサーボを解除動作させる。角度・保持時間を指定するテスト動作、補充用ロックの開閉にも対応(下記参照)
- `bridge/server.js` / `bridge/package.json` / `bridge/.env.example`: オンチェーン検証+ESP32中継サーバー
- `test/motor-test.html`: モーター調整用のテストページ(下記参照)
- `admin/refill-lock.html`: 補充用ロックの開閉管理者ページ(下記参照)
- `negotiate/index.html` / `spectator/index.html` / `bridge/negotiation.js`: AI店番エージェント(値切り交渉チャット)関連(上記参照)
- `.claude/settings.json` / `.claude/hooks/enforce-ichigo-scope.sh`: 編集範囲をichigoフォルダ内に限定するフック

## モーター調整用テストページ(2026-07-03追加)

サーボの解除角度・保持時間を実機で試行錯誤するための専用ページ。決済フロー(送金検証)とは完全に独立している。

- `test/motor-test.html`: bridgeが`/test/`以下で配信する単一HTMLファイル。角度(0〜180度)・保持時間(秒)・回転にかける時間(秒、ゆっくり度)を入力して「動かす」を押すと、bridge経由でESP32のサーボを1回だけそのパラメータで動かし、自動でロック角度(`LOCK_ANGLE`)に戻る。合言葉(`X-Secret`)の入力欄があり、`gachapon.ino`の`SHARED_SECRET`と同じ文字列を入れる必要がある(ブラウザのlocalStorageに保存される)。合言葉欄はiOS Safari等の「強力なパスワードを自動生成」機能が誤爆しないよう`type="text"`+自動補完オフにしてある
- `bridge/server.js`: `POST /test-move`(角度・保持時間・回転時間を受け取って予約、要`X-Secret`)、`GET /test-move-status`(結果確認用ポーリング、認証不要)、`POST /test-move-result`(ESP32からの結果報告、要`X-Secret`)を追加。`unlockRequests`と同じ`pending→dispatched→done/failed`の状態管理を`testMoveRequests`という別Mapで行う
- ESP32への配信は既存の`/poll-unlock`の応答に相乗りさせている(`testMove`/`testRequestId`/`testAngle`/`testHoldMs`/`testMoveMs`フィールドを追加)。理由: ESP32はHTTPS通信を数秒おきに繰り返すとヒープが減っていく既知の問題を抱えており(上記参照)、テスト動作のためだけに別のポーリング先を増やすとHTTPSリクエスト回数が倍になり本番の解除フローの安定性を損なうため
- `firmware/gachapon/gachapon.ino`: `pollBridge()`内で`testMove:true`を検知したら、角度・保持時間・回転時間を(念のため0〜180度/0〜5000msに再clampした上で)サーボに反映し、`/test-move-result`に成功/失敗を報告する`reportTestMoveResult()`を追加。数値フィールドをパースする`extractJsonNumberField()`も新設(既存の`extractJsonStringField()`は文字列値専用のため)
- **ゆっくり回転(2026-07-03追加)**: `Servo.write()`を1回呼ぶとSG90の最高速で瞬時に動いてしまうため、`moveServoSmoothly(fromAngle, toAngle, durationMs)`を新設した(`durationMs=0`なら従来通り瞬時)。本番の`unlockOnce()`もこれを使うように変更し、新定数`UNLOCK_MOVE_MS`(デフォルト500ms)で往路・復路それぞれの回転時間を制御する。テストページにも「回転にかける時間」スライダーを追加し、`testMoveMs`として送れるようにした
- **ゆっくり回転のガクガク不具合修正(2026-07-03)**: 初版の`moveServoSmoothly`は「角度差」の数だけ分割していたため、動かす角度差が小さいのに長い時間を指定すると(例: 10度だけ動かすのに0.5秒)、1度あたりの待ち時間が異常に大きくなり「1度動いて止まる」を繰り返すガクガクした動きになる不具合があった。一定間隔(`STEP_INTERVAL_MS`=15ms、サーボのPWM周期相当)ごとに「目的角度までの進み具合」に応じた角度を書き込む方式に変更し、角度差の大小によらず滑らかに動くようにした。
- **本番の解除角度・時間を確定(2026-07-03)**: `test/motor-test.html`での試行錯誤の結果、`angle=45度・holdMs=950・moveMs=500`が良好と判断されたため、`gachapon.ino`の`UNLOCK_ANGLE`を0→45、`UNLOCK_HOLD_MS`を400→950に変更(`UNLOCK_MOVE_MS`はもともと500ですでに一致)。`unlockOnce()`(実際の決済解除で使われる関数)はこれらの定数を参照しているので、この変更だけで本番の解除動作にも反映される。
- **サーボ対象の選択(2026-07-03)**: `test/motor-test.html`に「対象のサーボ(メイン/補充)」タブを追加。`/test-move`のリクエストに`servo`("main"または"refill")を含められるようにし、`moveServoSmoothly()`は動かすServoオブジェクトを引数で受け取る形にリファクタした(元は`gachaServo`固定だった)。

## 補充用ロック(2個目のサーボ、2026-07-03追加)

カプセル補充用のフタに2個目のSG90サーボを取り付け、決済とは無関係に管理者が開閉できるようにした。

- **配線**: 信号線をGPIO19に接続(メインはGPIO18)。電源(VIN)・GNDはメインと同じブレッドボードの電源レールを共有してよい。GPIO19は仮の提案値なので、実機で他用途と衝突しないか確認すること
- **動き方**: メインのコイン投入ロック(`unlockOnce()`)と違い、補充用は「開けたら管理者が明示的に閉めるまで開いたまま」(自動で戻らない)。補充作業中にフタを開けっぱなしにできるようにするため
- `firmware/gachapon/gachapon.ino`: `refillServo`(GPIO19)を追加。`REFILL_CLOSED_ANGLE`(180)・`REFILL_OPEN_ANGLE`(0)・`REFILL_MOVE_MS`(500)は仮値で、`test/motor-test.html`の「補充用」タブで実機確認して調整すること。`pollBridge()`で`adminLock:true`を検知したら`adminAction`("open"/"close")に応じて`REFILL_OPEN_ANGLE`/`REFILL_CLOSED_ANGLE`まで動かし、`/admin-lock-result`に結果を報告する
- `bridge/server.js`: `POST /admin-lock`(`{action:"open"|"close"}`、要`X-Secret`)、`GET /admin-lock-status`(結果確認用ポーリング、認証不要)、`POST /admin-lock-result`(ESP32からの結果報告、要`X-Secret`)を追加。`adminLockRequests`という別Mapで`pending→dispatched→done/failed`を管理し、ESP32への配信は他の機能と同様`/poll-unlock`に相乗りさせている(`adminLock`/`adminRequestId`/`adminAction`フィールド)
- `admin/refill-lock.html`: bridgeが`/admin/`以下で配信する管理者ページ。「開ける」「閉める」の2ボタンと合言葉入力欄のみのシンプルな作り
- **本番の開閉角度・時間を確定(2026-07-06)**: `test/motor-test.html`の「補充用」タブでの試行錯誤の結果、`moveMs=0`(即座に動かして落とす)が良好と判断された。当初`REFILL_OPEN_ANGLE`を0→80に変更したが、直後に「デフォルト(起動時)は開いている状態にしたい、閉めたら80度に倒れる向きにしたい」という向きの訂正を受け、`REFILL_OPEN_ANGLE`と`REFILL_CLOSED_ANGLE`の値を入れ替えて確定: `REFILL_OPEN_ANGLE=180`(起動時のデフォルト、`setup()`の初期書き込みもこちらに変更)・`REFILL_CLOSED_ANGLE=80`(管理者ページの「閉める」でこの角度に倒れる)。`moveMs=0`は変更なし。テスト動作(`test/motor-test.html`)の待機角度(`restAngle`)も同じ理由でOPEN側に合わせて修正した。
- 未実施: GPIO19が実機で使える空きピンかどうかの確認、firmwareの書き込み直し(上記の角度変更を反映するため)
- **不具合調査(2026-07-03〜04) → 解決**: 管理者ページで「開ける」を押すと成功(`done`)と表示されるのに、実際のサーボは1回も動かないという不具合があったが、原因はコードではなく2個目のサーボの配線の挿し間違い(物理的な配線ミス)だった。配線を挿し直したところ解決。切り分け用に追加したシリアルコマンド(`handleSerialCommand()`、`r`+Enterで補充用サーボを直接テスト)は結果的に不要だったが、コードに残しておいて今後も配線トラブル時の切り分けに使える
- **実機確認済み(2026-07-04)**: スマホの`test/motor-test.html`から補充用サーボの開閉を何度も連続で試せることを確認。メイン(コイン投入ロック)と補充用が独立して制御できることも確認できた。残タスクは`REFILL_CLOSED_ANGLE`/`REFILL_OPEN_ANGLE`(仮値180/0)の実機での微調整のみ
- アクセス方法: bridgeのURL(例 `https://ichigo-gatya.onrender.com/test/motor-test.html`)を直接開く。QRコードにする必要はなく、開発中のブックマークで十分

## セットアップ手順

### ESP32(Step 0 → Step 1)
1. Arduino IDEをインストールし、ESP32ボードのサポートを追加(ボードマネージャで"esp32"を検索)
2. **ライブラリマネージャ**(本のアイコン。ボードマネージャとは別画面なので注意)で以下をインストール
   - `ESP32Servo` (by Kevin Harrington / John K. Bennett)
   - `U8g2` (by oliver / olikraus) — OLED表示用。日本語フォント(ひらがな/カタカナ中心)を内蔵しているのでこちらを採用(Adafruit SSD1306ではOLEDが日本語を表示できず文字化けしたため)
3. まず `firmware/step0_servo_test/step0_servo_test.ino` を書き込み、配線とサーボの動きを確認(2026-07-02に実機で成功済み)
4. 動いたら `firmware/gachapon/gachapon.ino` を開き、`WIFI_SSID` / `WIFI_PASSWORD` / `SHARED_SECRET` を書き換えてから書き込む(OLEDに日本語で起動状況やIPアドレス、解除時のメッセージを表示する)。**SHARED_SECRETは半角英数字にすること**(HTTPヘッダーの値として送るため、日本語などの非ASCII文字だと正しく送受信できないことがある)
5. OLEDまたはシリアルモニタ(115200bps)に表示されるIPアドレスを控えておく(次の手順で使う)

### 検証ブリッジ
1. `cd bridge && npm install`
2. `cp .env.example .env` してから、`ESP32_IP`(上で控えたIP)と`ESP32_SECRET`(gachapon.inoと同じ文字列)を設定
3. `npm start` で起動。`検証ブリッジサーバー起動: http://localhost:3001` と表示されればOK

### ゲーム本体
`ICHIGO_game/` を `http://localhost` で配信して開く(`file://`では動かないので、`npx serve ICHIGO_game` などローカルサーバー経由で開くこと)。ブリッジのポートを変える場合は `gacha.html` 内の `http://localhost:3001/verify-and-unlock` も合わせて書き換える。

## テスト手順(Step 5)

1. **ESP32単体テスト**: ブリッジを介さず直接叩く
   ```
   curl -X POST http://<ESP32のIP>/unlock -H "X-Secret: <SHARED_SECRETと同じ文字列>"
   ```
   ゲートが開閉すればOK。`X-Secret`を間違えると403が返る。
2. **ブリッジ単体テスト**: Optimismscanで確認できる実際の送金tx.hashを使う
   ```
   curl -X POST http://localhost:3001/verify-and-unlock -H "Content-Type: application/json" -d '{"txHash":"0x..."}'
   ```
   - 本物のGAME_WALLET宛tx → `{"ok":true}` かつESP32が動く
   - 適当な偽txHash → 404または400で弾かれる
   - 同じtxHashをもう一度送る → 409で弾かれる(二重使用防止)
3. **E2Eテスト**: `ICHIGO_game`をローカルで開き、実際にガチャを1回引いて、送金確定→ブリッジ検証→ESP32→カプセル排出まで通しで確認

## 物理工作(Step 4) — 完了
段ボール製ガチャガチャ本体(コイン投入式ロック機構込み)は組み立て済み。サーボをそのロック解除キーに取り付ければ完成。

## 進捗ログ
- 2026-07-02: プランを確定。PCありのブリッジ構成を第一段階として実装開始。
- 2026-07-02: Step -1(メモリ/NOTES.md/編集範囲フック)、Step 0〜3(サーボテスト・ESP32 HTTPサーバー・検証ブリッジ・gacha.html連携)まで実装完了。残りはStep 4(物理工作)とStep 5(実機での結合テスト)。
- 2026-07-02: Step 0を実機で書き込み・動作確認まで成功(サーボがシリアル入力`u`で解除動作)。`gachapon.ino`にOLED表示機能(起動状況・待機中IP表示・解除中メッセージ)を追加。
- 2026-07-02: OLEDが日本語で文字化けする不具合を確認(Adafruit_GFX標準フォントは日本語非対応)。`U8g2`ライブラリ+日本語フォント(`u8g2_font_unifont_t_japanese1`)に切り替え、ひらがな/カタカナ中心のメッセージに変更。`showLines()`を汎用関数として残し、今後の表示追加はこの関数を呼ぶだけで拡張できるようにした。
- 2026-07-02: `gachapon.ino`を実機で書き込み、WiFi接続(テザリング, IP取得)・HTTPサーバー起動まで成功。OLEDの文言が画面幅(128px, 全角文字は1文字16px)からはみ出る問題を発見し、「ICHIGOガチャガチャ」等の長い文言を「ICHIGO」「たいきちゅう」のように全角8文字以内に短縮。OTA(WiFi経由の書き込み)は別タスクとして後回しにすることで合意。
- 2026-07-02: `curl`での`/unlock`テストがMacからESP32へping不通で失敗。原因調査の結果、iPhoneインターネット共有時のMacの「インスタントホットスポット」(別サブネット`192.0.0.2`になる挙動)と判明。Bluetooth/Handoffオフでも解消せず。`gachapon.ino`に`AP_MODE`(ESP32が自分でWiFiを発信するモード)を追加し、この問題を回避できるようにした。
- 2026-07-02: AP_MODEでping疎通は成功したが、`curl`が常に`forbidden`(403)を返す不具合を発見。原因はESP32の`WebServer`ライブラリが`server.collectHeaders()`で事前登録しないと独自ヘッダー(`X-Secret`)を読めない仕様だったため。`setup()`に`collectHeaders`を追加して修正。
- 2026-07-02: **Step 1完全成功**。`curl -X POST http://192.168.4.1/unlock -H "X-Secret: ichigo123"` で`unlocked`が返り、サーボのロック解除動作を確認。ESP32単体(AP_MODE)でのHTTPサーバー・認証・サーボ制御が実機で動作することを確認できた。次はStep 2(検証ブリッジ)以降。
- 2026-07-02: 友人のICHIGO_gameは不使用に方針転換し、決済専用の`payment/index.html`を新規作成(GAME_WALLETは授業のDiscord IDに紐づく自分のウォレット`0x70775B...cFFb`)。GitHub非公開リポジトリ`KeitoKuramochi/ichigo_gatya`にpushし、Vercelで`payment/`をデプロイ(Root Directoryを`payment`に設定)。ただしVercel単体では`bridge`が無いため物理連携APIには届かず、実運用は「ブリッジサーバー自身が配信するページ」をQRコードにする方針にした。
- 2026-07-02: バックグラウンドのセキュリティレビュー指摘(リプレイ攻撃・確定待ちなし)を受け、`bridge/server.js`に使用済みtxHashのファイル永続化・最小confirmations・取引の鮮度チェック(15分以内)を追加。
- 2026-07-02: 決済ページを「支払う=物理ガチャガチャが動く」前提にシンプル化(任意のブリッジURL入力欄を削除し、常に同一オリジンの`/verify-and-unlock`を叩く形に変更)。
- 2026-07-02: **iPhone(MetaMaskアプリ内ブラウザ)からMacのブリッジ(`192.0.0.2:3001`、iPhoneインスタントホットスポットのトンネル経由)への決済フルフローが成功**。ウォレット接続→残高表示→送金→オンチェーン検証until`{"ok":true}`まで確認(ESP32未接続のため`esp32Notified:false`は想定通り)。iPhone-Mac間はインスタントホットスポットのトンネル自体では直接届くことが判明(ESP32のような第三の端末を挟むと届かなくなるだけ)。
- 2026-07-02: 「送金成功=決済完了表示」だとESP32が解除に失敗しても気づけない問題を指摘され、bridge/firmware/決済ページの3ファイルに解除結果の確認フロー(`pending`→`dispatched`→`unlocked`/`failed`の状態管理、ESP32からの`/unlock-result`報告、決済ページの`/unlock-status`ポーリング)を追加。あわせてbridgeホスティングを研究室PC常時稼働+トンネルに変える案も検討(コスト・コールドスタート回避のメリットはあるが、上記の整合性の仕組みはホスティング先に関わらず必須という結論)。
- 2026-07-03: モーター(サーボ)の解除角度・保持時間をブラウザから調整できるテストページ`test/motor-test.html`を追加。bridgeに`/test-move`・`/test-move-status`・`/test-move-result`を新設し、ESP32への配信は既存の`/poll-unlock`に相乗りさせる形にした(HTTPSポーリング回数を増やしてヒープ枯渇リスクを上げないため)。ローカルで別ポート(3099)にbridgeを起動し、`curl`で予約→ポーリング→結果報告→ステータス確認の一連の流れを確認済み(既存の本番用bridgeプロセスは起動したまま、干渉させていない)。
- 2026-07-03: 「ファームウェアの書き込み直しが必要」という説明を「機能自体を消していい」という指示だと誤解し、一度`test/motor-test.html`とbridge/firmwareのテスト動作コードを丸ごとrevertしてpushしてしまった。実際の意図はページ自体は使える状態を保ってほしいというものだったため、直後にrevertをrevertして元の実装(コミット`679d3f1`相当)に戻しpush済み。**現状: bridge・テストページは有効。ただしfirmware(`gachapon.ino`)側のテスト動作受信コードはリポジトリ上には存在するが、実機ESP32にはまだ書き込まれていないため、ページから予約しても実際にサーボは動かない(書き込み後に有効化される)。**
- 2026-07-03: 「デフォルトで起動したら180度を向いていて、動作時に0度へ戻る」動きにしたいとの要望を受け、`gachapon.ino`の`LOCK_ANGLE`/`UNLOCK_ANGLE`を`0`/`90`から`180`/`0`に変更(起動時の初期位置=180度、解除動作で一瞬0度に振ってから180度に戻る)。`unlockOnce()`・`setup()`・テスト動作の自動復帰は全て定数参照なので、この変更だけで一括して反映される。あわせて`test/motor-test.html`のプリセット表示・デフォルト角度(90→0)・案内文言(「ロック角度(0度)」→「ロック角度(180度)」)も実態に合わせて修正。この変更もfirmwareの書き込み直しが必要(まだ未書き込み)。
- 2026-07-03: スマホ(iOS Safari等)で合言葉入力が「合っているのに予約に失敗する」と報告があり、原因調査中に`type="password"`だと「強力なパスワードを自動生成」機能が入力値を勝手に差し替える可能性に気づいたため、`test/motor-test.html`の合言葉欄を`type="text"`+`autocomplete/autocapitalize/autocorrect`オフに変更(見た目上のパスワードマスクは無くなるが、この合言葉は秘匿すべき個人情報ではなく実機保護用の共有トークンなので実害はない)。実際にこれで直るかはユーザーからの動作確認待ち。
- 2026-07-06: 会場(CHIBATECH PROTOTYPE)のWiFi(学校のWiFi、eduroam等のEnterprise認証やcaptive portalの可能性)ではESP32の`WiFi.begin(ssid, password)`が対応できない懸念を検討したが、当日はスマホのテザリングを使う方針に確定。bridgeがRender.com常設なのでESP32はインターネットに出られるWiFiであればどこでもよく、テザリングでも学校WiFiでも動作原理は同じ。`gachapon.ino`の`WIFI_SSID`/`WIFI_PASSWORD`は変更不要(既にテザリング用の値)。

## 表示名・単独占有・購入レシート・スタッフ手動交渉モード(2026-07-06追加)

「複数人が同時にやると誰が解除したか分からない」「決済後の証拠が何も残らない」「AIが使えない時の代替がロックの外にある」という運用上の不備の指摘を受け、計画→アドバーサリアルレビュー(2本のPlanエージェントに並行で設計案とワークフロー監査をさせた)→実装まで一括で行った。計画ファイルは`~/.claude/plans/vast-painting-penguin.md`に保存(このファイル自体はichigoフォルダ外のため、`.claude/hooks/enforce-ichigo-scope.sh`に`~/.claude/plans/`だけを例外とする1行を追加している)。

- **表示名(任意)**: `POST /negotiate-start`が`{wallet, displayName}`を受け取るようになった。空欄なら従来通りマスク済みウォレット表示にフォールバック。制御文字除去+20文字カットのサニタイズのみで、プロフィルタ等は行わない(教室内デモ相応と判断)。同一ウォレットの再接続時、新しい名前が空でなければ更新する(入力ミスの訂正を許可)。
- **スタッフによるmanual交渉モード(AIが使えない時の代替)**: 従来は`ANTHROPIC_API_KEY`等が無いと`/negotiate-*`ルート自体が404になり`payment/index.html`(`currentSessionId`のロックを一切見ない別ページ)に誘導していたが、これは「同時に1人まで」を誰でも`/`に直接アクセスするだけで迂回できる穴だった。now: `/negotiate-*`は常時有効で、AIが使えない場合は`session.mode='manual'`になり、参加者側は「店員と直接ご相談ください」の待機画面を表示するだけ。店員が`admin/refill-lock.html`から`POST /negotiate-admin-set-price`で価格を直接確定する(同エンドポイントはAIモードへの割り込み上書きにも使える)。
  - 安全ガード(アドバーサリアルレビューで発見): 価格上書きは`session.status==='negotiating'`の時だけ許可し、`awaiting-payment`(参加者が送金しようとしている可能性がある状態)への上書きは拒否する。理由: 送金の承認待ち中に価格を書き換えると、`/verify-and-unlock`が新価格でしか検証できなくなり「実際に払ったのに検証NG」という資金が絡む事故になるため。`session.busy`(AI応答待ち)中の上書きも409で拒否する(2026-07-05に直したチャット競合バグと同種の事故を防ぐ)。
  - スタッフ用の合言葉を`NEGOTIATE_ADMIN_SECRET`として`ESP32_SECRET`から分離した(未設定ならフォールバック)。価格を直接操作できる=金銭価値のある操作なので、物理操作用の合言葉と分けておく方が安全という判断。
  - `/`(このbridge自身のルート)を`/negotiate/`へリダイレクトするようにした。Vercel上の別デプロイの`payment/index.html`(`?bridge=`パラメータ付き)には影響しない。
- **決済証拠(レシート)画面**: `negotiate/index.html`は`/verify-and-unlock`が`ok:true`を返した時点で(実機の解除確認を待たずに)証拠画面に切り替える。名前・金額・支払い時刻・txHash・解除ステータス(その後`waitForUnlock`の結果で更新)を表示し、`localStorage`(`ichigo_receipt`, TTL30分)に保存してリロードしても消えない。仮に機材トラブルで解除に失敗しても、この画面をスタッフに見せれば対応できる、という設計。「別の人が使う場合」用に「この画面を消す」ボタンも付けた(貸出用の共有スマホを想定した保険)。
- **投影ページの「ありがとうございました」画面**: `spectator/index.html`に3つ目の状態(`justCompleted`)を追加。決済完了直後に自動で表示され、店員が`admin/refill-lock.html`の「サンキュー画面を消す」ボタンを押すか、次の交渉が始まると消える(タイマーでの自動消去はしない、という要望通り)。
  - あわせて既存バグを1つ修正: `renderTranscript`が`transcript.length`だけで再描画をスキップ判定していたため、Aさん終了直後にBさんが始まり会話の往復回数が偶然同じ長さになると、名前・価格はBさんに切り替わるのにチャット本文だけAさんの古い内容が残る、という誤表示が起きうる不具合があった。判定キーに(マスク済み)ウォレットの変化も含めるよう修正(sessionIdは公開すると`/negotiate-message`等を他人が叩けてしまうため、新たに公開APIに追加しない選択をした)。
- **管理者ページの購入履歴**: `GET /negotiate-admin-recent-purchases`(直近20件、マスクしないウォレット+txHash+実際の送金額を保持、NEGOTIATE_ADMIN_SECRET認証)を追加し、`admin/refill-lock.html`に表として表示。参加者本人のレシート画面が使えない場合の保険。
- **AI障害の可視化**: Anthropic/Gemini両方が連続で失敗した回数(`consecutiveAiFailures`)を数え、`/negotiate-current`経由で管理者ページに警告表示する(3回以上で表示)。スタッフがAI障害に気付かず参加者を待たせ続ける事故を防ぐ目的。
- 動作確認: ローカル(port 3099、`ANTHROPIC_API_KEY`未設定でmanualモード)で以下をcurlで確認済み — `/`のリダイレクト、表示名のサニタイズ(制御文字除去・20文字カット)、別ウォレットからの409拒否、同一ウォレット再接続での名前保持、`/negotiate-admin-set-price`の未認証403・範囲外400・正常時200・確定後の再上書き拒否400、`/negotiate-message`/`/negotiate-finalize`のmanualモードでの400拒否、`/negotiate-admin-recent-purchases`の未認証403、`/negotiate/`・`/spectator/`・`/admin/refill-lock.html`の200応答。**未確認(実機・実際の送金が必要なため今回は未実施)**: AIモードでの`session.busy`競合防止(実際のANTHROPIC_API_KEYが必要)、実際のICHIGO送金を伴うE2E(`lastCompleted`/レシート/購入履歴への反映)、`negotiate/index.html`のブラウザでの実機確認。次回、本物のAPIキーと少額の実送金で確認すること。

## ESP32 OLED表示フローの追加(2026-07-06追加)

「起動時ICHIGOGACHA→WiFi接続待ち→接続OK→信号待ち→購入時に誰が買ったか分かる表示→また待機」という運用イメージの指摘を受け、OLED表示フローを整理した。あわせて、表示名機能(前セクション参照)が自由文字を許可していたためESP32側で文字が欠ける懸念があったので、サイト側で文字種を絞る対応も行った。

- **「ICHIGO」→「ICHIGOGACHA」**: `firmware/gachapon/gachapon.ino`内、`showLines("ICHIGO", ...)`だった6箇所(起動時・低メモリ再起動時・WiFi接続中・OTA開始/終了・待機画面)を全て`"ICHIGOGACHA"`に置き換え。半角11文字相当(unifont内でASCIIは半角描画)で128px画面に収まる。
- **WiFi接続完了画面**: `setup()`内、`WiFi.begin()`の接続待ちループを抜けた直後に`showLines("ICHIGOGACHA", "せつぞくOK");`+`delay(1000)`を追加(それまでの「WiFiせつぞく」中との区別が付くように)。待機画面の文言(「たいきちゅう」)自体は変更なし。
- **表示名の文字種フィルタ(bridge/server.js)**: 参加者が入力する表示名は絵文字・漢字・中国語なども自由に許可していたが、ESP32のOLEDフォント(`u8g2_font_unifont_t_japanese1`)がひらがな・カタカナ・半角英数字中心のため、それ以外は表示が欠ける。`sanitizeDisplayName()`に、既存の制御文字除去・20文字カットに加えて「半角英数字・ひらがな・カタカナ(長音符ー含む)・半角スペース以外を除去」するフィルタを追加した(正規表現`/[^0-9A-Za-z぀-ヿ ]/g`)。投影ページ・AIプロンプト・管理者ログなど表示名を使う箇所全てに自動的に効く。`negotiate/index.html`側にも同じ文字種の同期チェックを追加し、送信前に「漢字や絵文字は使えません」と案内してブロックする(サーバー側フィルタは直接APIを叩いた場合の保険)。
- **購入者名のスクロール表示**: `gachapon.ino`に`showScrollingMessage(line1, line2, maxDurationMs)`を新設。line1(可変長)が128px画面に収まればそのまま静止表示、収まらなければ右端から左へ完全に抜けるまでスクロールする(総時間は`maxDurationMs`でクランプ、名前が長くてもOTA/ヒープ監視が長時間止まらないようにするため)。line2は固定表示。
  - bridge側: `/verify-and-unlock`が`unlockRequests`に`displayName`(sessionがあれば`session.displayName`、無ければnull)を保存し、`/poll-unlock`のレスポンスにも`displayName`を含めるようにした。ESP32は既存の`extractJsonStringField()`でそのまま取り出せる。
  - ESP32側: 解除検知時に「◯◯さんがこうにゅう」(名前が無ければ「だれかがこうにゅう」)をスクロール表示しつつ、2行目に「かいじょちゅう」を固定表示(4秒以内)。その後、既存の`unlockOnce()`(サーボ動作、タイミング変更なし)。成功したら「◯◯さんありがとう!」を一瞬表示(3秒以内)してから待機画面へ。**失敗したら、今までは無言で待機画面に戻っていたのを改善し、「ICHIGOGACHA/こしょう?/スタッフをよんで」を2.5秒表示**してから待機画面へ戻る。
  - リスクとして明記: 1回の購入あたり最悪ケースで合計約9秒`loop()`がブロックされ、その間OTA/シリアルコマンド処理が止まる(既存の`unlockOnce()`の約2秒ブロックと同種のトレードオフとして許容)。
- 動作確認: bridge側は`/negotiate-start`にdisplayName=`"田中たろうタロウ123🎉"`を送り、レスポンスが`"たろうタロウ123"`(漢字・絵文字が除去され、ひらがな・カタカナ・半角英数字のみ残る)になることをcurlで確認済み。`negotiate/index.html`の文字種チェックはnodeで正規表現の一致を確認済み(ブラウザでの実機確認は未実施)。**未確認(実機書き込みが必要なため未実施)**: `showScrollingMessage()`のスクロールが実際になめらかに動くか(`u8g2.getUTF8Width()`を初めて使うため要目視確認)、接続完了画面・購入者名スクロール・成功/失敗メッセージの一連の流れ。次回、実機に書き込んで少額決済1回・サーボ未接続状態での失敗テストを行うこと。

## AI用APIキーの管理場所(2026-07-07確認)

ローカルの`bridge/.env`には`ANTHROPIC_API_KEY`/`GEMINI_API_KEY`/`ESP32_SECRET`/`NEGOTIATE_FLOOR_COST`等が設定されておらず(`RPC_URL`/`TOKEN_ADDR`/`GAME_WALLET`/`COST`/`PORT`のみ)、ローカルではAIモードは動かずmanualモードになる。ただし**本番(Render.com)の環境変数には既に登録済み**とのことなので、本番では`NEGOTIATION_ENABLED`がtrueになりAIモード(Anthropicメイン→Gemini フォールバック)が動く想定。ローカルで動作確認する場合は`.env`にも同じキーを追記する必要がある点に注意。

## 実機テスト(本番Render)で見つかった4つの不具合の修正(2026-07-07)

参加者本人としてRenderの本番環境(`ichigo-gatya.onrender.com/negotiate/`)を実際に使ってみて見つかった問題をまとめて修正した。

- **【修正】チャットでEnterを押すと即送信され、日本語入力の誤入力が止まらない**: `negotiate/index.html`の`chatInput`の`keydown`ハンドラが`e.key === "Enter"`だけで送信していたため、日本語IME変換を確定するためのEnter(ブラウザ上は同じ`keydown: Enter`として発火する)まで誤って送信と判定していた。これが「最後の会話が飛ばされる」という報告の主因(変換確定のつもりのEnterで未完成の文章を送ってしまい、ターンを消費していた)。`e.isComposing || e.keyCode === 229`でIME変換中を判別し、その場合は無視するよう修正。
- **【修正】チャット送信後、AIの最後の返答を読む前に画面が支払い画面に切り替わってしまう**: `sendChatMessage()`が`data.done`(交渉成立)を受け取ると、AIの返答を吹き出しに追加した直後に間を置かず`enterPaymentPhase()`を呼んでチャット欄自体を隠していたため。`FINAL_REPLY_READ_MS`(1.8秒)待ってから切り替えるようにし、その間はボタンを無効化したままにした。
- **【修正】最終確定価格が、AIがチャットで示した価格より微妙に低くなる**: `bridge/server.js`の`finalizeNegotiationSession()`が、会話の質(quality)によるボーナス割引を確定の瞬間にだけ追加でこっそり適用していたため、画面に表示されていた/AIが返答文で言っていた価格と、実際に確定する価格がズレていた。ボーナスを確定時ではなく毎ターンの`/negotiate-message`処理内で`session.currentPrice`に反映するよう変更(内部的に、ボーナスを含まない生の値切り価格を`session.basePrice`という別フィールドで追跡し、そこから`quality`ボーナスを引いた値を`currentPrice`とする。両方とも「これまでの値以下」を保証するmin clampを入れており、後のターンでqualityが下がってもボーナスが縮小して価格が上がって見える事故は起きない)。これにより表示価格=確定価格になった。`finalizeNegotiationSession()`は単に`session.currentPrice`をそのまま確定するだけの関数になった。
- **【修正】レシート画面が出たあとリロードすると消えることがある**: 既存の実装はlocalStorageへの保存(TTL30分)のみに依存していたため、スマホのブラウザ/ウォレットアプリがタブを破棄してlocalStorageまで失われるケースに弱かった。`GET /negotiate-receipt?wallet=...`(認証不要、直近`recentPurchases`から該当ウォレットの購入を検索)をbridgeに追加し、`negotiate/index.html`はウォレット再接続時にlocalStorageのレシートが無ければこのエンドポイントに問い合わせて復元するようにした(`tryRestoreReceiptFromServer()`)。ウォレットを再接続しさえすれば、何度でもレシートが復元できるようになった。
- **【削除】レシート画面の「この画面を消す(別の人が使う場合)」ボタン**: 共有の貸出スマホで使う想定(NOTES.md 2026-07-06の記述参照)で付けていたが、実際の運用は各参加者が自分のスマホでQRを読む形であり、「次の人に画面を渡す」という前提自体が実態と合っておらず、参加者から「意味がわからない」との指摘を受けて削除した。関連するCSS(`.clearBtn`)・イベントハンドラも削除。
- 動作確認: ローカル(port 3099、AI無効のmanualモード)で`/negotiate-receipt`の異常系(wallet形式不正・見つからない場合)、`/negotiate-start`→`/negotiate-admin-set-price`→`/negotiate-current`で価格確定が一致すること、`/negotiate-admin-cancel`での後片付けをcurlで確認済み。**未確認**: quality由来ボーナスが実際に毎ターンcurrentPriceに反映されること(本物のANTHROPIC_API_KEYが必要なため、ローカルのdummy環境では検証できず、コードレビューでのみ確認)、IME修正・画面遷移の遅延・レシートのサーバー復元のブラウザでの実機確認。次回、本物のAPIキーでAIモードのE2Eテストを行うこと。

### `/negotiate-receipt`の認可不備を修正(セキュリティレビュー指摘、2026-07-07)

上記で追加した`/negotiate-receipt`は、当初「walletアドレスは秘密ではないから認証不要」という判断でGETかつ認証無しにしていたが、自動セキュリティレビューで「wallet単体が分かれば誰でも他人のニックネーム・支払額・解除状況を見られてしまう(IDOR)」と指摘を受けた。txHash/price自体は元々オンチェーンで誰でも見られる情報だが、ニックネームや「本人が意図的に問い合わせた」という体裁が崩れる点は妥当な指摘のため修正した。

- `POST /negotiate-receipt-challenge` `{wallet}`を新設。ウォレットごとに1回使い切りのnonce(`crypto.randomUUID()`を含む固定文言)を発行し、`negotiateReceiptChallenges`(Map、TTL2分)に保持する。
- `/negotiate-receipt`はGETからPOSTに変更し、`{wallet, signature}`を受け取るようにした。`ethers.verifyMessage(nonce, signature)`で復元したアドレスが`wallet`と一致することを確認してからのみレシートを返す。challengeは検証の成否に関わらずここで即座に消費(削除)し、同じ署名の再利用(リプレイ)を防ぐ。
- `negotiate/index.html`の`tryRestoreReceiptFromServer()`もこれに合わせて変更。ローカルのレシートが無い場合のみ呼ばれる経路なので、MetaMaskの署名ポップアップが増えるのはこの(本来レア寄りな)復元パスに限られ、通常の交渉開始フローには影響しない。署名を拒否された場合はエラー表示せず、黙って通常の交渉開始フローに進む。
- 動作確認: node+ethersでランダムウォレットを生成し、(1)正しい署名→200 found:false(購入記録なし)、(2)同じ署名の再利用(リプレイ)→400(challenge失効)、(3)別ウォレットの署名でのなりすまし→403、(4)署名なしでの直接アクセス→400、をすべて確認済み。実際に購入記録がある状態でのfound:true復元は未確認(実際の送金が必要なため)。

## 解除タイムアウト時の「解決したか」自己申告ボタンを追加(2026-07-07)

実機テストで、ESP32が未接続等でずっと解除できない場合、レシート画面が「タイムアウトしました。スタッフにお見せください」というエラー文言のまま永久に固まって見える(参加者から「このまま止まってしまう」との指摘)。bridge側にはスタッフが対応したかどうかを知る手段が無い(物理的な対応や口頭確認のため)ので、参加者自身に「解決したか」を選んでもらう自己申告方式にした。

- `negotiate/index.html`: `renderReceiptUnlockStatus(status)`を`updateReceiptStatusUI(receipt)`に置き換え、レシートオブジェクト全体を見て表示を決めるようにした。`unlockStatus`が`timeout`/`failed`になると「はい、受け取れました」「まだです、スタッフを呼びます」の2択(`receiptResolutionSection`)を表示する。
  - 「はい」を押すと`receipt.resolution = "resolved"`をlocalStorageに保存し、エラー文言・txHash・選択ボタンを消して「ICHIGOガチャガチャのご利用、ありがとうございました!」に切り替える。
  - 「まだです」を押すと`receipt.resolution = "pending"`を保存し、「スタッフの対応が終わったら、下のボタンを押してください」に文言を変えて「はい」ボタンだけを残す(再度「まだです」を押す必要はない)。
  - `resolution`はlocalStorageに永続化されるため、リロードしても選択した状態(解決済みならお礼画面、まだなら選択待ち文言)がそのまま復元される。サーバー側の`unlockStatus`自体は変わらない(bridgeは解決したかを知らないため)ので、この判断はあくまで参加者の自己申告であり、実際に解決したかの検証は行っていない。
- 正常に解除できた場合(`unlocked`)・まだ解除処理中(`pending`)の表示は変更なし。この自己申告UIは`timeout`/`failed`の時だけ出る。
- 動作確認: JS構文チェックのみ(ブラウザでの実機確認は未実施、次回ESP32を接続せずに決済して確認すること)。

## 実機は解除できていたのに「失敗」と表示された不具合の原因判明・修正(2026-07-07)

上記の自己申告UIを追加した直後、実際にESP32接続済みの実機でテストしたところ「実機はちゃんと動いて購入者名の表示も出ていたのに、決済ページには『実機の解除に失敗しました』と出た」という報告を受けた。`gachapon.ino`を確認し、原因は**タイミング競合**と判明(ESP32が嘘の報告をしていたわけではない)。

- `gachapon.ino`の`pollBridge()`内、解除成功/失敗の判定(`servoOk`)は`gachaServo.attached()`(起動時にサーボを正しくattachできたか)を見ているだけで、実際にカプセルが出たかどうかを検知するセンサーは無い。つまり「失敗」という判定自体は、実機が本当に失敗した場合ではなく**報告が間に合わなかった場合にも起こる**。
- 実際の時間の流れ: 購入者名のスクロール表示(最大4秒)→`unlockOnce()`(約2秒、この時点で実機は既に解除済み)→結果報告`/unlock-result`のHTTPS POST(`HTTPClient`の接続5秒+送信5秒を最大2回リトライ=最悪20秒近く)。bridge側の`UNLOCK_ESP32_TIMEOUT_MS`が15秒だったため、実機が正常に解除した後、報告のPOSTがESP32のHTTPS/ヒープ事情で少し手間取っただけで15秒を超えてタイムアウトし、「失敗」と誤判定されていた。
- `bridge/server.js`の`UNLOCK_ESP32_TIMEOUT_MS`を15秒→30秒に、`negotiate/index.html`の`UNLOCK_POLL_MAX_TRIES`を20→30(約45秒)に、それぞれ余裕を持たせて修正した。ユーザーから「どっちも45秒に揃えて」との指示を受け、`UNLOCK_ESP32_TIMEOUT_MS`をさらに30秒→45秒に変更(クライアント側は元から45秒だったので変更不要)。
- **既知の限界として残る点**: `servoOk`はソフトウェア上サーボがattachされているかのフラグでしかなく、実際にカプセルが落ちたかを検知するセンサー(リミットスイッチ等)は付いていない。そのため「success」報告自体も本当の物理的成功を保証するものではない(サーボが空転していても`attached()`はtrueになる)。今回のようにタイムアウトを広げても、実機側の物理センサーが無い以上「本当に成功したか」を100%検証する手段は無く、レシート画面の「解決したか」自己申告ボタン(上記)が最後の安全網になる。
- **参加者向けメッセージの簡略化**: 「成功したかどうかの通知は別にいい、解除できたかどうかだけ言えればいい」との要望を受け、`negotiate/index.html`の解除失敗時の文言を、`timeout`(報告が届かなかった)と`failed`(ESP32が失敗と報告)を区別せず「解除できませんでした。このtxHashをスタッフにお見せください」の1文言に統一した(参加者にとってはどちらも「受け取れたかどうか」だけが重要で、原因の違いを見せる意味は無いため)。成功時も「解除完了!」→「解除できました!」に言い回しを揃えた。管理者ページ(`admin/refill-lock.html`)側の購入履歴は原因の切り分けに使えるよう、詳細な`unlockStatus`をそのまま表示し続ける(変更していない)。
- 未実施: 実機での再現テスト(タイムアウトを45秒に広げたことで実際に間に合うようになるかは、次回の実機テストで確認すること)。

## スマホでのウォレット接続の作り直し(2026-07-07)

「スマホでのウォレット接続がまだちゃんとできてない」という報告を受け、症状の詳細確認は待たずに`negotiate/index.html`のコードを読み直し、2つの根本原因を特定して直した(具体的な失敗メッセージは受け取っていないが、いずれも「デスクトップでは動くがスマホだと不安定/繋がらない」という報告と整合する典型的な原因)。

- **【本命】QRコードをスマホの標準カメラ/Safari・Chromeで開くと、そもそも`window.ethereum`が存在せず接続できない**: これまでは「ウォレットが見つかりません。MetaMaskアプリ内のブラウザでこのページを開いてください」というエラー文言を出すだけで、参加者が自分でURLをコピーしてMetaMaskアプリに貼り直す必要があった。この手動の橋渡しが実質的な離脱点になっていたと考えられる。モバイル端末(`navigator.userAgent`で判定)で`window.ethereum`が無い場合、MetaMask公式のディープリンク(`https://metamask.app.link/dapp/<今のURL>`)へその場で自動遷移するようにした。MetaMaskインストール済みならその中のブラウザで同じページが開き直り(`window.ethereum`が使えるようになる)、未インストールならストアへ誘導される(ディープリンクサービス側の標準挙動)。デスクトップ(ウォレット拡張機能が無い場合)は従来通りのエラー文言のまま。
- **【もう1つ】接続確立前にチェーン切り替えを呼んでいた**: `ensureOptimism()`(`wallet_switchEthereumChain`)を`eth_requestAccounts`より先に呼んでいたため、まだこのサイトを「接続済み」と認識していないスマホのウォレットアプリでは、切り替え確認そのものが出ずに無反応になる余地があった(デスクトップのMetaMask拡張はここが緩く、症状が出にくかったと考えられる)。`eth_requestAccounts`を先に呼んで接続を確立してから`ensureOptimism()`を呼ぶ順序に変更。あわせて`ensureOptimism()`側も、既にOptimismに繋がっている場合は`wallet_switchEthereumChain`自体を呼ばない(`eth_chainId`で先に確認)ようにし、切り替えに対応していないウォレットでの失敗時は「手動でOptimismに切り替えてください」という文言に変えた。
- 実機確認(2026-07-07): 「①ウォレットを接続」を押した瞬間にMetaMaskアプリへ自動遷移し、アプリ内ブラウザでこのページが開き直ることを確認済み(参加者からの報告)。Renderの自動デプロイが今回だけ2コミット分遅れて反映されるタイミング差があったが、最終的に反映され、狙った通りに動作した。

### レシート画面から抜け出せず2回目が試せない不具合を修正(2026-07-07)

上記の動作確認後、「もう1回やりたい時に、前のレシート画面が出てしまい、もう1回できない」との報告を受けた。原因は、2026-07-07に「別の人が使う場合」ボタン(`clearReceiptBtn`)を削除した際、そのボタンが担っていた「レシートを消して最初からやり直す」という機能自体も一緒に失っていたこと。`tryRestoreReceipt()`はTTL(30分)以内なら無条件にレシート画面を復元し続けるため、本人が続けて2回目を買いたい場合でも接続ボタンにすら辿り着けなくなっていた。

- `negotiate/index.html`に「もう一度購入する」ボタン(`buyAgainBtn`)を復活させた。ただし文言は「別の人が使う場合」ではなく「もう一度購入する」に変更(前回削除の理由だった「実態と合わない文言」を避けつつ、機能自体は残す)。
- 表示タイミングは`unlockStatus === "unlocked"`(解除成功)、または解除失敗後に本人が「はい、受け取れました」を選んで`resolution === "resolved"`になった時のみ。未解決(`timeout`/`failed`で「まだです」を選んだ状態)の間は表示しない(問題が埋もれたまま次に進めてしまうのを防ぐため)。
- クリックすると`localStorage`の`RECEIPT_STORAGE_KEY`/`SESSION_STORAGE_KEY`を削除して`location.reload()`し、通常のウォレット接続画面から再スタートする(`clearReceiptBtn`削除前と同じ実装)。
- 動作確認: JS構文チェックのみ(ブラウザでの実機確認は未実施)。

### AIが単なる値切りの訴えでも早期に交渉を終わらせてしまう不具合を修正(2026-07-07)

実機(Render本番、AIモード)での初テストで、「500円しか持っていない」という単なる値切りの訴えに対して、AIがまだ2ターン目(最大4ターン)なのに交渉を終わらせて支払い画面に進んでしまう、という報告を受けた。

- `bridge/server.js`の`/negotiate-message`が、AIの`quote`ツール応答の`done`フィールドを`hitMaxTurns`と同格の早期終了トリガーとして扱っていた(`if (hitMaxTurns || modelDone)`)。AIモデル(既定はClaude Haiku)が、単なる値切りの訴えを「もう決着してよい」というサインと誤って解釈し、doneをtrueにしてしまうことがあった。この機能の目的は会話を楽しんでもらうことなので、`modelDone`による早期終了を廃止し、`session.turnCount >= NEGOTIATE_MAX_TURNS_NUM`(最大ターン数に達した)場合のみ確定するようにした。早く終えたい参加者は、変わらず「この価格で決める」ボタン(`/negotiate-finalize`、参加者自身の操作)で終えられる。
- `bridge/negotiation.js`のシステムプロンプトにも、「最終ターンでない・客が明確に購入に同意していないのに、会話を締めくくるような雰囲気の返答を書かないでください」という指示を追加した。サーバー側はdoneフィールドをもう見ていないが、AIの返答文(reply)自体が「会計です!」のような締めのトーンで書かれると、実際には交渉が続くのに雰曲気が食い違って不自然になるため。
- 動作確認: 構文チェックのみ(ANTHROPIC_API_KEYを使った実際の会話での確認は未実施。次回、あえて早期に「決着っぽい」発言をしてみて、実際に最大ターン数まで交渉が続くか確認すること)。
- 実機確認(2026-07-08): 上記の修正後、実際に4ターンまで交渉が続くことを確認。ただし新たに「AIが会話中に口にした金額(例: 500円)と、最終的に確定した価格(例: 466 ICHIGO)が違う。なんで?」という指摘を受けた(下記で対応)。

### AIが口にした金額と実際の確定価格がズレて見える問題への対応(2026-07-08)

これは価格計算自体のバグではない(表示価格と確定価格は一致している。2026-07-07に直した「確定時だけボーナスがこっそり適用される」不具合とは別)。原因は、会話の質(quality)ボーナスの仕組みそのもの: AIは自分が提示した金額(`session.basePrice`相当、ボーナスを含まない生の値切り価格)をそのまま`reply`内で発言するが、サーバー側はそこにさらに`quality`ボーナスを上乗せして`session.currentPrice`を下げる。AI自身はボーナス制度の存在は知っていても具体的な金額は知らない(意図的に隠している)ため、AIの発言とサーバーの確定額が一致しない。ボーナスの計算自体は正しく機能しているが、「言った額より安くなった理由」が画面に一切出ていなかったため、参加者に「言ってた額と違う、なぜ?」と思わせてしまっていた。

- `bridge/server.js`: `/negotiate-start`(新規・再接続の両方)と`/negotiate-message`のレスポンスに`bonus`(`session.basePrice - session.currentPrice`、常に0以上)を追加した。
- `negotiate/index.html`: `setNegotiationUiState()`が`bonus`を受け取り、0より大きい時だけ価格表示の下に「(会話の内容が良かったので、店番が言った金額からさらに${bonus} ICHIGO安くなっています)」という注記を出すようにした。quality自体の数値やフロア価格は今まで通り非公開のまま、ボーナスの「効果」だけを見せることで、値引きを「言ってた額と違う」という不信感ではなく「機転が良かったご褒美」として伝わるようにする狙い。
- 動作確認: ローカル(manualモード)で`/negotiate-start`の応答に`bonus: 0`が含まれることをcurlで確認済み。AIモードでの実際のボーナス発生時の表示確認は未実施(実際のANTHROPIC_API_KEYでの会話が必要)。

## 会話が終わると同時に消えてしまう問題を修正、支払い画面・レシート画面に会話ログを残す(2026-07-08)

「購入してる人の画面からは、会話が終わったらすぐ消えちゃうからさ、残しといた方が見返せて面白いよ」との指摘を受けた。これまでは交渉が確定すると`chatSection`ごと非表示にしていたため、会話の内容(AIとのやり取り)を後から読み返す手段が無かった。

- `negotiate/index.html`: `appendBubble`が積み上げるチャット内容を`chatTranscript`という配列に保持するようにした(以前はDOM上にしか無かった)。送信失敗時にバブルを取り消す箇所(2箇所)も、DOMと一緒に`chatTranscript.pop()`で取り消すよう対応。
- 支払い画面(`paySection`)・レシート画面(`receiptSection`)それぞれに、読み取り専用の会話ログ表示(`payChat`/`receiptChat`)を追加した。`renderPastChat()`という共通関数で、会話が無ければ(manualモード等)ラベルごと非表示にする。
- レシートは`localStorage`に永続化されるため、`enterReceiptPhase()`で`chatTranscript`のコピーを`receipt.transcript`として一緒に保存し、リロードしても会話ログが残るようにした。
- サーバー側フォールバック(`/negotiate-receipt`、localStorageが消えた場合の復元用)経由でも会話ログを復元できるように、`bridge/server.js`の`recentPurchases`エントリに`session.transcript`を含め、`/negotiate-receipt`のレスポンスにも`transcript`を追加した。
- 動作確認: 構文チェックとローカル(manualモード)での`/negotiate-start`応答確認のみ。ブラウザでの実際の会話→支払い画面→レシート画面での会話ログ表示確認は未実施(実際のANTHROPIC_API_KEYでの会話が必要)。

## 会話の質(quality)ボーナスの仕組みを廃止し、AIが言った価格をそのまま使う設計に変更(2026-07-08)

前回(2026-07-08)、AIが口にした金額と実際の確定価格がズレる問題に対し「ボーナス額を画面に明示する」という対症療法で対応したが、「AI店主が言った値段をそのまま使うほうが納得感がある」という、より根本的な設計変更の要望を受けた。ボーナスを見せて理由を説明するのではなく、そもそもズレが起きない仕組みに作り直した。

- **`bridge/negotiation.js`**: `quality`(0〜100の会話品質スコア)をquoteツールから完全に削除した(Anthropic/Gemini/Cloudflare Workers AIの3プロバイダすべてのtool定義、`normalizeQuoteInput`、システムプロンプトから削除)。代わりにAIへ`absoluteFloor`(会話が本当に良い時だけ裁量で下げてよい絶対下限)を新たに渡し、システムプロンプトで「通常は${floorPrice}未満にしないが、本当に会話が良ければ${absoluteFloor}まで直接価格を下げてよい。単なる値切りの繰り返しや泣き落としでは下げないこと。あなたが出すpriceがそのまま最終請求額になるので、replyで口にする金額とpriceは必ず一致させること」と明示した。
- **`bridge/server.js`**: `session.basePrice`/`session.lastQuality`フィールドと、ボーナス計算(`qualityBonus`/`priceWithBonus`)、レスポンスの`bonus`フィールドをすべて削除。`/negotiate-message`の価格更新は`session.currentPrice = min(currentPrice, max(NEGOTIATE_ABSOLUTE_FLOOR_NUM, round(result.price)))`という1行に単純化した(「前回以下」「絶対下限以上」のガードレールのみ残し、通常フロアを下回ってよいかの判断は完全にAI(プロンプト)に委ねる)。
- **`negotiate/index.html`**: 前回追加した`bonusNote`(ボーナス額の注記)表示を削除。AIが言った金額=画面の提示価格=確定価格、で一致するようになったため説明自体が不要になった。
- 設計上のトレードオフとして明記: 通常フロア(`NEGOTIATE_FLOOR_COST`)を下回ってよいかの判断が、サーバー側の数式による強制からAIの指示追従に変わった。悪意ある/不注意なプロンプトインジェクションで通常フロアを下回られるリスクはやや上がるが、`NEGOTIATE_ABSOLUTE_FLOOR`(既定0円)は引き続きコード側で必ずclampされるハードリミットなので、負の値や異常値になることは無い。教室内デモの実害としては許容範囲と判断。
- 動作確認: 構文チェックとローカル(manualモード、AIを介さないため今回の変更の影響を受けない経路)での`/negotiate-start`応答確認のみ。**実際のAIモードでの動作(AIが言った金額と確定価格が一致するか)は未確認**(本物のANTHROPIC_API_KEYでの会話が必要)。次回、あえて機転の利いた発言をして、AIが口にした金額とその場の提示価格・最終確定価格が3つとも一致することを確認すること。
- 実機確認(2026-07-08): 上記の修正後、実際にAIモードで交渉を試したところ、単なる「もっと安く」の繰り返しや「500円しか手持ちがない」という泣き落としには断固として応じず、フロア(800 ICHIGO)を維持し続けることを確認(狙い通り)。この時点で3件の追加指摘を受けた(いずれも下記で対応)。

### 支払い画面の3件の改善(2026-07-08)

- **【修正】「交渉成立!支払い画面に切り替わります…」のメッセージが、実際に切り替わった後もずっと表示されたまま残る**: `sendChatMessage()`が`setTimeout`前に`showStatus(...)`でこのメッセージを出すが、その後`enterPaymentPhase()`に切り替わってもステータス表示を消していなかったため。`enterPaymentPhase()`の末尾で`showStatus("", "")`を呼んで消すようにした。
- **【修正】支払いボタンが会話ログより上にあり見落としやすい**: `paySection`内の並び順を、会話ログ(「ここまでの会話:」)→確定価格→支払いボタン、の順に入れ替えた(以前は逆で、ボタンの下に長い会話ログが続いていたため、会話を読んでいるとボタンを見失いやすかった)。会話を読み終えた流れの延長で自然にボタンに辿り着くようにする狙い。
- **【修正】最終ターンでもAIが「〜しようか」「〜でどう?」のような提案・迷いの残る口調のままで、断定的に締めていない**: `bridge/negotiation.js`のシステムプロンプトで、最終ターン時の指示を強化。「まだ迷っている・提案しているだけに聞こえる言い回しは絶対に使わないでください。『よし、◯◯ ICHIGOで決まりだ!』のように、迷いのない断定的な口調で最終価格をはっきり宣言してください」と明示した。
- 動作確認: 構文チェックのみ。3件ともブラウザでの実機確認は未実施(最終ターンの口調変化は本物のANTHROPIC_API_KEYでの会話が必要)。
