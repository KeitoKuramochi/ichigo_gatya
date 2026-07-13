/*
  Step 1: ESP32 ポーリング型ガチャガチャ制御 + OLED表示(日本語対応) + OTA
  ------------------------------------------------
  Step 0の配線・動作確認ができたら、このスケッチに切り替える。

  やること:
    - WiFi(スマホのテザリング等、インターネットに出られるものなら何でもよい)に接続する
    - 数秒おきに、ブリッジサーバーの /poll-unlock に「解除待ちある?」と問い合わせる
    - 「ある」と返ってきたらサーボでロック解除動作を1回行い、その結果(成功/失敗)を
      /unlock-result でブリッジに報告する(決済ページはこの報告を見て初めて
      「支払い完了」を表示する。報告が届かない場合はブリッジ側がタイムアウトで
      自動的に失敗扱いにするので、送金だけ成立してロックが開かない事故を防げる)
    - 基板内蔵の0.96インチOLED(SSD1306, I2C)に日本語で状態を表示する
    - 2回目以降の書き込みはUSB不要、WiFi経由(OTA)でできる

  ブリッジと同じLANにいる必要はない(ブリッジはcloudflared等でインターネットに
  公開されている前提。ESP32側はインターネットに出られるWiFiであればどこでもよい)。

  【配線】(Step 0と同じ。OLEDは基板に内蔵済みなので追加配線不要)
    メイン(コイン投入ロック)用サーボ
      SG90 オレンジ(信号) -> GPIO13
      SG90 赤(+)          -> ESP32の "VIN" ピン
      SG90 茶/黒(GND)     -> ESP32の "GND" ピン
    補充用(カプセル補充フタのロック)サーボ ※2026-07-03追加
      SG90 オレンジ(信号) -> GPIO12
      SG90 赤(+)          -> ESP32の "VIN" ピン(メインと同じブレッドボードの電源レールでOK)
      SG90 茶/黒(GND)     -> ESP32の "GND" ピン(同上)

  書き込み前に、下の WIFI_SSID / WIFI_PASSWORD / BRIDGE_URL / SHARED_SECRET を
  自分の環境に合わせて書き換えること。SHARED_SECRET は
  Render.com上のbridgeのENV(ESP32_SECRET)と必ず同じ文字列にする。
  BRIDGE_URL はRender.comにデプロイしたbridgeの固定URL(https://ichigo-gatya.onrender.com)。
  Renderにデプロイし直しても変わらないので、通常は書き換え不要。

  必要な追加ライブラリ(ライブラリマネージャからインストール):
    - "U8g2" (by oliver / olikraus) — 日本語表示用のフォントを内蔵している
    - ArduinoOTA / HTTPClient / WiFiClientSecure はESP32ボードパッケージに標準同梱

  【WiFi経由の書き込み(OTA)のやりかた】
    1. 最初の1回だけ、いつも通りUSBケーブルで書き込む
    2. 起動してWiFiに繋がった状態で、Arduino IDEの「ツール」→「ポート」を開く
    3. ネットワークポートの一覧に "ichigo-gachapon" が出てくるので、それを選ぶ
       (出てこない場合は、PCとESP32が同じWiFiにいるか確認する)
    4. 以降はUSBを挿さなくても、そのまま書き込みボタンで書き込める
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoOTA.h>
#include <ESP32Servo.h>
#include <U8g2lib.h>

// ↓↓↓ ここを自分の環境に合わせて書き換える ↓↓↓
// AP_MODE = true  : ESP32自身がWiFi電波を出す(スマホ/PCをそのWiFiに直接つなぐ)。
// AP_MODE = false : 既存のWiFi(WIFI_SSID)に子機として参加する。本番用。
const bool AP_MODE = false;

const char* WIFI_SSID = "kirinsan";
const char* WIFI_PASSWORD = "keito0215";

const char* AP_SSID = "ICHIGO-GACHAPON";
const char* AP_PASSWORD = "ichigo1234"; // 8文字以上必須

// その日のブリッジの公開URL(cloudflaredのトンネルURLなど)。末尾に/は付けない。
const char* BRIDGE_URL = "https://ichigo-gatya.onrender.com";
const char* SHARED_SECRET = "ichigo123"; // bridge/.envのESP32_SECRETと揃える

const unsigned long POLL_INTERVAL_MS = 2000; // 何ms間隔でブリッジに問い合わせるか
// ↑↑↑ ここまで ↑↑↑

const int SERVO_PIN = 13;
const int LOCK_ANGLE = 180; // 起動時・待機中の角度(サーボの初期位置)
const int UNLOCK_ANGLE = 45; // 解除動作で一瞬向ける角度(その後LOCK_ANGLEに戻る)。motor-test.htmlでangle=45/holdMs=950/moveMs=500が良好だったため確定
const int UNLOCK_HOLD_MS = 950;
const int UNLOCK_MOVE_MS = 500; // ロック⇔解除角度の間をゆっくり動かすのにかける時間

// 補充用(カプセル補充フタ)のサーボ。メインのコイン投入ロックとは独立していて、
// 決済とは無関係に管理者ページ(/admin/refill-lock.html)から開閉を指示する。
// メインと違い「開けたら管理者が手動で閉めるまで開いたまま」という動きにする
// (補充作業中はフタを開けっぱなしにできた方が都合がよいため)。
// 起動時のデフォルトは「開いている」状態(180度)で、そこから管理者が「閉める」を
// 押すと80度まで倒れてロックがかかる、という向き(2026-07-06、実機確認の結果に合わせて
// OPEN/CLOSEDの角度を入れ替えた)。moveMs=0(即座に動かして落とす)は変更なし。
const int REFILL_SERVO_PIN = 12;
const int REFILL_OPEN_ANGLE = 180;
const int REFILL_CLOSED_ANGLE = 80;
const int REFILL_MOVE_MS = 0;

// このボードのOLEDは 128x64, I2Cアドレス0x3C, SDA=GPIO21/SCL=GPIO22(基板内蔵配線)
// 画面が真っ白/真っ暗のままなら、末尾を _F_HW_I2C のまま別コンストラクタ
// (例: U8G2_SSD1306_128X64_NONAME_2_HW_I2C)に替えて試してみること。
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, /* reset=*/ U8X8_PIN_NONE);
bool oledReady = false;

const uint8_t* JP_FONT = u8g2_font_unifont_t_japanese1; // ひらがな/カタカナ表示用
const uint8_t* ASCII_FONT = u8g2_font_6x10_tf;           // IPアドレスなど半角文字用

Servo gachaServo;
Servo refillServo;
unsigned long lastPollAt = 0;

// 画面を最大3行のテキストで書き換える(1・2行目=日本語フォント、3行目=半角フォント)。
// 今後、新しい状態表示を増やしたいときはこの関数を呼ぶだけでよい。
// 【文字数の目安】画面幅は128px。日本語フォントは全角1文字=16px、半角1文字=8pxなので、
// 1・2行目は「全角8文字」または「それに相当する幅」以内に収めること(はみ出て見切れる)。
void showLines(const String& line1, const String& line2 = "", const String& line3 = "") {
  if (!oledReady) return;

  u8g2.clearBuffer();
  u8g2.setFont(JP_FONT);
  u8g2.drawUTF8(0, 16, line1.c_str());
  u8g2.drawUTF8(0, 34, line2.c_str());
  u8g2.setFont(ASCII_FONT);
  u8g2.drawUTF8(0, 50, line3.c_str());
  u8g2.sendBuffer();
}

// 購入者名など長さが可変な1行目(line1)を表示する。128px画面に収まるならそのまま
// 静止表示するだけでよいが、収まらない場合は右端(画面外)から左へ完全に抜けるまで
// スクロールする。line2は(空文字でなければ)常に同じ位置に固定表示する。
// スクロール時の総時間はmaxDurationMsを超えない(名前が長くてもOTA/ヒープ監視の
// チェックが長時間止まらないようにするため。最短1.5秒は確保する)。
void showScrollingMessage(const String& line1, const String& line2, unsigned long maxDurationMs) {
  if (!oledReady) return;

  u8g2.setFont(JP_FONT);
  int textWidth = u8g2.getUTF8Width(line1.c_str());
  const int screenWidth = 128;
  // このOLEDは物理的に上16px分が黄色・残り(16〜64px)が水色の2色パネルであるため、
  // 文字がその境目(y=16px)をまたぐと1文字の途中で黄色/水色に分かれて見えてしまう。
  // それを避けるため、y座標は必ず水色エリア(16px以降)に収まる値だけを使い、
  // 2色に割れて見える現象(黄色と水色が半分ずつ)を防ぐ。line2が無い(1行だけの)
  // 場合は水色エリアの縦中央に、ある場合は水色エリア内で上下に振って余白を消す。
  const int y1 = line2.length() > 0 ? 36 : 40;
  const int y2 = 54;

  if (textWidth <= screenWidth) {
    u8g2.clearBuffer();
    u8g2.setFont(JP_FONT);
    u8g2.drawUTF8(0, y1, line1.c_str());
    if (line2.length() > 0) u8g2.drawUTF8(0, y2, line2.c_str());
    u8g2.sendBuffer();
    delay(1500); // 収まる場合はそのまま少し表示するだけでよい
    return;
  }

  const unsigned long STEP_MS = 30; // フレーム間隔
  unsigned long durationMs = maxDurationMs < 1500 ? 1500 : maxDurationMs;
  int startX = screenWidth;
  int endX = -textWidth;
  long totalDistance = (long)startX - (long)endX;
  unsigned long totalSteps = durationMs / STEP_MS;
  if (totalSteps < 1) totalSteps = 1;
  for (unsigned long i = 0; i <= totalSteps; i++) {
    int x = startX - (int)((totalDistance * (long)i) / (long)totalSteps);
    u8g2.clearBuffer();
    u8g2.setFont(JP_FONT);
    u8g2.drawUTF8(x, y1, line1.c_str());
    if (line2.length() > 0) u8g2.drawUTF8(0, y2, line2.c_str());
    u8g2.sendBuffer();
    delay(STEP_MS);
  }
}

// 交渉中(まだ支払い前)であることをずっと流し続ける専用のマーキー表示。
// 購入完了などの一度きりの通知(showScrollingMessage)と違い、こちらは交渉フェーズが
// 続く限りポーリングのたびに何度も呼ばれるものなので、「ゆっくり、連続で」という
// 要望に合わせて以下を変えている:
//  - 総時間を固定せず、文字幅によらず一定の遅めの速さ(NEGOTIATING_MS_PER_PX)で流す
//    (固定時間だと名前が長いほど速く動いてしまうため)
//  - 画面に収まる短い文字列でも(showScrollingMessageと違い)必ずスクロールさせる
//  - 1回の呼び出しの中でも、時間の許す範囲(NEGOTIATING_LOOP_BUDGET_MS)で
//    パスを連続で繰り返し、流れが途切れて見えないようにする
const unsigned long NEGOTIATING_MS_PER_PX = 14; // 値が大きいほどゆっくり(≒70px/秒。前は25=約40px/秒)
const unsigned long NEGOTIATING_LOOP_BUDGET_MS = 6000; // heap監視/OTA処理を長時間止めない上限

void showNegotiatingMarquee(const String& text) {
  if (!oledReady) return;

  u8g2.setFont(JP_FONT);
  int textWidth = u8g2.getUTF8Width(text.c_str());
  const int screenWidth = 128;
  const int y = 40; // 2色パネルの黄色帯(上16px)をまたがない、水色エリアの縦中央

  int startX = screenWidth;
  int endX = -textWidth;
  long totalDistance = (long)startX - (long)endX;
  unsigned long durationMs = (unsigned long)totalDistance * NEGOTIATING_MS_PER_PX;
  if (durationMs < 1500) durationMs = 1500;

  const unsigned long STEP_MS = 30; // フレーム間隔
  unsigned long totalSteps = durationMs / STEP_MS;
  if (totalSteps < 1) totalSteps = 1;

  unsigned long loopStart = millis();
  do {
    for (unsigned long i = 0; i <= totalSteps; i++) {
      int x = startX - (int)((totalDistance * (long)i) / (long)totalSteps);
      u8g2.clearBuffer();
      u8g2.setFont(JP_FONT);
      u8g2.drawUTF8(x, y, text.c_str());
      u8g2.sendBuffer();
      delay(STEP_MS);
    }
  } while (millis() - loopStart < NEGOTIATING_LOOP_BUDGET_MS);
}

// サーボを、指定時間(durationMs)かけてゆっくり目的角度まで回す。
// Servo.write()をそのまま1回呼ぶと(SG90自体の最高速で)一瞬で動いてしまうため、
// 一定間隔(STEP_INTERVAL_MS)ごとに「目的角度までの進み具合」に応じた角度を
// 書き込むことで見た目の速度を落としている。
// 角度差(steps)で分割していた旧実装だと、角度差が小さいのに長い時間を指定した
// 場合(例: 10度だけ動かすのに0.5秒)、1度あたりの待ち時間が異常に大きくなり、
// 「1度動いて止まる」を繰り返すガクガクした動きになってしまっていた。一定間隔で
// 割合を計算する方式にすることで、角度差の大小によらず滑らかさを保てる。
// durationMs<=0またはfromAngle==toAngleの場合は従来通り即座に動かす。
// メイン・補充用どちらのサーボにも使えるよう、対象をservoで受け取る。
void moveServoSmoothly(Servo& servo, int fromAngle, int toAngle, unsigned long durationMs) {
  if (fromAngle == toAngle || durationMs == 0) {
    servo.write(toAngle);
    return;
  }
  const unsigned long STEP_INTERVAL_MS = 15; // サーボのPWM周期(約20ms)に近い間隔
  unsigned long totalSteps = durationMs / STEP_INTERVAL_MS;
  if (totalSteps < 1) totalSteps = 1;
  for (unsigned long i = 1; i <= totalSteps; i++) {
    long angle = fromAngle + ((long)(toAngle - fromAngle) * (long)i) / (long)totalSteps;
    servo.write((int)angle);
    delay(STEP_INTERVAL_MS);
  }
  servo.write(toAngle); // 割り算の丸めを吸収し、確実に目的角度で終わる
}

void unlockOnce() {
  moveServoSmoothly(gachaServo, LOCK_ANGLE, UNLOCK_ANGLE, UNLOCK_MOVE_MS);
  delay(UNLOCK_HOLD_MS);
  moveServoSmoothly(gachaServo, UNLOCK_ANGLE, LOCK_ANGLE, UNLOCK_MOVE_MS);
}

// JSONの簡易パーサ("field":"value"の形の文字列値だけを取り出す)。
// このプロジェクトの応答は単純なフラット構造なので、ライブラリを増やさずこれで十分。
String extractJsonStringField(const String& body, const String& field) {
  String needle = "\"" + field + "\":\"";
  int idx = body.indexOf(needle);
  if (idx < 0) return "";
  int start = idx + needle.length();
  int end = body.indexOf("\"", start);
  if (end < 0) return "";
  return body.substring(start, end);
}

// 上と同じ簡易パーサの数値版("field":123 の形の値を取り出す。モーターのテスト動作の
// angle/holdMsのように、引用符なしの数値フィールドを読むために使う)。
long extractJsonNumberField(const String& body, const String& field) {
  String needle = "\"" + field + "\":";
  int idx = body.indexOf(needle);
  if (idx < 0) return -1;
  int start = idx + needle.length();
  int end = start;
  while (end < (int)body.length() && (isDigit(body[end]) || body[end] == '-')) end++;
  if (end == start) return -1;
  return body.substring(start, end).toInt();
}

// サーボを実際に動かしたかどうかをbridgeに報告する。これが届かないと、bridge側は
// 一定時間後にタイムアウトとして「失敗」扱いにし、決済者に解除できなかったことを伝える
// (送金だけ成立してロックが開かない事故を、決済者に気づかせずに終わらせないための仕組み)。
void reportUnlockResult(const String& requestId, bool success) {
  if (requestId.length() == 0) return;

  String base = String(BRIDGE_URL);
  while (base.endsWith("/")) base.remove(base.length() - 1);
  String url = base + "/unlock-result";
  String payload = String("{\"requestId\":\"") + requestId + "\",\"success\":" + (success ? "true" : "false") + "}";

  for (int attempt = 0; attempt < 2; attempt++) { // 1回失敗しても1回だけ再送する
    WiFiClientSecure client;
    client.setInsecure();
    HTTPClient http;
    http.setConnectTimeout(5000);
    http.setTimeout(5000);
    if (!http.begin(client, url)) continue;
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Secret", SHARED_SECRET);
    int code = http.POST(payload);
    http.end();
    if (code == 200) {
      Serial.println("解除結果をbridgeに報告しました: " + String(success ? "成功" : "失敗"));
      return;
    }
    Serial.print("解除結果の報告に失敗(リトライ): HTTP ");
    Serial.println(code);
    delay(300);
  }
  Serial.println("解除結果の報告に最終的に失敗しました(bridge側はタイムアウトで検知します)");
}

// モーターのテスト動作(/test-move経由)を実行した結果をbridgeに報告する。
// reportUnlockResultと同じ理由(bridge側のタイムアウト検知)でリトライも同様にする。
void reportTestMoveResult(const String& requestId, bool success) {
  if (requestId.length() == 0) return;

  String base = String(BRIDGE_URL);
  while (base.endsWith("/")) base.remove(base.length() - 1);
  String url = base + "/test-move-result";
  String payload = String("{\"requestId\":\"") + requestId + "\",\"success\":" + (success ? "true" : "false") + "}";

  for (int attempt = 0; attempt < 2; attempt++) {
    WiFiClientSecure client;
    client.setInsecure();
    HTTPClient http;
    http.setConnectTimeout(5000);
    http.setTimeout(5000);
    if (!http.begin(client, url)) continue;
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Secret", SHARED_SECRET);
    int code = http.POST(payload);
    http.end();
    if (code == 200) {
      Serial.println("テスト動作の結果をbridgeに報告しました: " + String(success ? "成功" : "失敗"));
      return;
    }
    Serial.print("テスト動作結果の報告に失敗(リトライ): HTTP ");
    Serial.println(code);
    delay(300);
  }
  Serial.println("テスト動作結果の報告に最終的に失敗しました(bridge側はタイムアウトで検知します)");
}

// 補充用ロックの開閉(/admin-lock経由)を実行した結果をbridgeに報告する。
// 他のreport*関数と同じ理由(bridge側のタイムアウト検知)でリトライも同様にする。
void reportAdminLockResult(const String& requestId, bool success) {
  if (requestId.length() == 0) return;

  String base = String(BRIDGE_URL);
  while (base.endsWith("/")) base.remove(base.length() - 1);
  String url = base + "/admin-lock-result";
  String payload = String("{\"requestId\":\"") + requestId + "\",\"success\":" + (success ? "true" : "false") + "}";

  for (int attempt = 0; attempt < 2; attempt++) {
    WiFiClientSecure client;
    client.setInsecure();
    HTTPClient http;
    http.setConnectTimeout(5000);
    http.setTimeout(5000);
    if (!http.begin(client, url)) continue;
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Secret", SHARED_SECRET);
    int code = http.POST(payload);
    http.end();
    if (code == 200) {
      Serial.println("補充ロックの結果をbridgeに報告しました: " + String(success ? "成功" : "失敗"));
      return;
    }
    Serial.print("補充ロック結果の報告に失敗(リトライ): HTTP ");
    Serial.println(code);
    delay(300);
  }
  Serial.println("補充ロック結果の報告に最終的に失敗しました(bridge側はタイムアウトで検知します)");
}

IPAddress currentIP() {
  return AP_MODE ? WiFi.softAPIP() : WiFi.localIP();
}

// IPアドレスは誰でも見える待機画面には出さない(会場の誰でも読めてしまうため)。
// WiFi.status()を毎回見て接続状態を出す(テザリングを切った後も古い表示のまま
// 固まらないよう、pollBridge()から毎ポーリングごとに呼び直している)。
// 「WiFi:OK」/「WiFi:NG」という半角の小さい表示だと会場で読み取りづらかったため、
// 日本語フォント(JP_FONT)で大きく「つながってる」/「つながってない」と出す。
void showIdleScreen() {
  if (!oledReady) return;
  bool connected = AP_MODE || (WiFi.status() == WL_CONNECTED);
  u8g2.clearBuffer();
  u8g2.setFont(JP_FONT);
  u8g2.drawUTF8(0, 16, "ICHIGOGACHA");
  u8g2.drawUTF8(0, 34, "たいきちゅう");
  u8g2.drawUTF8(0, 50, connected ? "つながってる" : "つながってない");
  u8g2.sendBuffer();
}

// HTTPS(TLS)通信を数秒おきに繰り返すとESP32のメモリが徐々に減っていき、
// 十分下がるとハングすることがある(EN押下=再起動で直るのはこれが原因)。
// 本番では誰も手動でリセットできないため、危険な水準まで下がったら自分で再起動する。
const uint32_t MIN_SAFE_HEAP = 20000; // これを下回ったら自動再起動(バイト)

// ブリッジに「解除待ちある?」と問い合わせ、あればサーボを動かす
void pollBridge() {
  if (ESP.getFreeHeap() < MIN_SAFE_HEAP) {
    Serial.print("空きメモリが少なくなったため自動再起動します。空きヒープ: ");
    Serial.println(ESP.getFreeHeap());
    showLines("ICHIGOGACHA", "さいきどうします");
    delay(300);
    ESP.restart();
  }

  WiFiClientSecure client;
  client.setInsecure(); // 簡易検証用にTLS証明書の検証を省略している

  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout(5000);
  // BRIDGE_URLの末尾に"/"が付いていても二重スラッシュにならないようにする
  String base = String(BRIDGE_URL);
  while (base.endsWith("/")) base.remove(base.length() - 1);
  String url = base + "/poll-unlock";
  if (!http.begin(client, url)) {
    Serial.println("poll-unlockへの接続準備に失敗しました");
    return;
  }
  http.addHeader("X-Secret", SHARED_SECRET); // 合言葉はURLではなくヘッダーで送る

  int code = http.GET();
  Serial.print("空きヒープ: ");
  Serial.println(ESP.getFreeHeap());
  // 交渉中表示を出したポーリングでは、この後の待機画面(WiFi状態など)への
  // 切り替えをスキップする。交渉中はポーリングのたびに「待機画面→交渉中→
  // 待機画面→交渉中…」と表示が切り替わってチカチカして見えていたため、
  // 交渉が続く間は待機画面を挟まずスクロールだけを繰り返させる。
  bool negotiatingShown = false;
  bool negotiatingNow = false; // 今回のレスポンスが実際に交渉中だったか(次回のプレースホルダー判定用)
  if (code == 200) {
    String body = http.getString();
    negotiatingNow = body.indexOf("\"negotiating\":true") >= 0;
    // 解除待ち/テスト動作/補充ロック操作のいずれかを今回実行した場合はtrueにする。
    // どれも起きなかった場合だけ、下の「交渉中」表示を出す(実行中の動作の画面を
    // 上書きしてしまわないようにするため)。
    bool actionHandled = false;
    if (body.indexOf("\"unlock\":true") >= 0) {
      actionHandled = true;
      String requestId = extractJsonStringField(body, "requestId");
      // displayNameは購入者が(任意で)登録した呼び名。bridge側で既にひらがな・カタカナ・
      // 半角英数字だけに絞られているので、そのままOLEDに出しても文字が欠けない前提。
      String displayName = extractJsonStringField(body, "displayName");
      String buyerLine = displayName.length() > 0 ? (displayName + "さんがこうにゅう") : "だれかがこうにゅう";
      Serial.println("解除待ちを検知。ロック解除動作を実行します: " + displayName);
      showScrollingMessage(buyerLine, "かいじょちゅう", 4000);

      bool servoOk = gachaServo.attached();
      if (servoOk) {
        unlockOnce();
      } else {
        Serial.println("警告: サーボが接続されていません。失敗として報告します");
      }
      reportUnlockResult(requestId, servoOk);

      if (servoOk) {
        String thanksLine = displayName.length() > 0 ? (displayName + "さんありがとう!") : "ありがとう!";
        showScrollingMessage(thanksLine, "", 3000);
      } else {
        showScrollingMessage("こしょう?", "スタッフをよんで", 2500);
      }
    }

    // モーター調整用のテスト動作。角度・保持時間・回転時間はbridge側で範囲チェック済みだが、
    // ネットワーク越しに受け取った値なのでサーボ保護のため念のためもう一度clampする。
    // testServoで対象(メイン/補充)を選べる(未指定または"main"以外の値ならメイン扱い)。
    if (body.indexOf("\"testMove\":true") >= 0) {
      actionHandled = true;
      String testRequestId = extractJsonStringField(body, "testRequestId");
      String testServoName = extractJsonStringField(body, "testServo");
      long angle = constrain(extractJsonNumberField(body, "testAngle"), 0, 180);
      long holdMs = constrain(extractJsonNumberField(body, "testHoldMs"), 0, 5000);
      long moveMs = constrain(extractJsonNumberField(body, "testMoveMs"), 0, 5000);
      bool isRefill = (testServoName == "refill");
      Servo& targetServo = isRefill ? refillServo : gachaServo;
      int restAngle = isRefill ? REFILL_OPEN_ANGLE : LOCK_ANGLE; // 補充用の待機角度=デフォルトの開いた状態
      Serial.println("テスト動作を検知: servo=" + testServoName + " angle=" + String(angle) + " holdMs=" + String(holdMs) + " moveMs=" + String(moveMs));
      showLines("テストどうさ", String(angle) + "do " + String(holdMs) + "ms");

      bool servoOk = targetServo.attached();
      if (servoOk) {
        moveServoSmoothly(targetServo, targetServo.read(), (int)angle, (unsigned long)moveMs);
        delay((unsigned long)holdMs);
        moveServoSmoothly(targetServo, (int)angle, restAngle, (unsigned long)moveMs);
      } else {
        Serial.println("警告: 対象のサーボが接続されていません。失敗として報告します");
      }
      reportTestMoveResult(testRequestId, servoOk);
    }

    // 補充用ロックの開閉(管理者ページ/admin/refill-lock.htmlから)。
    // メインの解除動作と違い、動かしたらそのまま(自動で戻さない)。
    if (body.indexOf("\"adminLock\":true") >= 0) {
      actionHandled = true;
      String adminRequestId = extractJsonStringField(body, "adminRequestId");
      String adminAction = extractJsonStringField(body, "adminAction");
      int targetAngle = (adminAction == "open") ? REFILL_OPEN_ANGLE : REFILL_CLOSED_ANGLE;
      Serial.println("補充ロック操作を検知: action=" + adminAction);
      showLines("ホジュウこう", adminAction == "open" ? "あけます" : "しめます");

      bool servoOk = refillServo.attached();
      if (servoOk) {
        moveServoSmoothly(refillServo, refillServo.read(), targetAngle, REFILL_MOVE_MS);
      } else {
        Serial.println("警告: 補充用サーボが接続されていません。失敗として報告します");
      }
      reportAdminLockResult(adminRequestId, servoOk);
    }

    // 誰かがAI店番と値切り交渉中(まだ支払い前)なら、その旨をずっと流し続ける。
    // 解除待ち等の動作画面を上書きしないよう、今回actionHandledな場合は出さない。
    // negotiatingNameは客が登録した呼び名(空なら誰か分からない状態)。
    if (!actionHandled && negotiatingNow) {
      negotiatingShown = true;
      String negotiatingName = extractJsonStringField(body, "negotiatingName");
      String negotiatingLine = negotiatingName.length() > 0 ? (negotiatingName + "さんとこうしょうちゅう") : "こうしょうちゅう";
      showNegotiatingMarquee(negotiatingLine);
    }
  } else {
    Serial.print("poll-unlock失敗: HTTP ");
    Serial.println(code);
  }
  // 何が起きた後でも(何も起きなかった場合や通信失敗時も含めて)必ず待機画面に戻す。
  // WiFi状態はここで毎回再取得されるので、これが実質的な接続表示の更新タイミングになる。
  // ただし今回「交渉中」を表示した場合はここでは待機画面に切り替えない
  // (次のポーリングでまた交渉中スクロールが始まるので、そのまま左に流れ続けて見える)。
  if (!negotiatingShown) {
    showIdleScreen();
  }
  http.end();
}

void setup() {
  Serial.begin(115200);

  oledReady = u8g2.begin();
  if (!oledReady) {
    Serial.println("OLEDが見つかりませんでした(I2Cアドレスが違う可能性)。表示なしで続行します。");
  }
  showLines("ICHIGOGACHA", "きどうちゅう");

  // WiFi接続時の消費電流のピークを抑える(USB給電の電力不足によるブラウンアウト再起動対策)。
  WiFi.setTxPower(WIFI_POWER_8_5dBm);

  // サーボへの通電(電流を使う)とWiFi接続(電流を使う)が同時に起きないよう、
  // WiFi接続が終わってからサーボに通電するようにする。
  showLines("ICHIGOGACHA", "WiFiせつぞく");
  if (AP_MODE) {
    WiFi.softAP(AP_SSID, AP_PASSWORD);
    Serial.print("アクセスポイントとして起動しました。SSID: ");
    Serial.print(AP_SSID);
    Serial.print(" / パスワード: ");
    Serial.println(AP_PASSWORD);
  } else {
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.print("WiFiに接続中");
    while (WiFi.status() != WL_CONNECTED) {
      delay(500);
      Serial.print(".");
    }
    Serial.println();
  }
  // 接続が完了した瞬間を示す画面(それまでの「WiFiせつぞく」中との区別が付くように)。
  showLines("ICHIGOGACHA", "せつぞくOK");
  delay(1000);
  Serial.print("IPアドレス: ");
  Serial.println(currentIP());

  gachaServo.attach(SERVO_PIN);
  gachaServo.write(LOCK_ANGLE);
  refillServo.attach(REFILL_SERVO_PIN);
  refillServo.write(REFILL_OPEN_ANGLE); // 起動時のデフォルトは開いている状態

  // WiFi経由書き込み(OTA)の設定。Arduino IDEの「ツール」→「ポート」に
  // "ichigo-gachapon" として表示されるようになる。
  ArduinoOTA.setHostname("ichigo-gachapon");
  ArduinoOTA.onStart([]() { showLines("ICHIGOGACHA", "こうしんちゅう..."); });
  ArduinoOTA.onEnd([]() { showLines("ICHIGOGACHA", "こうしんかんりょう"); });
  ArduinoOTA.begin();
  Serial.println("OTA待受開始(Arduino IDEのポート一覧に ichigo-gachapon が出ます)");

  showIdleScreen();
}

// USBシリアル経由の手動テスト用コマンド。WiFi/bridge/HTTPを一切経由しないので、
// 「bridge経由では成功と出るのに実際は動かない」ときの切り分けに使える
// (attach()が成功=配線が正しい、を意味しないため。この関数まで来て動かなければ
// GPIO/配線/電源/サーボ本体側の物理的な問題である可能性が高い)。
// Arduino IDEのシリアルモニタで 'r' + Enter を送ると補充用サーボを開→閉と動かす。
void handleSerialCommand() {
  if (!Serial.available()) return;
  char c = Serial.read();
  if (c == 'r') {
    Serial.print("[手動テスト] 補充用サーボ attached=");
    Serial.println(refillServo.attached());
    Serial.println("[手動テスト] 補充用サーボを開けます");
    moveServoSmoothly(refillServo, refillServo.read(), REFILL_OPEN_ANGLE, REFILL_MOVE_MS);
    delay(800);
    Serial.println("[手動テスト] 補充用サーボを閉めます");
    moveServoSmoothly(refillServo, REFILL_OPEN_ANGLE, REFILL_CLOSED_ANGLE, REFILL_MOVE_MS);
    Serial.println("[手動テスト] 完了");
  }
}

void loop() {
  ArduinoOTA.handle();
  handleSerialCommand();

  if (millis() - lastPollAt >= POLL_INTERVAL_MS) {
    lastPollAt = millis();
    pollBridge();
  }
}
