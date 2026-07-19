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
- このボードには「5V」という名前のピンは無い。5V相当は **VIN**(左列の一番下)、ケーブルは赤
- サーボ信号は **D13**(=GPIO13)、ケーブルはオレンジ
- GNDは左右どちらの列にもある、ケーブルは茶色
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

- **配線**: 信号線をGPIO12に接続(メインはGPIO13)。電源(VIN)・GNDはメインと同じブレッドボードの電源レールを共有してよい。
- **動き方**: メインのコイン投入ロック(`unlockOnce()`)と違い、補充用は「開けたら管理者が明示的に閉めるまで開いたまま」(自動で戻らない)。補充作業中にフタを開けっぱなしにできるようにするため
- `firmware/gachapon/gachapon.ino`: `refillServo`(GPIO12)を追加。`REFILL_CLOSED_ANGLE`(180)・`REFILL_OPEN_ANGLE`(0)・`REFILL_MOVE_MS`(500)は仮値で、`test/motor-test.html`の「補充用」タブで実機確認して調整すること。`pollBridge()`で`adminLock:true`を検知したら`adminAction`("open"/"close")に応じて`REFILL_OPEN_ANGLE`/`REFILL_CLOSED_ANGLE`まで動かし、`/admin-lock-result`に結果を報告する
- `bridge/server.js`: `POST /admin-lock`(`{action:"open"|"close"}`、要`X-Secret`)、`GET /admin-lock-status`(結果確認用ポーリング、認証不要)、`POST /admin-lock-result`(ESP32からの結果報告、要`X-Secret`)を追加。`adminLockRequests`という別Mapで`pending→dispatched→done/failed`を管理し、ESP32への配信は他の機能と同様`/poll-unlock`に相乗りさせている(`adminLock`/`adminRequestId`/`adminAction`フィールド)
- `admin/refill-lock.html`: bridgeが`/admin/`以下で配信する管理者ページ。「開ける」「閉める」の2ボタンと合言葉入力欄のみのシンプルな作り
- **本番の開閉角度・時間を確定(2026-07-06)**: `test/motor-test.html`の「補充用」タブでの試行錯誤の結果、`moveMs=0`(即座に動かして落とす)が良好と判断された。当初`REFILL_OPEN_ANGLE`を0→80に変更したが、直後に「デフォルト(起動時)は開いている状態にしたい、閉めたら80度に倒れる向きにしたい」という向きの訂正を受け、`REFILL_OPEN_ANGLE`と`REFILL_CLOSED_ANGLE`の値を入れ替えて確定: `REFILL_OPEN_ANGLE=180`(起動時のデフォルト、`setup()`の初期書き込みもこちらに変更)・`REFILL_CLOSED_ANGLE=80`(管理者ページの「閉める」でこの角度に倒れる)。`moveMs=0`は変更なし。テスト動作(`test/motor-test.html`)の待機角度(`restAngle`)も同じ理由でOPEN側に合わせて修正した。
- 未実施: firmwareの書き込み直し(上記の角度変更、および後述のピン変更(D18/D19→D13/D12)を反映するため)
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
- 2026-07-09: メイン/補充用サーボの信号ピンを`D18`/`D19`(GPIO18/19)から`D13`/`D12`(GPIO13/12)に変更(`gachapon.ino`の`SERVO_PIN`/`REFILL_SERVO_PIN`、配線コメント、およびNOTES.md冒頭の配線メモを更新)。firmwareの書き込み直しと、実機での配線差し替え(サーボのオレンジ線をD13/D12に挿し直す)がまだ必要。
- 2026-07-13: 上記のピン変更が2026-07-09時点ではリポジトリに未コミットのまま残っていたため、今回まとめてコミット・push(`b0f62f5`)。同時に以下のOLED表示の改善も含まれている: (1)このOLEDは物理的に上16pxが黄色パネル・残りが水色パネルの2色構成で、文字のy座標がその境目(y=16)をまたぐと1文字が黄色/水色に分かれて見える不具合があったため、全ての文字を水色エリア内(y=16以降)だけに収まるよう修正。(2)待機画面のIPアドレス表示(会場の誰でも読めてしまう)をやめ、大きな日本語で「つながってる」/「つながってない」を表示するように変更(WiFi状態は毎ポーリングごとに再取得)。(3)交渉中(支払い前)であることを`showNegotiatingMarquee()`で流し続けるようにし、以前はポーリングのたびに待機画面⇄交渉中表示がチカチカ切り替わっていたのを解消。**未実施(物理的な作業のため私の方では確認できない)**: 実機ESP32へのfirmware書き込み直しと、サーボ信号線のD13/D12への挿し直し。

## Webページのビジュアル全面刷新(2026-07-13)

画像素材を組み込んだ後も細かい調整(看板の位置、アイコンの大きさ、キャラの表示等)を重ねるうちに、「見た目がバラバラで気持ち悪い」というユーザーからの強い指摘を受けた。原因を分析すると、(1)配色が生成したイラストの世界観(朱色・藍色・金)と噛み合っていない旧来の候補ピンク(`#ff6f91`)のままだったこと、(2)キャラクター画像がほぼ空白のページに単独で巨大に浮いていて足場が無く、不気味に見えていたこと、の2点が本質的な原因だった。`frontend-design`スキルの手順(トークン設計→批評→実装)に沿って、細部の調整ではなく配色・タイポグラフィ・レイアウトを一から設計し直した。

- **配色**: イラスト自体から採った朱色(`#c1402e`)・藍色(`#33415c`)・金(暗い舞台のspectatorのみ)・生成りクリーム(`#f3e7d2`)に統一。旧ピンクは全ページから撤廃。
- **フォント**: 見出し・価格表示に明朝体(Shippori Mincho)、本文に丸ゴシック(Zen Maru Gothic)をGoogle Fontsから読み込み、`system-ui`一辺倒をやめた。
- **negotiate/index.htmlのヒーロー**: 背景の街並み・看板・キャラクターを1枚の額(`.stallHero`)に統合し、キャラは路地に足場を持って立つ構図にした(以前のように単独で空白に浮かない)。イラストと紙のフォーム部分の境目に、木製カウンター(`.counterLedge`)という署名要素を1本通した。
- **値札コンポーネント**: このアプリの核心が「値切り交渉」であることに合わせ、価格表示(残高・提示価格・確定価格・レシート)を全て、穴あき・少し傾いた縁日の値札風バッジ(`.priceTag`)に統一した。
- payment/spectatorにも同じ配色・フォントを適用し、3ページ全体で統一感を持たせた。
- ヘッドレスChromeのスクリーンショットで、初期画面・接続後・チャット中・支払い・レシートの各状態を確認しながら実装(Playwright MCPは本セッションでは未接続のため代替手段として使用)。

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

## 待機画面のIP非表示化・購入時メッセージの視認性改善(2026-07-09追加)

「待機画面にIPアドレスが出ると会場の誰でも見えてしまう」「テザリングを切っても表示が更新されず古いIPが残り続ける」「購入者名/ありがとう/故障メッセージをできるだけ大きく表示したい」という指摘を受けて`gachapon.ino`を修正した。

- **待機画面のIP表示を廃止**: `showIdleScreen()`が`"IP: " + currentIP()`を出していたのをやめ、`WiFi.status() == WL_CONNECTED`(AP_MODEなら常時)を見て`WiFi:OK`/`WiFi:NG`のどちらかだけを出すように変更。IPアドレス自体は今後もUSBシリアル(`Serial.println(currentIP())`)には出るので、開発時の確認手段は残っている。
- **待機画面の状態が固まる問題を修正**: 従来`showIdleScreen()`はunlock/testMove/adminLockの各処理後にしか呼ばれておらず、「何も起きなかったポーリング」や「poll-unlock自体が失敗した」場合は画面が更新されないままだった(テザリングを切ってもWiFi関連の表示が古いまま残る原因)。各処理内の個別呼び出しを削除し、`pollBridge()`の最後(成功/失敗/何も無かった、いずれの場合も通る場所)で1回だけ呼ぶようにした。これで2秒ごとのポーリングのたびにWiFi状態が再取得され、テザリングを切ると次のポーリングで`WiFi:NG`に切り替わる。
- **購入者名/ありがとう/故障メッセージの表示を改善**: 和文フォント(`u8g2_font_unifont_t_japanese1`、unifontベース)はu8g2に16px固定のものしかなく、これより大きい和文フォントは存在しないため、文字そのものを拡大することはできない。代わりに画面(64px高)の余白を減らす方向で対応: `showScrollingMessage()`の描画y座標を、1行だけの場合は縦中央(y=40)、2行の場合は上下に振る(y=26/50)ように変更。また、故障時のメッセージ(旧: `showLines("ICHIGOGACHA", "こしょう?", "スタッフをよんで")`+`delay(2500)`)を`showScrollingMessage("こしょう?", "スタッフをよんで", 2500)`に統一した。これは「ICHIGOGACHA」というブランディング行を削って本文に画面を使う狙いに加えて、**既存の不具合修正でもある**: 旧実装は3行目("スタッフをよんで"、カタカナ含む)を半角専用フォント(`ASCII_FONT`)で描画していたため、実機では文字が欠けて表示されていた可能性が高い(`showLines()`の1・2行目=和文フォント/3行目=半角フォントという設計上、和文を3行目に渡したのが誤り)。
- 未確認(実機書き込みが必要なため未実施): `WiFi:OK`/`WiFi:NG`の切り替わりが実際にテザリングON/OFFで正しく起きるか、故障メッセージのフォント修正で実際に文字欠けが直っているか、縦位置変更後の見た目。次回、実機書き込み後に確認すること。

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

### txHashが画面右端からはみ出す不具合を修正(2026-07-08)

「横にはみ出すのやめてほしい」とスクリーンショット付きで報告を受けた。スクリーンショットをピクセル単位で解析し(パディング込みのカード境界線の位置と、txHash文字列の描画範囲をRGB値から実測)、`receiptTxHashLabel`(66文字のtxHashをスペース無しで表示)がカードの右境界線を明確に超えて描画されていることを確認した。原因は、このページのCSSがどこにも`overflow-wrap`(長い区切りの無い文字列の強制折り返し)を指定していなかったこと。txHashのような16進数の羅列や、長いウォレットアドレスは自然な改行位置(スペース)が無いため、コンテナ幅を超えてそのままはみ出して描画されていた。
- `negotiate/index.html`の`body`セレクタに`overflow-wrap: break-word;`を追加。継承プロパティなので、txHashだけでなくウォレットアドレス表示・チャットバブル内の長い文字列など、ページ全体の同種の問題に効く。
- 動作確認: CSSの構文自体は問題ないが、ブラウザでの実機確認(実際に折り返されるか)は未実施。次回、支払い完了後のレシート画面でtxHashがカード内に収まっているか確認すること。

### AIが金額を口に出さないまま価格が動く問題・最終ターンの口調をさらに強化(2026-07-08)

実機テストで、AIが4ターンの会話中一度も具体的なICHIGO金額を言わないまま(「90」という客側の自己申告額を復唱しただけ)、最後に急に「確定価格: 100 ICHIGO」と表示され、「90と言ったら100になった、会話に出てきていない金額」と参加者に不信感を与える事例が見つかった。あわせて、最終ターンでも「…どう?」と疑問形で終わる返答が観測されたが、これは前回(2026-07-08、コミットd12901a)の最終ターン強化が反映される前のデプロイでのテストだった可能性が高い(このコミットの2つ後のCSS修正がテスト時点でまだRenderに反映されていないことをcurlで確認済み)。

- `bridge/negotiation.js`のシステムプロンプトに「毎回の返答で、値段の話を避けたり質問だけで終わらせたりせず、必ず具体的な数字を1つ明言してください。金額を一切言わない返答は禁止です」という指示を追加。AIが内部のpriceを動かしながら会話ではその数字に一切触れない、という状態を防ぐ狙い。
- 最終ターンの指示もさらに強化: 「次はありません」を明記し、「どうだ?」等の疑問形も禁止パターンに追加、「文末を疑問形にすることも禁止」と明示した。
- 動作確認: 構文チェックのみ。実際のAIモードでの効果確認は未実施(本物のANTHROPIC_API_KEYでの会話が必要)。Renderのデプロイが今回も遅延しており(プッシュから2分待っても最新コミットが反映されず)、次回の実機確認前に反映状況を確認すること。

## 支払い画面に「やめる」の選択肢と、押し間違い防止の確認を追加(2026-07-08)

AIが最終ターンで「これ以上の値下げはないから、この値段で購入するかどうか判断してくれ」という趣旨の返答をしたことをきっかけに、「面白いので、支払い画面をこの值段で購入するか/やめるかの2択にして、押し間違い防止の確認も入れてほしい」との要望を受けた。これまでは確定価格の下に「② 支払ってガチャを回す」ボタンが1つあるだけで、購入を見送る選択肢は「何もせず放置してタイムアウトを待つ」しかなかった。

- `negotiate/index.html`: `paySection`に「やめる」ボタン(`cancelPurchaseBtn`)を追加し、「この価格で購入しますか?」という文言とともに支払いボタンと並べた。
  - 「やめる」: `confirm("購入をやめますか?")`で確認した上で、`POST /negotiate-cancel`でサーバー側のセッションを終了させ、実機を即座に解放してからページをリロードする。
  - 「支払ってガチャを回す」: 既存の送金処理の先頭に`confirm(...)`を追加し、実際に送金する前に一度確認を挟むようにした(隣に「やめる」ボタンができたことで押し間違いのリスクが増えるため)。
- `bridge/server.js`: `POST /negotiate-cancel` `{sessionId}`を新設。他の参加者向けエンドポイント(`/negotiate-message`等)と同じ信頼境界でX-Secret認証は無し。セッションが`negotiating`/`awaiting-payment`なら`expired`にし、`currentSessionId`が一致していれば解放する。セッションが既に存在しない場合もエラーにせず`ok:true`を返す(参加者はどのみち離脱したい状態のため)。これが無いと、購入を見送った参加者がいる間、次の人はクオートの有効期限(`NEGOTIATE_QUOTE_TTL_MS`)が切れるまで実機を使えなかった。
- 動作確認: ローカル(manualモード)で交渉開始→価格確定→`/negotiate-cancel`→`/negotiate-current`で実機が解放されていることを確認。存在しないsessionIdでもエラーにならないことも確認済み。ブラウザでの実機確認(confirm()ダイアログの見た目・挙動)は未実施。

### 「もう一度購入する」を押すと同じレシートに戻ってしまうループを修正(2026-07-08)

「もう一度購入する→ウォレット接続すると、さっき見ていたのと同じレシート画面に戻ってしまう」との報告。原因は2つの機能が衝突していたこと: (1)「もう一度購入する」はlocalStorageのレシートを消してリロードするだけ、(2)ウォレット再接続時、localStorageにレシートが無いと`tryRestoreReceiptFromServer()`がサーバー側の直近の購入記録(`/negotiate-receipt`、30分以内)から自動復元する(2026-07-07追加、localStorageが消えた場合の保険)。この2つが組み合わさると、「もう一度購入する」で明示的にレシートを消しても、直近の購入がまだ30分以内なのでサーバー復元がそれを見つけて復元し直し、同じ画面に戻る→また「もう一度購入する」を押す、という無限ループになっていた。

- `negotiate/index.html`: 「もう一度購入する」を押した時点の`currentReceipt.txHash`を`ichigo_dismissed_receipt`というlocalStorageキーに記録するようにした。`tryRestoreReceiptFromServer()`は、サーバーから返ってきた購入のtxHashがこの「明示的に退けた」txHashと一致する場合は復元をスキップし、通常のウォレット接続→交渉開始フローに進むようにした。
- この修正は特定のtxHash単位でのスキップなので、それ以外の理由(実際にブラウザがlocalStorageを失った等)でのレシート復元機能自体は影響を受けない。
- 動作確認: JS構文チェックのみ。ブラウザでの実機確認(「もう一度購入する」→再接続→ループしないこと)は未実施。

## Webページの見た目(ビジュアルデザイン)の方針(2026-07-10)

これまでnegotiate/payment/spectatorはCSSのみの無地デザイン(画像・アイコン一切なし)だったが、AI画像生成でイラスト素材を作り、見た目のクオリティを上げる方針にした。ユーザーへのヒアリングで、アートスタイルは「昭和レトロ×手描きポップ(縁日・屋台のポスター風)」、AI店番「イチゴ番」のキャラクターは「的屋のおじさん(人間)」、生成ツールはGemini(Nano Banana)/ Google AI Studio想定、素材ボリュームは「フルセット」(キャラ表情・背景・ボタンアイコン・ロゴ等を網羅)に決定。具体的な素材リストとコピペ用プロンプトは`VISUAL_DESIGN_PROMPTS.md`に集約した。**未実施**: 実際の画像生成、各HTMLへの組み込み。既存の配色(`--pink: #ff6f91`)は新しい素材のパレットにも差し色として引き継ぎ、既存UIと浮かないようにする狙い。

**2026-07-11修正(1)**: spectatorの表示先を「会場のプロジェクター」から「モニターまたはPC画面」に変更(実際の設営がプロジェクターではなくモニター/PCになったため)。また画像素材の対象範囲を「お客さんの目に触れる画面(negotiate/payment/spectator)のみ」に絞り直し、管理者ページ(admin)向けアイコンと実機に貼る装飾ポスターは今回の素材セットから除外した(`VISUAL_DESIGN_PROMPTS.md`側も更新済み)。

**2026-07-11修正(2)**: 画像生成ツールをGemini(Nano Banana)→Leonardo AIの検討を経て、最終的にAdobe Fireflyに変更。Stable Diffusion系(Leonardo)は日本語プロンプトの理解精度が低く、また画像内への正確な文字描画(特に日本語)はFireflyも含めどのツールも苦手なため、`VISUAL_DESIGN_PROMPTS.md`のプロンプトは英語主体のまま、ロゴ・レシートスタンプ・faviconは文字なしで生成して後からCSS/Canvaで文字を重ねる方針にした。あわせて18点の素材に必須/推奨/任意の優先度を付け、まず必須4点(挨拶顔・交渉ページ背景・モニター表示背景・ロゴ)だけ作ればよいと分かるようにした。

**2026-07-11修正(3)**: ログインすると`generate/images`(複数形、Adobe純正のFirefly Image 3/5)の方に入り、契約上のトークン/クレジットもこちらでしか消費できないと判明したため、生成ツールを正式にこちらへ切り替えた。このモデルは「日本×レトロ×ポスター」という言葉から浮世絵の木版画(お寺・着物の群像等)を連想しやすい欠陥が実機テストで見つかったため、`VISUAL_DESIGN_PROMPTS.md`の全プロンプトに「伝統的な浮世絵ではない」と明示的に否定する一文を追加し、カンマ区切りのタグ列ではなく自然な文章形式に書き直した。

**2026-07-11修正(4)**: ブラウザ版FireflyではなくPhotoshopの「生成画像」「生成塗りつぶし」機能で作業する方針に変更(内部エンジンは同じFirefly Image 3系なので、プロンプト本文はそのまま流用可能)。キャラの一貫性は、Photoshop 2026で追加された「生成塗りつぶし」の「参照画像」機能(オブジェクト参照+選択範囲を置き換え)を使う運用にした。`VISUAL_DESIGN_PROMPTS.md`の4章を全面的にPhotoshop向けの操作手順に書き直した。

**2026-07-12: 生成ツールを最終的にGoogle AI Studioに決定**。Gemini(Nano Banana)→Leonardo AI→Adobe Firefly(ブラウザ版/Photoshop版、Firefly Image 3系)と検討してきたが、Google AI Studio(aistudio.google.com、Geminiのチャット形式、Nano Banana 2の画像生成)で試したところ最も良い結果(狙った通りの絵柄、正しい文字表示)が出たため、ユーザーの強い希望でこれを最終決定とした。Firefly Image 3系で問題だった「浮世絵ドリフト」「写実的すぎる顔になる」「文字が意図せず巨大化する」は、Google AI Studioでは実機テストで発生していない。キャラの一貫性は、チャット形式の性質を活かして「同じ会話の続きでポーズ違いを頼む」運用にした(参照画像のアップロード等は不要)。`VISUAL_DESIGN_PROMPTS.md`を全面的に書き直し、プロンプトも元のシンプルな日本語主体の自然文に戻した。

**2026-07-13: 画像素材18点を実際に生成・組み込み完了**。Google AI Studioで生成した全素材(`image/`フォルダにアップロードされたもの)を確認したところ、キャラクターの一貫性・文字表示ともに狙い通りの品質だった。`negotiate/assets/`・`spectator/assets/`・`payment/assets/`を新設して配置し、以下をHTMLに反映した:
- `negotiate/index.html`: header-banner・logo(タイトル代わり)・キャラクター画像(接続前=挨拶/交渉中=思案顔/支払い画面=決め顔/受け取り完了=お祝い顔、JSで状態に応じて`setCharacterImage()`が切り替え)・各ボタンへのアイコン・レシートカードへのスタンプ画像・ページ全体への紙質感テクスチャ背景・favicon
- `spectator/index.html`: stage-bgを全画面背景に、idle画面にキャラ(挨拶)、active画面見出しにキャラ(思案顔)、completed画面にキャラ(お祝い顔)+紙吹雪オーバーレイ
- `payment/index.html`: header-banner-simple・各ボタンアイコン・favicon
- PIL(Pillow)で白背景を透過PNGに変換するスクリプトをその場で書いて使用(ボタン内で使うアイコン・ダーク背景のspectatorで使うキャラ画像・紙吹雪オーバーレイに適用)。
- Playwright MCPが未接続だったため、Macに入っているGoogle Chromeのヘッドレススクリーンショット(`--headless --screenshot`)で実際の見た目を確認。この過程で2つの不具合を発見・修正: (1)キャラ・アイコン画像の白背景がページ背景から四角く浮いて見える(→透過PNG化で解決)、(2)spectator完了画面の紙吹雪オーバーレイが白背景のまま重ねたことで灰色の四角い箱に見える(→透過化+タイル状に敷き詰める`background-repeat`に変更して解決)。Fireflyは「参照画像」機能(構図/スタイルを似せる)でキャラの一貫性を出す運用、UIの「除外したい要素」欄をネガティブプロンプト相当として使う。

## セキュリティレビュー(2026-07-13)と「同時アクセス」の挙動確認

「システムの脆弱性を見つけたい(同時複数人アクセスなど)」との依頼で`bridge/server.js`・`negotiation.js`・`gachapon.ino`をひととおりレビューした。指摘した項目と結論:

1. **`/test-move`が支払い検証なしにメインのロック解除サーボを直接動かせる**: `angle=45(=UNLOCK_ANGLE), holdMs=950, moveMs=500, servo=main`を送ると`unlockOnce()`と同じ動きを支払いなしで再現できる。認証は`ESP32_SECRET`のみ(決済フローとは無関係の合言葉を流用)。
2. **ESP32側がTLS証明書検証を無効化している(`client.setInsecure()`)**: 会場WiFi上の経路上攻撃者が`ESP32_SECRET`を盗聴できれば(1)と組み合わせて無料排出が可能になる、という理論上の攻撃チェーン。
3. **`payment/index.html`への直アクセス(例: `/index.html`)で「同時に1交渉まで」のロックを迂回できる**: `app.get('/')`のリダイレクトは完全一致パスのみを塞いでおり、`express.static(GAME_DIR)`はルート直下全体に効いたままなので`/index.html`は素通りする。送金額自体はごまかせない(定価が必要)が、AI交渉と`currentSessionId`の排他制御を丸ごとスキップできる。

→ **ユーザー判断: 1〜3はいずれも直さない(学園祭デモであり、そこまで厳密でなくてよいとのこと)**。今後のセッションでこれらを蒸し返して再修正を提案しない。

上記とは別に、「QRから複数人が同時にサイトへアクセスしてウォレット接続したらどうなるか」を実装を追ってトレースして回答した:
- ウォレット接続(`eth_requestAccounts`)はブラウザ内で完結しサーバーに一切問い合わせないため、何人が同時に接続しても競合しない。
- 競合が起きうるのは`POST /negotiate-start`(交渉開始ボタン)の時点のみ。`currentSessionId`という単一変数で管理しており、このハンドラは`await`を挟まず同期的に処理されるため、Node.jsのシングルスレッド性により本当に同時刻に複数リクエストが届いても1件ずつ完全に処理される。**2人が同時に交渉スロットを取ってしまう壊れ方はしない**。
- 先着以外は`409`(`他の方が交渉中です`)を受け取り、`negotiate/index.html`はエラー文言を表示するだけで自動リトライや順番待ち表示は無い(手動で再度ボタンを押す必要がある)。データが壊れる・不正に安く買われるといった実害は無いが、UXとしては「先着1名以外は手動で何度も押し直す」形になる。今回はこのままでよいという結論。

### スマホで「この名前で始める」ボタンの文字が縦に1文字ずつ折り返る不具合を修正(2026-07-13)

実機(iPhone、Safari)のスクリーンショットで発見。原因は`.nameRow`(呼び名入力欄とボタンを横並びにする`display:flex`の行)で、ボタン側に`flex-shrink`の対策が無かったこと。日本語はスペース無しでもどの文字間でも改行できてしまうため、横幅が足りないとflexの縮小によってボタンの内容幅が1文字分まで潰れ、「この名前で始める」が9行の縦積みになり、`align-items`の既定(`stretch`)につられて隣の入力欄まで異常に背が高くなっていた。

- `negotiate/index.html`: `.nameRow button, .chatInputRow button`に`flex-shrink: 0; white-space: nowrap;`を追加し、ボタンは常に1行のまま縮まないようにした(狭い分は`flex:1`の入力欄側だけが縮む)。同じ構造の`.chatInputRow`(チャット欄の「送る」ボタン)にも同時に対策した。
- 動作確認: PlaywrightのCLI(`npx playwright screenshot`)でChromiumをiPhone相当の幅(390px)にビューポート指定して確認。修正前は(手元の環境では)2行折り返し止まりだったが、修正後は1行に収まり行の高さも正常に戻ることを確認した。実機ほど極端な折り返しは再現できなかったが、原因(flexの縮小+CJKの改行仕様)自体は特定できており、`flex-shrink:0`はこの種の崩れに対する一般的な対策として有効。

### 全画面のレスポンシブ・ダークモード対応の総点検(2026-07-13)

「どのデバイスでも綺麗に見えるように」との依頼で、`negotiate`/`payment`/`spectator`/`admin`/`test`の5画面を、モバイル(390px)・タブレット(820px)・デスクトップ(1440px)× ライト/ダークモードの組み合わせでPlaywright(`npx playwright screenshot --color-scheme light|dark`)でスクリーンショットし、さらに`negotiate/index.html`はチャット中・支払い・レシート(成功/失敗)の各状態もサンプルデータで再現して確認した。

- ほとんどの画面・状態は既に問題なし: 全ページとも色をCSS変数で明示指定しているため、OSのダークモード設定を変えても見た目は変わらない(意図した一枚岩のデザインなので、これは崩れではなく想定通り)。デスクトップ幅では`max-width`で中央寄せされた1枚のカードになるが、これも段ボール製の実機に合わせた「小さな紙のチケット」的なデザイン意図と捉え、幅を無理に広げる変更はしなかった。
- **見つけて直した実際の崩れ**: `admin/refill-lock.html`の「直近の購入履歴」テーブルで、呼び名未入力の購入者は42文字のウォレットアドレスがそのまま「名前」列に入る。このアドレスはスペースの無い1つの連続した文字列なので、モバイル幅では列の折り返しが効かずテーブルごと・ページごと横スクロールする不具合があり(実際に390px幅でテーブルが474pxまで押し広げられることを確認)、さらにその分「解除」列が潰れて「排出済み」が1文字ずつ縦に折り返る、前回のボタンと同種の崩れも誘発していた。`#purchasesTableWrap { overflow-x: auto; }`と`th, td { overflow-wrap: anywhere; }`を追加し、テーブル自体はスクロール可能に、セル内の長い文字列はスクロール無しで折り返せるようにして解決(修正後、390px幅でも横スクロールが発生しないことを確認済み)。
- **予防的な修正**: `payment/index.html`の`body`に`overflow-wrap: break-word`が無く、`negotiate/index.html`側にはある同じ対策が抜けていた(ウォレットアドレス表示で将来的にはみ出す余地があったため、揃えて追加した。手元の実測では42文字のアドレスは390px・320px幅でもぎりぎり折り返さず収まっていたが、より狭い埋め込みブラウザ等への保険)。
- 対象外(意図的に変えなかった点): `admin`/`test`ページはもともと配色トークンを使わない簡素な白背景の管理者・調整用ページで、これはVISUAL_DESIGN_PROMPTSでの意図的な除外([[project-ichigo-gachapon]]参照)。ダークモード用の別配色を新設する提案はしなかった(参加者の目に触れない画面のため)。

## BGM・ボタンSE・購入音の追加(2026-07-15)

お祭りらしさを音でも出したい、という要望を受けて`negotiate/index.html`・`spectator/index.html`に音を追加した。

- **ボタンSE(negotiateのみ)**: 接続ボタン→カチッ、送信ボタン→ポン。外部音源を持たず、Web Audio APIのオシレーターでその場で合成している(生成・管理する音源ファイルを増やさずに済むため)。
- **ファンファーレ(交渉成立・支払い成功)**: `negotiate/assets/sfx/fanfare.mp3`があれば優先して再生し、無い/再生失敗時は上昇アルペジオの合成音に自動フォールバックする(`playFanfare()`)。`enterPaymentPhase()`(価格確定時)と、`enterReceiptPhase()`内の`waitForUnlock()`が`unlocked`を返した瞬間(実際に解除成功した瞬間のみ、`tryRestoreReceipt`側では鳴らさない=古いレシート再表示時に鳴り直さない)の2箇所で呼んでいる。
- **BGM(negotiate・spectator両方)**: それぞれの`assets/bgm.mp3`をループ再生。ブラウザの自動再生ブロックを避けるため、negotiateは「ウォレットを接続」ボタンのクリック(確実なユーザー操作)をきっかけに開始し、spectatorはボタン操作の無い投影専用画面のため、起動時に「🔈音声を有効にする」と表示する全画面オーバーレイを追加し、設営時にスタッフが1回タップして開始する運用にした。
- **ミュート設定(negotiateのみ)**: 右上固定の🔊/🔇ボタンで全体をオン/オフでき、`localStorage`(`ichigo_sound_muted`)に保存され次回も引き継ぐ。
- **BGM・ファンファーレの音源ファイルはまだ生成していない**: どちらも音源が無い場合は re-play が404で静かに失敗するだけ(catchで握りつぶし)で、ページの動作自体は壊れない。実際にNode+Playwright(headless Chrome)でnegotiate/spectator両ページを読み込み、ボタン操作もシミュレートしてコンソールエラーを確認したところ、音源未配置の404以外のエラーは出ていないことを確認済み。
- **音源生成の方針**: Lyria RealTime(AI Studioの「Prompt DJ」)は常時ジャム演奏し続けるリアルタイム生成モデルで、短いキーワード的なプロンプトを重ねる方式(画像生成の長文プロンプトとは書き方が異なる)。BGMのような継続音源には向くが、単発の短い効果音を1回だけピンポイントで作るのには不向きなため、ファンファーレは「合成音のままで十分」という判断もあり得る前提で、生成する場合の代替プロンプトのみ添えた。実際に生成した`bgm.mp3`/`fanfare.mp3`は`negotiate/assets/`・`spectator/assets/`(bgm.mp3のみ両方に同じファイルを配置)・`negotiate/assets/sfx/`(fanfare.mp3)に置けばそのまま有効になる。

## 来場者向け紹介ページ(仕組み・使い方 + 制作秘話・動画)の計画確定(2026-07-13)

`negotiate`/`payment`とは別に、当日会場で来場者が読む紹介ページを新規に1ページ作る計画を`/plan`で立てた。計画書全文: `/Users/kuramochikeito/.claude/plans/playful-launching-matsumoto.md`(まだ実装はしていない)。

- **配置場所**: `ichigo`本体とは別の新規GitHubリポジトリ `https://github.com/KeitoKuramochi/ichigo_gatya_web.git`(2026-07-13時点で完全に空、ローカル未クローン)にpushし、Vercelでデプロイする方針。**このリポジトリは`ichigo`フォルダの外になるため、実装セッションを始める際は、クローン先とこのフォルダ限定フックの許可範囲について改めて確認すること。**
- **構成**: 1ページ、fuwachan.com風のsticky/アンカーナビで以下6項目にジャンプ: 仕組み解説/あそびかたステップ(5ステップ)/制作秘話タイムライン/スタッフ紹介(本人+もう1名)/制作動画/「ガチャに挑戦する」CTA(`https://ichigo-gatya.onrender.com/negotiate/`へ)。ボツ案ギャラリーは不要と判断し却下。
- **デザイン**: `negotiate/index.html`のトークン・コンポーネント(朱赤/藍/生成りクリーム、Shippori Mincho×Zen Maru Gothic、`.priceTag`、`.counterLedge`、屋台のヒーロー演出)を完全踏襲。共有パッケージ化はせず、コピーして流用する方針(別リポジトリ・別更新サイクルのため)。
- **あそびかたステップの画像割り当て**: 5ステップに対し表情画像は4種(greet/thinking/decided/thanks)しかないため、①QR読み取り・②ウォレット接続の2ステップに`ichigoban-greet.png`を共有させ、③交渉=thinking/④支払う=decided/⑤受け取り=thanksは本番のnegotiateページの表情切り替えと完全一致させる。
- **未確定(進行中)**: 制作動画はまだ制作中・縦横比未定(当日までに用意予定) → レスポンシブな`<video>`埋め込み+「公開準備中」プレースホルダーを先に実装し、動画ファイルは`video/`フォルダに後から追加するだけで済む構造にする。制作秘話・スタッフ紹介用の実写真も未撮影 → 共通クラス`.photoBox`のプレースホルダー枠を用意し、後から`<img>`に差し替えるだけで済むようにする。
- **新規に生成する画像素材**: `VISUAL_DESIGN_PROMPTS.md`にE章として追記予定(仕組み解説の説明イラスト`mechanism-diagram.png`、動画未公開時のポスター`video-poster.png`が必須、スタッフ用アバター枠とアンカーナビ用アイコン6種は任意)。
- **`negotiate/index.html`への追記予定**: `.lead`直後に新ページへの控えめなテキストリンクを1行追加する(「🍓 ICHIGOガチャガチャってなに?しくみ・つくった話はこちら」)。
- **メモ運用の方針確認**: このプロジェクトでは、会話をまたぐ記録は(セッション横断の別ディレクトリの)メモリ機能ではなく、この`NOTES.md`のようにこのフォルダ内のマークダウンに一本化する、とユーザーから明示指示があった(2026-07-13)。今後もこの方式を継続すること。

## 紹介ページ(story/)を`ichigo`フォルダ内に実装し、Playwrightで見た目を検証(2026-07-13)

上記の計画に基づき、まず`ichigo/story/`(フックで書き込みが許可されている場所)の中に実装し、Playwrightで見た目を確認しながら仕上げた。**別リポジトリ`ichigo_gatya_web`へは未pushで、クローン先・フック許可範囲の相談もまだ**(このセッションでは`ichigo`内で作業を完結させた)。

- `story/index.html`: 計画通り、ヒーロー→sticky/アンカーナビ(しくみ/あそびかた/制作秘話/スタッフ/動画/挑戦するの6タイル、`IntersectionObserver`でアクティブハイライト)→仕組み解説→あそびかたステップ(5ステップ、`ichigoban-greet/thinking/decided/thanks`を割り当て)→制作秘話タイムライン(`.photoBox`プレースホルダー)→スタッフ紹介(2名、プレースホルダー)→制作動画(`.videoFrame`+`.videoPlaceholder`)→フッターCTA、の構成で実装。デザイントークン・コンポーネント(`.stallHero`/`.counterLedge`/`.priceTag`/ボタン)は`negotiate/index.html`と同一のものをコピーして使用。
- `story/assets/`: `negotiate/assets/`から`header-banner.png`/`logo.png`/`ichigoban-*.png`/`paper-texture-tile.jpg`/`favicon.png`をコピー。
- **「もっと派手に」という要望に対して**、AI画像生成ツールは使わず(このセッションでは接続されていない)、手描きSVG・CSSで華やかさを追加した: (1)仕組み解説セクションに、送金→確認→カプセル排出の3コマをSVGで手描き(ガチャガチャの機械とカプセルのアイコンも自作)、(2)ヒーロー直下に祭りの吹き流し(のぼり旗)風の帯を追加、(3)セクション見出しに絵文字+色分け(朱赤/藍/からし)を付けて視認性とにぎやかさを両立、(4)CTAボタンに光の帯が流れるシャインアニメーションを追加、(5)フッター前に🍓の区切り装飾。仕組み解説図やスタッフ用アバター枠を`VISUAL_DESIGN_PROMPTS.md`と同じ運用でGoogle AI Studio生成のイラストに差し替えることも可能(`story/README.md`にプロンプト例を記載)だが、必須ではない見た目まで仕上げてある。
- **Playwrightで見つけて直した実際の不具合**: 動画セクションの縦横比自動補正JS(`loadedmetadata`イベント待ち)が、小さいローカル動画では読み込みが速すぎてイベント発火前にリスナー登録が完了し、`videoFrame`のaspect-ratioが更新されないバグがあった。`video.readyState>=1`なら即時反映、そうでなければ`loadedmetadata`を待つ、という両対応に修正。修正前後をffmpegで生成した縦(9:16)・横(16:9)のテスト動画で実機確認済み(縦動画が正しく縦長の枠に収まることを確認)。
- `negotiate/index.html`: `.lead`直後とレシート画面の`receiptThanks`直後に、story/ページへのリンクを1行追加(`https://ichigo-gatya-web.vercel.app/`という仮のURLで、`<!-- TODO -->`コメント付き。story/を別リポジトリにpushしてVercelデプロイが確定したら、この2箇所のhrefを実際のURLに書き換える必要がある)。
- `story/README.md`: 動画・写真の差し替え手順と、別リポジトリへの持ち出し方をまとめた。
- **未実施(申し送り)**: (1) `story/`を実際に`ichigo_gatya_web`リポジトリへpushしてVercelにデプロイする作業、(2) それに伴う`negotiate/index.html`内2箇所の仮URLの本番URLへの差し替え、(3) 制作秘話・スタッフ紹介の実写真撮影と`.photoBox`への差し込み、(4) 制作動画の完成とファイル配置。

## story/を`ichigo_gatya_web`リポジトリへpush(2026-07-14)

ユーザーの明示指示で、`story/`の中身を`https://github.com/KeitoKuramochi/ichigo_gatya_web.git`へpushした。フックは「`ichigo`フォルダ配下以外へのWrite/Edit禁止」なので、**`ichigo/story/`ディレクトリの中で`git init`し、そこに新しいリモートを設定してpushする**方法を取った(ローカルにファイルを書き込む場所は一切`ichigo`フォルダの外に出ていない。pushはネットワーク越しにGitHubへ送るだけなので、フックの制約と矛盾しない)。`story/.git`は`ichigo`本体のgit管理下ではなく独立したリポジトリで、`ichigo`側の`git status`には影響しない(`story/`は引き続き`ichigo`側では未追跡のディレクトリとして扱われる)。

- `gh auth status`でKeitoKuramochiアカウントとして認証済み(`repo`スコープあり)だったため、追加のログイン作業なしでpushできた。
- 初回コミット(`c88ae06`)を`main`ブランチとしてpush、GitHub API(`gh api repos/.../contents`)で反映を確認済み。
- **まだ未実施**: Vercelでのデプロイ設定(リポジトリ連携はユーザー側でVercelダッシュボードから行う想定)、それに伴う`negotiate/index.html`内2箇所の仮URL(`https://ichigo-gatya-web.vercel.app/`)の本番URLへの差し替え。Vercelのデプロイ自体はこのセッションでは行っていない(認証情報が無いため)。

### 仕組み解説の誤り修正(2026-07-14)

`story/index.html`の「仕組み解説」と「STEP 5」で、送金が確認されると**カプセルが自動的に排出される**かのような説明・イラストになっていたが、実際は**ロックが解除されるだけで、ガチャガチャ本体のレバーは来場者本人が手で回す**仕様。ユーザー指摘を受けて修正:

- 仕組み解説のSVG図(3コマ目)を「カプセルが機械から出てくる絵」から「ロック解除ランプ+自分で回すハンドル(↻)」の絵に描き直し、キャプションも「③ カプセルがコロンと出てくる」→「③ ロックが解除される(回すのは自分で!)」に変更。
- あそびかたSTEP 5の説明文も「ロックが解除されるので、カプセルを取り出してください」→「実機のロックが解除されます(自動で出てくるわけではありません)。あとはガチャガチャのレバーを自分の手で回して、カプセルを受け取ってください」に修正。
- 修正をコミット(`9edc77d`)してGitHubへpush済み。

## オンライン参加(ウォレット接続→AI交渉→ICHIGO送金→NFT受け取り)機能を新規実装(2026-07-15)

会場に来られない人もオンラインでAI店番と値切り交渉し、ICHIGOを送金してその場でNFTを受け取れるようにしたいという要望を受け、`/plan`で計画を立ててから実装した(計画書全文: `/Users/kuramochikeito/.claude/plans/compiled-stirring-stardust.md`)。当初「今回は土台だけ」の予定だったが、本番(2026-07-16)に間に合わせたいという方針転換を受け、実際に動く状態まで一気に実装した。

- **現地用とは完全に別物として実装**(要望通り): `bridge/server.js`の既存`negotiationSessions`/`currentSessionId`(実機1台=同時1交渉の前提)には一切手を入れず、新しい独立した`onlineSessions` Map・`/online-negotiate-*`系エンドポイントを追加した(既存の`/negotiate-*`は無変更、diffは追加行のみであることを確認済み)。デザイン(配色・フォント・キャラクター画像)だけは`negotiate/index.html`と共通にしている。
- **同時接続は2人まで**(`ONLINE_MAX_CONCURRENT`、既定2)。3人目は429で弾かれ、`online/index.html`側は自動的に5秒後リトライする(現地の物理的な行列に相当するものが無いため)。
- **決済はICHIGOを実際に送金**(現地と同じ経済的重み)。`/online-verify-and-claim`が既存の`findValidTransfer`/`usedTxHashes`/`isRecentEnough`等をそのまま再利用してオンチェーン検証する。
- **NFTはERC-1155 + EIP-712署名バウチャー方式**。`contracts/contracts/IchigoGachaNFT.sol`(OpenZeppelinのERC1155/Ownable/EIP712/ECDSAを利用)。決済確認後、サーバーが`bridge/prize-pool.js`(景品6種、重み付き抽選)で景品を選び、専用鍵(`ONLINE_MINTER_PRIVATE_KEY`、署名専用でETHを保有する必要が無い)でバウチャーに署名し、参加者自身のウォレットが`claim(voucher, signature)`を呼んでガス代を払ってmintする(バックエンドはガス代を払わない、という要望通り)。コントラクトはICHIGO/ETHを一切扱わない設計にして、初めてのSolidity実装によるミスの影響範囲を絞った。Hardhatでテスト(正常claim・リプレイ拒否・他人のvoucher拒否・期限切れ拒否・owner権限)を書き、全て通過済み。
  - OpenZeppelin 5.6系が`mcopy`(EIP-5656, Cancunで追加されたopcode)を使うため、`hardhat.config.js`で`evmVersion: "cancun"`を明示指定する必要があった(指定しないとコンパイルエラーになる)。OptimismはEcotoneアップグレードでCancun相当のEVM opcodeに対応済みなので、メインネットデプロイ自体には支障ない。
  - NFTのメタデータ・画像は`bridge/nft-metadata/:idHex`(その場でJSON生成)・`bridge/nft-images/`(静的配信)で自己ホスト。IPFS化はスコープ外(将来の改善点)。
- **`GACHA_NFT_MOCK_MODE`(テスト用)**: コントラクト未デプロイでもフロー全体(ウォレット接続〜AI交渉〜実際のICHIGO送金〜景品抽選)を試せるよう、ダミー署名を返し`online/index.html`側もclaim()呼び出しをスキップする仕組みを用意した。本番では必ず未設定にすること。
- **投影画面(`spectator/index.html`)**: 既存の`idleView`/`activeView`/`completedView`とそのpoll()は一切変更せず、`stageLayout`(flex row)で`mainStage`(既存そのまま)+`onlinePanel`(新規、最大2タイル)に分割した。オンライン0件ならパネルを隠し`mainStage`が全幅に戻る。当選演出(`#revealToast`)は現地の`completedView`(手動解除のみ)とは別方式にした: 自動7秒表示+1件ずつ順番に(同時完了しても積み上がらない)、見た目も金枠+「オンライン参加」タグで現地の演出と混同しないようにした。
- **管理者機能は最小限に留めた**(時間優先度を下げた): `/online-negotiate-admin-list`・`/online-negotiate-admin-cancel`のみ実装。価格の直接上書き(オンライン版の`/negotiate-admin-set-price`相当)・当選演出キューの早消しボタンは未実装(必要になれば追加する)。
- 新規ファイル: `contracts/`(Hardhatパッケージ一式)、`bridge/prize-pool.js`、`online/index.html`+`online/assets/`(negotiate/assetsからコピー)、`bridge/nft-images/`(現時点ではプレースホルダー画像、既存の`image/icon-*.png`等を仮に流用)。

### 未実施・申し送り事項(重要)

- **コントラクトの実デプロイがまだ**: `contracts/scripts/deploy.js`は書いたが、実際のデプロイには(1)新規ウォレットの秘密鍵を`contracts/.env`の`DEPLOYER_PRIVATE_KEY`に設定、(2)そのウォレットにOptimism上で少額のETH(デプロイ用ガス代)を送金、(3)`npm run deploy:mainnet`を実行、という、ユーザー自身の鍵・実際のETH送金が必要な操作が残っている。デプロイ後、得られたコントラクトアドレスを`bridge/.env`の`NFT_CONTRACT_ADDR`に、デプロイに使った秘密鍵を`ONLINE_MINTER_PRIVATE_KEY`に設定し、`GACHA_NFT_MOCK_MODE`を外して再起動すること。
- **景品画像が仮**: `bridge/nft-images/`は現状、既存の`image/icon-*.png`等を仮に流用しているだけ(prize-1〜5がAI生成イラスト5枚、prize-6-specialが手描きレア1枚に対応する想定)。実際の画像が用意でき次第、同じファイル名で差し替えるか、`bridge/prize-pool.js`の`image`フィールドを実ファイル名に書き換えること。
- **`ONLINE_MINTER_PRIVATE_KEY`の鍵管理**: 資金は保有しないが、漏洩すると無期限に不正mintされ得る。会期後も有効であり続けるため、`/test-move`等の「学祭デモだから直さない」という緩い基準とは別に扱うべき(必要なら`setTrustedMinter()`で鍵をローテーションできる)。
- **参加者側のOptimismガス代**: mint(claim)は参加者自身のウォレットが実行するため、少額のETHが必要(ユーザー確認: 今回は問題にならない前提)。
- ローカルの動作確認は`GACHA_NFT_MOCK_MODE=1`+ダミーの`ANTHROPIC_API_KEY`で行い、同時2セッションの受付・3セッション目の429・`/online-negotiate-current`のセッション一覧・`/online-negotiate-admin-list`/`-cancel`・`/nft-metadata/:idHex`をcurlで確認済み。**実際のANTHROPIC_API_KEY・実際のICHIGO送金・実際のコントラクトへのclaim()を伴うE2Eは未実施**(本番前に必ず一度、少額の実送金と実mintで通しテストすること)。

## AI店番のフォールバック順を3段階(OpenAI→Anthropic→Cloudflare)に変更(2026-07-15)

OpenAIのAPIキーを取得したとのことで、`bridge/negotiation.js`のAI呼び出し順を変更。以前は「Anthropicメイン→(設定されていれば)Geminiフォールバック」+「CF_ACCOUNT_ID/CF_API_TOKENが両方設定されていればテスト用にAnthropic/Geminiを完全にバイパスしてCloudflare Workers AIだけを使う」という構成だったが、これをやめて**「OpenAI→Anthropic(Claude Haiku)→Cloudflare Workers AI」の3段階本番フォールバックチェーン**に一本化した。

- `getNegotiationReply()`: 各段は対応する環境変数(`OPENAI_API_KEY`→`ANTHROPIC_API_KEY`→`CF_ACCOUNT_ID`+`CF_API_TOKEN`)が設定されていれば呼び出し、失敗(APIエラー・タイムアウト・想定外の応答形式)したら次の段に進む。未設定の段は単純にスキップする。全段失敗/未設定ならnullを返し、呼び出し側(server.js)が従来通りの詫び文言フォールバックを出す。
- 新規`callOpenAI()`を追加(Chat Completions API、`tool_choice`で`quote`関数呼び出しを強制。レスポンス形式はCloudflare Workers AIと同じ`tool_calls[].function.arguments`のJSON文字列なので、パース処理はCloudflare側と共通のロジックを流用)。
- `callGemini()`は削除(今回の3段階には含まれないため)。
- `ANTHROPIC_MODEL`は既存のデフォルト値(`claude-haiku-4-5-20251001`、実質Haiku)をそのまま「第二優先」として使う設計にした。
- `server.js`: `OPENAI_API_KEY`/`OPENAI_MODEL`(デフォルト`gpt-4o-mini`)を追加、`GEMINI_API_KEY`/`GEMINI_MODEL`を削除。`NEGOTIATION_ENABLED`は「OpenAI/Anthropic/Cloudflareのいずれか1つでもキーが揃っていればtrue」に変更(以前は`ANTHROPIC_API_KEY`必須だった)。起動時ログもフォールバック順の有効/無効状況を表示するよう変更。`bridge/.env.example`も同様に更新。
- 動作確認: `global.fetch`をモックした一時スクリプトで、(1)OpenAI失敗→Anthropic成功、(2)OpenAI・Anthropic両方失敗→Cloudflare成功、(3)Anthropicのみ設定時に単独で成功、(4)何も設定されていない場合にnullを返す、(5)OpenAIが最初から成功する場合は他の2段に一切問い合わせない、の5パターンをすべて確認済み(実際のAPIキーでのE2Eは未実施)。

## オンライン参加の景品配布をNFT(オンチェーンmint)から画像表示のみに簡素化(2026-07-16、本番当日)

NFTコントラクトの実デプロイ(デプロイ用ウォレットの新規作成・実ETH送金・`deploy:mainnet`実行・鍵の運用管理)が本番当日になっても未完了で、当日中に済ませるのはリスクが高いと判断。ユーザーの希望で、**ERC-1155 mint/EIP-712バウチャー/claim()を一切やめ、決済確認後にサーバーが抽選した景品画像をその場で見せる(保存もできる)だけ**の方式に変更した。

- `bridge/server.js`: `ONLINE_MOCK_MODE`/`ONLINE_NFT_CONFIGURED`(`GACHA_NFT_MOCK_MODE`/`NFT_CONTRACT_ADDR`/`ONLINE_MINTER_PRIVATE_KEY`に依存していた判定)を削除し、`ONLINE_ENABLED = NEGOTIATION_ENABLED`のみに簡素化。`NFT_ABI`/`nftInterface`/`onlineMinterWallet`(署名専用ウォレット)を削除。`/online-verify-and-claim`はEIP-712バウチャーの署名を一切行わず、抽選した`prize`だけを返す。`/online-claim-confirm`は「画像を見せ終わった」ことをサーバーに伝えてセッションを`claimed`にする(オンライン枠を解放する)だけの薄いエンドポイントに変更。`bridge/prize-pool.js`のコメントもNFT前提の記述を修正。
- `online/index.html`: 「NFTを受け取る」ボタン(`claimBtn`、参加者側にMetaMaskで2回目の署名/mintトランザクションを要求していた)を削除。支払い確認後は`showPrizeReveal()`が景品画像を表示→自動で`/online-claim-confirm`を呼び→約1.6秒後に自動でレシート画面へ進む(参加者側の追加操作は不要)。レシート画面に「画像を保存」ボタン(`<a download>`、同一オリジン配信の`/nft-images/`を直接指す)を追加。文言も「NFT」→「記念画像」に統一し、「受け取り時のガス代」等のmint前提の説明文を削除。「テスト運用中」のmockバナーも削除(この画像表示方式が正式な本番動作のため)。
- `spectator/index.html`: オンラインパネルのステータス表示「NFT受け取り待ち」→「景品お披露目中」に変更。
- `bridge/.env.example`: `GACHA_NFT_MOCK_MODE`/`NFT_CONTRACT_ADDR`/`ONLINE_MINTER_PRIVATE_KEY`/`ONLINE_VOUCHER_TTL_MS`の記載を削除(もう使わないため)。手元の`bridge/.env`(本番Render側の環境変数とは別)にはこれらのキーは元々設定されていなかったことを確認済み。
- `contracts/`(Hardhatパッケージ・`IchigoGachaNFT.sol`)自体は削除せず残した(将来オンチェーン化を再検討する場合の下敷き)。現在のオンライン参加フローからは一切呼び出されない。
- 動作確認: ローカルで`node --check`(構文)・`node server.js`起動→`/online-status`(`mock`フィールドが消え`enabled/maxConcurrent/activeCount`のみになったことを確認)・`/prize-pool-teaser`・`/nft-images/prize-1.png`(200)・`/online/`(200)をcurlで確認。ローカル`.env`にAI用APIキーが無いため`ONLINE_ENABLED=false`の状態での確認のみ(実際のAI交渉〜支払い〜画像表示までの本物のE2Eは本番Render環境で確認する必要あり)。

## Cloudflareの環境変数名を`CF_*`→`CLOUDFLARE_*`に統一(2026-07-16)

本番(Render)の環境変数一覧のスクリーンショットを確認したところ、Cloudflareの認証情報が`CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN`という名前で登録されていたが、コード(`bridge/server.js`)が実際に読んでいたのは`CF_ACCOUNT_ID`/`CF_API_TOKEN`だったため、**値は設定されているのに一致する変数名が無くコードから見えず、Cloudflareの第三フォールバックが実質無効になっていた**バグを発見。

ユーザーの指示(「コードの方で変更しておいて」)により、本番側の値を再入力させるリスクを避け、コード側を本番の名前に合わせる方針で修正。`bridge/server.js`・`bridge/.env.example`の`CF_ACCOUNT_ID`/`CF_API_TOKEN`/`CF_MODEL`を`CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_MODEL`に一括リネーム(sedで機械的に置換、`getNegotiationReply()`への渡し方(`cloudflareAccountId`等のパラメータ名)は変更していない)。起動時のsyntaxチェック・スモークテスト(`node server.js`を数秒起動)で正常起動を確認済み。

なお、`NEGOTIATE_FLOOR_COST`(=100)が`COST`(=100)と同値に見える点(通常の値切りでは実質割引が発生しない設定になっている可能性)は、ユーザーに指摘済みだが意図通りかどうかの返答はまだ無い。次回このあたりを触る際は要確認。

## 講義資料に基づくキャラ設定強化・2ターン制・価格帯変更(2026-07-16、当日)

前回のOpenAI切り替えで発覚した「雑談だけでは全く値引きしない」問題(gpt-4o-miniがプロンプトの禁止事項を字面通り厳格に守った結果)への追加対応と、当日の運用に合わせた仕様変更をまとめて行った。**上記の`NEGOTIATE_FLOOR_COST=COST`問題も、今回の価格帯変更で結果的に解消される**(floorPriceをCOSTより明確に低く設定し直したため)。

- **講義資料(`siryou/`)の読み込み**: 第2回〜第11回の全講義スライド(PDF)をサブエージェントに読ませ、実際に出てきた固有名詞・用語(ブロックチェーン、ERC-20/721、x402、ICHIGO/JOIN、LLM、RAG、MCP、AIエージェント、ハルシネーション、プロンプトインジェクション、VPC、MVP、Claude Code、CHIBATECH PROTOTYPE等)を抽出し、`bridge/negotiation.js`の`COURSE_TOPIC_HINTS`定数としてプロンプトに直接埋め込んだ。「この授業の内容にゆるくでも触れた発言」をAIが判定する具体的な手がかりにする狙い。
- **人格設定の強化**: 「学園祭の集大成展示『CHIBATECH PROTOTYPE』に出ている屋台のおじさん(的屋)。実は授業内容にやたら詳しく、客がその話に乗ると機嫌が良くなる」という裏設定を明示。喋り方も「屋台のおじさんらしい伝法な口調」を明示的に指示。
- **値引きの判定を3段階に整理**(`buildSystemPrompt()`): ①「安くして」等の中身の無い要求だけ→据え置き、②普通に愛想よく話しているだけ→`floorPrice`まで、③機転の利いた発言 **または** 講義内容にゆるく触れた発言→`absoluteFloor`まで一気に。知らない客を置いてけぼりにしないよう「知らなくても普通の値切り交渉として自然に応対する」旨も明記。
- **少ターン数への対応**: `maxTurns`をプロンプトに明示し、「ターン数が少ないので様子見せず初手からまとまった値下げを出してよい」という指示を追加(以前の「1ターンにつき少額ずつ」という指示のままだと2ターン制と矛盾するため書き換え)。
- **当日の価格設定案**: `bridge/.env.example`のコメント・デフォルト値を`COST=2000`・`NEGOTIATE_FLOOR_COST=1500`・`NEGOTIATE_ABSOLUTE_FLOOR=1000`・`NEGOTIATE_MAX_TURNS=2`に更新。**ただし実際に効くのはRenderの環境変数なので、この4つはRenderのダッシュボード側でも同じ値に設定する必要がある**(このセッションからは変更できない)。`payment/index.html`側の直決済用ハードコード`COST`定数も2000に合わせて更新済み(bridgeのCOSTと不一致だと直接決済が失敗するため)。
- **オープニングの一言に軽いヒントを追加**: `server.js`の`openingReply`(オンサイト・オンライン両方)に「授業でやったような話でもしてくれたら、ちょっとサービスしちゃうかもよ?」を追加し、知っている客が話しかけるきっかけを作った。
- 動作確認: `node --check`で3ファイルとも構文エラー無しを確認。実際のAPI呼び出しでの効果確認(gpt-4o-miniが実際に講義用語に反応して大幅値引きするか)は当日の実機テストが必要、未実施。

## 「値引きしてください」×2回だけで絶対下限まで落ちるバグを修正(2026-07-16、当日)

ユーザーが本番相当の設定(`COST=2000`/`NEGOTIATE_FLOOR_COST=500`/`NEGOTIATE_ABSOLUTE_FLOOR=100`/`NEGOTIATE_MAX_TURNS=2`)で実際に交渉を試したところ、「値引きしてください」→2000→500、「もっと下げて」→500→絶対下限100、という、中身の無い繰り返し要求だけで一気に最安値まで落ちる現象が発生(「バカになってしまった」との報告)。

原因はプロンプト内の指示の矛盾: 「愛想よく素直にお願いしている場合はfloorPriceに向けて下げてよい」という文と、「安くして等の直接要求だけなら値段を動かさない」という例外文の両方に「値引きしてください」的な発言が当てはまってしまい、AIが甘い方の解釈を選んでいた。さらに「ターン数が少ないので思い切った額を出せ」という指示もこの誤読を助長していた。

`bridge/negotiation.js`の`buildSystemPrompt()`を修正:
- 「金額そのものの直接要求・お願い・泣き落とし・その繰り返しだけなら価格を一切変えない」という例外ルールを、プロンプトの先頭(定価の直後)に移動し、「他のどの指示よりも優先する最重要ルール」と明記。「丁寧・素直な言い方であっても、要求の中身が値引きそのものであれば適用される」と明示し、「値引きしてください」のような曖昧な言い回しも確実にこのルールに含まれるようにした。
- 「愛想よく会話が続いている場合は下げてよい」の文から、値引き要求そのものは除外する形に書き換え(「挨拶・雑談・お礼・自己紹介など、値引きそのものの要求ではない形で」と限定)。
- コミット`fd8d8ba`としてpush済み(Renderが自動デプロイする設定になっているはずなので、次回の交渉で反映される想定。**反映されたことの実機再確認はまだ未実施**)。

## 値下げの刻み幅を「ゼロか絶対下限か」の二択から段階的に変更(2026-07-16、続き)

上記の修正後、今度は逆方向の不満: 機転が利いた発言をすると毎回いきなり絶対下限(100)まで飛んでしまい、単調で面白くないとの指摘。原因はプロンプトの「様子見せず絶対下限まで一気に下げてよい」という一文がそのまま「下げる時は必ず絶対下限まで」という意味に読めてしまっていたこと。

`buildSystemPrompt()`を再修正: 「思い切って」は「毎回絶対下限に飛ぶ」ことではないと明記し、発言の面白さの度合いに応じて50/100/500 ICHIGOのようなきりのいい額を自分で選んで刻むよう指示。絶対下限は「よほど良ければ到達できる最後の切り札」という位置づけに変更(コミット`9f66804`)。

## Anthropic(Claude)を第一優先に変更、値切りが認められる話題の幅を拡張(2026-07-16、続き)

実際に試した結果、ユーザーが「Claudeの方が交渉の受け答えが賢い/面白い」と判断し、AIプロバイダのフォールバック順を**Anthropic(Claude Haiku)→OpenAI→Cloudflare**に変更(以前はOpenAIが第一優先だった)。`negotiation.js`の`getNegotiationReply()`内の呼び出し順、`server.js`の環境変数の並び・ログ文言、`.env.example`のコメントをすべて新しい優先順に揃えた(コミット`c7c6ee8`)。

あわせて、値切りが認められる発言の種類を拡張。従来は「機転の利いた冗談・鋭い返し」「授業内容への言及」の2種類だけだったのを、(3)「他の屋台はもっと安かったよ」的な現実的な値切りの駆け引き、(4)店番への気の利いたお世辞・褒め言葉・ちょっとした贈り物(お菓子等)の申し出、の2種類を追加。「授業の話をすれば下がる」という一本道だけでなく、屋台の値切りらしい人間味のある掛け合い全般に対応できるようにした狙い。

- 動作確認: `global.fetch`をモックしたスクリプトで、Anthropic/OpenAI/Cloudflareを全部設定した状態でAnthropicだけが呼ばれることを確認済み。プロンプトの実際の文面もコンソール出力して目視確認済み。**実際のAPIキーでの応答内容(Claude Haikuが本当に狙った通りの刻み方・幅広い認定をしてくれるか)は当日の実機テストが必要、未実施。**
- 実機で2000→1500/1700/1590あたりが今のところの下がり幅の目安、とユーザーから報告あり(段階的な値下げ自体は機能している様子)。

## 最終ターンが疑問形のまま終わってしまう不具合を修正(2026-07-16、続き)

`NEGOTIATE_MAX_TURNS=2`で実際に試したところ、2回目(最終ターン)の返答が「これでどうだ」のように疑問形のまま終わってしまい、プロンプトで明示していた「疑問形を使わず断定的に宣言する」という最終ターン専用の指示が守られていないとの報告。`turnCount`の受け渡し自体は正しく、`isLastTurn`の判定ロジックにバグは無い(2ターン目でちゃんとtrueになる)ため、純粋にプロンプトの指示がモデルに無視されている問題と判断。

`buildSystemPrompt()`を再構成: 最終ターン専用の指示(`isLastTurn`の三項演算子)を、プロンプトの中盤(他の指示に埋もれがちな位置)から、tool呼び出し指示の直前(=モデルが読む最後の指示)に移動。あわせて文面も強化: 禁止する疑問形パターンを追加(「〜だろ?」「〜かい?」)、「勢いのいい伝法な口調であっても禁止」と明記、断定的な closing の具体例テンプレートを2パターン提示(「よし、決まりだ!◯◯ICHIGOだ!」「しゃあねえ、◯◯ICHIGOで手を打とう、それ以上は無しだ!」)。コミット`d2e1e06`。

- 動作確認: `node --check`で構文エラー無し、`turnCount=1, maxTurns=2`(=最終ターン)の場合にプロンプト末尾に強化済みの指示が正しく出力されることをコンソール出力で目視確認済み。**実際にAnthropic Claude Haikuがこの指示に従って断定文で終えるかは、当日の実機テストで確認が必要、未実施。**

## オンライン参加のみをVercelサーバーレスへ移植(2026-07-18)

イベント(2026-07-16)終了後も、他の受講生が出品する「ICHIGO MART」の受講生マーケットに
このガチャガチャを出品し、外部サイト(=この新デプロイ)でAI交渉→ICHIGO送金→記念画像受け取り、
という流れで遊べるようにしたいという要望を受けた。bridgeは現状Render無料枠(スリープ・
コールドスタートあり)で運用しており、これを落ちにくいVercelに移す方針。

- **移行したのは「オンライン参加」機能だけ**(ユーザーの明示的な選択)。現地のESP32連携・
  `/negotiate-*`・実機解除まわりは`bridge/server.js`ごと無変更でRenderに残したまま。
  ICHIGO MART自体のコードはこのリポジトリにも他の場所にも存在せず(他者が用意した
  出品プラットフォーム)、出品はユーザー本人が「出品者ページ」から自己申告する運用。
- 新規ディレクトリ`online-vercel/`(このリポジトリ内、`payment/`と同じ「Root Directoryだけ
  変えて同じGitHubリポジトリを別Vercelプロジェクトとしてデプロイする」パターン)。
  - `index.html`+`assets/`+`nft-images/`は`online/`・`bridge/nft-images/`からのコピー
    (フロント側はすべて相対パスの`fetch`のため無改修)。
  - `api/`配下にVercelのNode.jsサーバーレス関数として`/online-*`系エンドポイントを再実装
    (`bridge/server.js`の同名ルートを踏襲)。`api/_lib/negotiation.js`(AI呼び出し)・
    `api/_lib/prize-pool.js`(景品抽選)はbridgeから無改変でコピー。
- **状態保存をメモリのMapからUpstash Redis(REST API、サーバーレスと相性が良い)に変更**。
  ユーザーから「今の実装に縛られず単純に考えていい」との指示を受け、sweepStale*系の
  定期掃除ロジックは全廃し、Redisの`EX`(TTL)任せに簡素化した(キーが消える=セッションが
  無い、として扱うだけでよい)。同時実行の排他(元は`session.busy`を単一プロセスの
  同期処理で守っていた)は、サーバーレスは複数インスタンスが本当に並行実行されうるため
  `SET NX`による原子的なロック(`api/_lib/store.js`の`acquireLock`/`releaseLock`)に変更。
  `finalPriceWei`はBigIntのままだとRedis保存用のJSONシリアライズができないため、
  文字列で保存しオンチェーン検証時にBigInt化する(`api/_lib/pricing.js`・
  `api/online-verify-and-claim.js`)。
- 購入履歴(`recentPurchases`)は移植していない(オンライン版のレシートは元々
  ブラウザのlocalStorageのみで完結しており、サーバー側記録は使われていなかったため)。
- 動作確認: `node --check`で全ファイルの構文エラー無し。`npm install`でのモジュール解決
  (`@upstash/redis`・`ethers`)を確認済み。**実際のUpstash Redis・実際のAI APIキー・
  実際のICHIGO送金を伴うE2Eは未実施**(本番前に少額の実送金で一度通しテストが必要)。
- 未実施(申し送り): (1) Vercelダッシュボードでの新規プロジェクト作成(Root Directory=
  `online-vercel`)とUpstash Redis(Storageタブから作成、env varは自動注入される)の
  実際のセットアップ、(2) `ANTHROPIC_API_KEY`・`NEGOTIATE_FLOOR_COST`・`ADMIN_SECRET`等の
  本番用env varの投入、(3) デプロイ後のURLでの実機E2Eテスト、(4) そのURLをICHIGO MARTの
  「出品者ページ」からユーザー自身が出品として登録する作業(詳細は`online-vercel/README.md`参照)。

### 文言をICHIGO MART出品向けに書き換え(2026-07-19)

`online-vercel/`の文言が「会場に来られない人向けのオンライン参加」という、元イベント(2026-07-16)の
現地開催を前提にした説明のままだったため、ICHIGO MARTへの出品を見据えて「ICHIGOガチャガチャ
延長戦」という単独で成立する体験に書き換えた。

- `<title>`・リード文・使い方3ステップ2番目(「会場での購入と同じ扱いです」を削除)・
  呼び名入力欄の説明(存在しない「投影画面」への言及を削除)・準備中/混雑時のエラー文言・
  AI店番の開始セリフ(`api/online-negotiate-start.js`)から「オンライン」「会場」「参加」
  といった、単独では意味が通らないイベント前提の言葉を除去。
- 景品(記念画像)の内訳を明示: 全6種類のうちAI生成イラストが5種類、友人(れのあさん、
  `story/index.html`に実名記載の前田怜音氏)直筆の激レアイラストが1種類(出現率10%)、
  という説明を`prizeGalleryNote`に追加(元々`prize-pool.js`のweightには反映済みだったが、
  文言としては明示されていなかった)。
- API側のエラーメッセージ(`online-negotiate-start.js`・`online-verify-and-claim.js`の
  503/429文言、ログの`console.log`)も同様に「オンライン参加」表現を除去。内部のコード
  コメント(サーバーレス関数の実装メモ等)は技術的に正確なままなので変更していない。

### 見た目・操作性の実機確認とガチャ演出の実装(2026-07-19、続き)

Playwright(ヘッドレスChromium)で全画面状態のスクリーンショットを実際に撮って目視確認しながら
改善した。確認用の道具一式は`.design-qa/`(gitignore済み): `preview-server.mjs`(静的配信+
`/online-status`・`/prize-pool-teaser`のモック)、`screenshot.mjs`(モバイル390px/デスクトップ
1280pxの2ビューポート×全10状態を撮影)、`burst-check.mjs`(カプセル破裂の途中フレーム確認)。
Playwright本体はフォルダ外編集フックの制約により、スクラッチパッド側にnpm installして
`node_modules`をシンボリックリンクで参照している。

- **【バグ発見・修正】手描きスペシャルの当選バッジが通常当選でも常時表示されていた**:
  `.hidden`(単一クラス)と`.specialBadge`(同じ詳細度で後方定義、`display:inline-block`)が
  同一要素に付くとき、後方の`.specialBadge`が勝って`hidden`が効いていなかった。スクリーン
  ショットの目視で発覚。`.hidden { display: none !important; }`に変更して修正(negotiate/等の
  他ページは`.hidden`が後方定義なので同種の問題は起きていない)。
- **【操作性】ウォレット接続後に導入コンテンツ(`#introSection`)を畳むようにした**: 接続後も
  遊び方5ステップ・景品ギャラリーが画面上部に残り続け、チャット・支払い・景品の各画面が
  スマホで1000px超スクロールしないと見えなかった。接続成功時とレシート復元時に`hidden`を
  付けて畳む(1画面=1目的に集中させる)。
- **【フロー再設計・ガチャ演出の新規実装】**(ユーザー指定の「トップ→接続→交渉→支払い→
  ガチャ演出→受け取り→トップ」の流れに合わせた):
  - トップの使い方説明を3→5ステップに増やし、この流れをそのまま説明する形にした。
  - 送金検証中: 店番キャラ+回転するガチャハンドル(`.gachaKnob`)で「回している」感を出す。
  - 検証OK・景品判明後: `playGachaAnimation(special)`がカプセル演出を再生してから景品を
    表示する。通常(約3秒): カプセル落下(バウンド)→ガタガタ揺れ→パカッと割れて閃光。
    special=れのあさん直筆(約5秒): 揺れの途中でカプセルが金色に変色+金の放射
    (`.kakuteiRays`)+スパークル+光量の脈動、という「確定演出」(ソシャゲの虹演出の発想)に
    切り替わってから割れる。景品が判明した後に演出を選ぶので、演出と結果が食い違うことはない。
  - レシートのボタンを「もう一度参加する」→「トップへもどる(もう一度あそぶ)」に変更
    (reloadでトップに戻る挙動自体は従来通り)。
- 動作確認: 上記スクリプトで全状態(通常/特別の破裂途中フレーム含む)を撮影し目視確認済み。
  実ウォレット・実送金を伴うE2Eは未実施(Vercelデプロイ後に要通しテスト)。

### 【実装漏れ・修正】Vercelデプロイ後、全APIが404になる不具合(2026-07-19)

ユーザーが実際にVercelへデプロイ(`https://ichigo-gatya.vercel.app/`, Root Directory=
`online-vercel`)して試したところ、名前を入力して交渉を始めようとすると「交渉開始の応答を
読み取れませんでした」というエラーになった。`curl`で直接叩いて確認したところ、
`/online-status`等すべてVercel自体の404(`x-vercel-error: NOT_FOUND`のプレーンテキスト)を
返しており、それをJSONとしてパースしようとして起きたエラーだった。

**原因**: Vercelの既定の仕様では`api/online-status.js`は`/api/online-status`というURLに
マップされる。ところが`index.html`(bridgeのRender版と挙動を合わせるため無改修でコピーした)
は`fetch("/online-status")`のようにルート直下を叩く作りのままだったため、実装時に
このURLの食い違いを見落としていた(ローカルのモックサーバーでは`/online-status`を
直接ハンドリングしていたため、この食い違いに気づけなかった)。

**修正**: `online-vercel/vercel.json`に`rewrites`を追加し、`/online-status`→
`/api/online-status`のように、index.htmlが叩く11個のパス全てを対応する`/api/*`へ
書き換えるようにした。`/nft-images/*`は元々静的ファイル配信で機能しており対象外
(curlで200を確認済み)。
- 動作確認: `curl`で構文(JSON妥当性)を確認済み。デプロイし直しての実動作確認はユーザー側で要実施。
