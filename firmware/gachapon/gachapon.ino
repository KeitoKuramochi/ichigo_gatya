/*
  Step 1: ESP32 HTTPサーバー + サーボ解除 + OLED表示(日本語対応)
  ------------------------------------------------
  Step 0の配線・動作確認ができたら、このスケッチに切り替える。

  やること:
    - WiFiに接続してローカルIPアドレスを取得する
    - POST /unlock を受け取ったら、ヘッダー X-Secret を確認し、
      合っていればサーボでロック解除動作を1回行う
    - シリアルモニタに表示されるIPアドレスを、
      bridge/.env の ESP32_IP に設定する(Step 2で使う)
    - 基板内蔵の0.96インチOLED(SSD1306, I2C)に日本語で状態を表示する

  【配線】(Step 0と同じ。OLEDは基板に内蔵済みなので追加配線不要)
    SG90 オレンジ(信号) -> GPIO18
    SG90 赤(+)          -> ESP32の "VIN" ピン
    SG90 茶/黒(GND)     -> ESP32の "GND" ピン

  書き込み前に、下の WIFI_SSID / WIFI_PASSWORD / SHARED_SECRET を
  自分の環境に合わせて書き換えること。SHARED_SECRET は
  bridge/.env の ESP32_SECRET と必ず同じ文字列にする。
  ※ SHARED_SECRETはHTTPヘッダーの値として送るため、半角英数字にすること
    (日本語などの非ASCII文字は正しく送受信できないことがある)。

  必要な追加ライブラリ(ライブラリマネージャからインストール):
    - "U8g2" (by oliver / olikraus) — 日本語表示用のフォントを内蔵している。
      前のバージョンで使っていた Adafruit SSD1306 / Adafruit GFX は
      このスケッチではもう使わない(入れっぱなしでも問題ない)。

  表示メッセージを増やしたいとき(拡張のしかた):
    showLines(1行目, 2行目, 3行目) を好きな場所で呼ぶだけでよい。
    1・2行目は日本語フォント、3行目はIPアドレスなど半角文字用の
    小さいフォントで表示される。新しい状態(例: ガチャの結果表示など)を
    増やすときも、この関数を呼ぶ処理を1行足すだけで対応できる。

  ※ OLED用の日本語フォント(u8g2_font_unifont_t_japanese1)は、
    ひらがな・カタカナはほぼ問題なく表示できるが、漢字は収録数が
    限られている。実機で確認しながら文言を調整すること
    (このスケッチのメッセージは念のためひらがな/カタカナ中心にしてある)。

  動作確認(PCのターミナルから、ESP32と同じWiFiに繋いだ状態で):
    curl -X POST http://<ESP32のIPアドレス>/unlock -H "X-Secret: <SHARED_SECRETと同じ文字列>"
*/

#include <WiFi.h>
#include <WebServer.h>
#include <ESP32Servo.h>
#include <U8g2lib.h>

// ↓↓↓ ここを自分の環境に合わせて書き換える ↓↓↓
// AP_MODE = true  : ESP32自身がWiFi電波を出す(スマホ/PCをそのWiFiに直接つなぐ)。
//                    ネットワーク周りのトラブルを避けて今すぐ動作確認したいときはこちら。
// AP_MODE = false : 既存のWiFi(WIFI_SSID)に子機として参加する。bridgeサーバーと組み合わせる本番用。
const bool AP_MODE = true;

const char* WIFI_SSID = "kirinsan";
const char* WIFI_PASSWORD = "keito0215";

const char* AP_SSID = "ICHIGO-GACHAPON";
const char* AP_PASSWORD = "ichigo1234"; // 8文字以上必須

const char* SHARED_SECRET = "ichigo123"; // 半角英数字にすること(bridge/.envのESP32_SECRETと揃える)
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
WebServer server(80);

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

void handleUnlock() {
  if (server.method() != HTTP_POST) {
    server.send(405, "text/plain", "POST only");
    return;
  }

  String secret = server.header("X-Secret");
  if (secret.length() == 0 || secret != SHARED_SECRET) {
    Serial.println("認証失敗: 不正なリクエストを拒否しました");
    server.send(403, "text/plain", "forbidden");
    return;
  }

  Serial.println("/unlock を受信。ロック解除動作を実行します");
  showLines("かいじょ!", "だしています", "");
  unlockOnce();
  server.send(200, "text/plain", "unlocked");
  showIdleScreen();
}

void handleNotFound() {
  server.send(404, "text/plain", "not found");
}

void setup() {
  Serial.begin(115200);

  oledReady = u8g2.begin();
  if (!oledReady) {
    Serial.println("OLEDが見つかりませんでした(I2Cアドレスが違う可能性)。表示なしで続行します。");
  }
  showLines("ICHIGO", "きどうちゅう");

  gachaServo.attach(SERVO_PIN);
  gachaServo.write(LOCK_ANGLE);

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
  Serial.println("このIPアドレスを bridge/.env の ESP32_IP に設定してください");

  // X-Secretヘッダーはデフォルトでは読み取れないため、明示的に登録しておく
  const char* headerKeys[] = {"X-Secret"};
  server.collectHeaders(headerKeys, 1);

  server.on("/unlock", HTTP_POST, handleUnlock);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("HTTPサーバー起動完了。POST /unlock で待受中です");

  showIdleScreen();
}

void loop() {
  server.handleClient();
}
