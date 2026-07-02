/*
  Step 1: ESP32 ポーリング型ガチャガチャ制御 + OLED表示(日本語対応) + OTA
  ------------------------------------------------
  Step 0の配線・動作確認ができたら、このスケッチに切り替える。

  やること:
    - WiFi(スマホのテザリング等、インターネットに出られるものなら何でもよい)に接続する
    - 数秒おきに、ブリッジサーバーの /poll-unlock に「解除待ちある?」と問い合わせる
    - 「ある」と返ってきたらサーボでロック解除動作を1回行う
    - 基板内蔵の0.96インチOLED(SSD1306, I2C)に日本語で状態を表示する
    - 2回目以降の書き込みはUSB不要、WiFi経由(OTA)でできる

  ブリッジと同じLANにいる必要はない(ブリッジはcloudflared等でインターネットに
  公開されている前提。ESP32側はインターネットに出られるWiFiであればどこでもよい)。

  【配線】(Step 0と同じ。OLEDは基板に内蔵済みなので追加配線不要)
    SG90 オレンジ(信号) -> GPIO18
    SG90 赤(+)          -> ESP32の "VIN" ピン
    SG90 茶/黒(GND)     -> ESP32の "GND" ピン

  書き込み前に、下の WIFI_SSID / WIFI_PASSWORD / BRIDGE_URL / SHARED_SECRET を
  自分の環境に合わせて書き換えること。SHARED_SECRET は
  bridge/.env の ESP32_SECRET と必ず同じ文字列にする。
  BRIDGE_URL は cloudflared 等で発行された「その日の」公開URL(https://から)。
  トンネルを再起動すると変わるので、その都度ここを書き換えて再書き込みが必要。

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
const char* BRIDGE_URL = "https://involving-ourselves-raise-headquarters.trycloudflare.com";
const char* SHARED_SECRET = "ichigo123"; // bridge/.envのESP32_SECRETと揃える

const unsigned long POLL_INTERVAL_MS = 2000; // 何ms間隔でブリッジに問い合わせるか
// ↑↑↑ ここまで ↑↑↑

const int SERVO_PIN = 18;
const int LOCK_ANGLE = 0;
const int UNLOCK_ANGLE = 90;
const int UNLOCK_HOLD_MS = 400;

// このボードのOLEDは 128x64, I2Cアドレス0x3C, SDA=GPIO21/SCL=GPIO22(基板内蔵配線)
// 画面が真っ白/真っ暗のままなら、末尾を _F_HW_I2C のまま別コンストラクタ
// (例: U8G2_SSD1306_128X64_NONAME_2_HW_I2C)に替えて試してみること。
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, /* reset=*/ U8X8_PIN_NONE);
bool oledReady = false;

const uint8_t* JP_FONT = u8g2_font_unifont_t_japanese1; // ひらがな/カタカナ表示用
const uint8_t* ASCII_FONT = u8g2_font_6x10_tf;           // IPアドレスなど半角文字用

Servo gachaServo;
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

void unlockOnce() {
  gachaServo.write(UNLOCK_ANGLE);
  delay(UNLOCK_HOLD_MS);
  gachaServo.write(LOCK_ANGLE);
}

IPAddress currentIP() {
  return AP_MODE ? WiFi.softAPIP() : WiFi.localIP();
}

void showIdleScreen() {
  showLines("ICHIGO", "たいきちゅう", "IP: " + currentIP().toString());
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
    showLines("ICHIGO", "さいきどうします");
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
  if (code == 200) {
    String body = http.getString();
    if (body.indexOf("\"unlock\":true") >= 0) {
      Serial.println("解除待ちを検知。ロック解除動作を実行します");
      showLines("かいじょ!", "だしています", "");
      unlockOnce();
      showIdleScreen();
    }
  } else {
    Serial.print("poll-unlock失敗: HTTP ");
    Serial.println(code);
  }
  http.end();
}

void setup() {
  Serial.begin(115200);

  oledReady = u8g2.begin();
  if (!oledReady) {
    Serial.println("OLEDが見つかりませんでした(I2Cアドレスが違う可能性)。表示なしで続行します。");
  }
  showLines("ICHIGO", "きどうちゅう");

  // WiFi接続時の消費電流のピークを抑える(USB給電の電力不足によるブラウンアウト再起動対策)。
  WiFi.setTxPower(WIFI_POWER_8_5dBm);

  // サーボへの通電(電流を使う)とWiFi接続(電流を使う)が同時に起きないよう、
  // WiFi接続が終わってからサーボに通電するようにする。
  showLines("ICHIGO", "WiFiせつぞく");
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
  Serial.print("IPアドレス: ");
  Serial.println(currentIP());

  gachaServo.attach(SERVO_PIN);
  gachaServo.write(LOCK_ANGLE);

  // WiFi経由書き込み(OTA)の設定。Arduino IDEの「ツール」→「ポート」に
  // "ichigo-gachapon" として表示されるようになる。
  ArduinoOTA.setHostname("ichigo-gachapon");
  ArduinoOTA.onStart([]() { showLines("ICHIGO", "こうしんちゅう..."); });
  ArduinoOTA.onEnd([]() { showLines("ICHIGO", "こうしんかんりょう"); });
  ArduinoOTA.begin();
  Serial.println("OTA待受開始(Arduino IDEのポート一覧に ichigo-gachapon が出ます)");

  showIdleScreen();
}

void loop() {
  ArduinoOTA.handle();

  if (millis() - lastPollAt >= POLL_INTERVAL_MS) {
    lastPollAt = millis();
    pollBridge();
  }
}
