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

## 作ったファイル一覧

- `ICHIGO_game/`（新規, GitHubからclone）: 友人のゲーム本体。`gacha.html`の`tx.wait()`成功直後にブリッジへの`fetch`呼び出しを1箇所追加済み
- `firmware/step0_servo_test/step0_servo_test.ino`: サーボ単体動作確認用。シリアルモニタで`u`+Enterを送るとロック解除動作を1回行う
- `firmware/gachapon/gachapon.ino`: 本番用。WiFi接続+`POST /unlock`(要`X-Secret`ヘッダー)でサーボを解除動作させる。角度・保持時間を指定するテスト動作、補充用ロックの開閉にも対応(下記参照)
- `bridge/server.js` / `bridge/package.json` / `bridge/.env.example`: オンチェーン検証+ESP32中継サーバー
- `test/motor-test.html`: モーター調整用のテストページ(下記参照)
- `admin/refill-lock.html`: 補充用ロックの開閉管理者ページ(下記参照)
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
- 未実施: `REFILL_CLOSED_ANGLE`/`REFILL_OPEN_ANGLE`の実機での角度調整、GPIO19が実機で使える空きピンかどうかの確認、firmwareの書き込み直し
- **不具合調査中(2026-07-03)**: 管理者ページで「開ける」を押すと成功(`done`)と表示されるのに、実際のサーボは1回も動かないという報告あり。`attached()`が`true`を返すのは`attach()`の呼び出し自体が成功したことを示すだけで、実際にその物理ピンにサーボが繋がっているかは保証しないため、bridge経由のテストだけでは切り分けが難しい。原因切り分け用に、WiFi/bridge/HTTPを一切経由しないシリアルコマンドを追加した: `handleSerialCommand()`(`loop()`から呼ぶ)で、Arduino IDEのシリアルモニタから`r`+Enterを送ると補充用サーボ(`refillServo`)だけを直接開→閉と動かして`attached()`の値も表示する。これで「bridge/JSON解析側の問題」か「GPIO19配線・電源・サーボ本体側の物理的な問題」かを切り分けられる。配線・電源はユーザー確認済み(GPIO19に接続、メインと同じ電源レール)とのことなので、次はこのシリアルコマンドでの直接テスト結果待ち。
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
