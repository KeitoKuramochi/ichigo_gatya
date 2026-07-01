/*
  Step 0: サーボ単体動作確認スケッチ
  ------------------------------------------------
  目的: ネットワークもガチャの仕組みも一切関係なく、
        「ESP32 + SG90サーボ」の配線と動きだけを確認する。

  【配線】(ブレッドボード経由でOK)
    SG90の線          ESP32側
    -----------------------------
    オレンジ(信号)  -> GPIO18
    赤(+)           -> ESP32の "VIN" ピン
    茶 or 黒(GND)   -> ESP32の "GND" ピン

  【使い方】
    1. Arduino IDEのライブラリマネージャで
       "ESP32Servo" (by Kevin Harrington / madhephaestus) をインストール
    2. ボードとして使っているESP32を選び、このスケッチを書き込む
    3. シリアルモニタを開く(通信速度: 115200)
    4. "u" と入力してEnterを押すと、サーボが
       ロック位置(0度) -> 解除位置(90度) -> ロック位置(0度)
       と1往復する

  次のStep 1では、この「サーボを1往復させる」処理を
  HTTPサーバーの /unlock エンドポイントから呼び出す形に変える。
*/

#include <ESP32Servo.h>

const int SERVO_PIN = 18;
const int LOCK_ANGLE = 0;     // カプセルをせき止める(ロック)角度
const int UNLOCK_ANGLE = 90;  // ゲートを開ける(解除)角度
const int UNLOCK_HOLD_MS = 400; // 解除位置で待つ時間(ミリ秒)

Servo gachaServo;

void unlockOnce() {
  Serial.println("解除動作: ロック解除 -> カプセル1個排出 -> ロックに戻す");
  gachaServo.write(UNLOCK_ANGLE);
  delay(UNLOCK_HOLD_MS);
  gachaServo.write(LOCK_ANGLE);
}

void setup() {
  Serial.begin(115200);
  gachaServo.attach(SERVO_PIN);
  gachaServo.write(LOCK_ANGLE); // 起動時はロック位置にしておく

  Serial.println("Step0 サーボ単体テスト起動完了");
  Serial.println("シリアルモニタで 'u' + Enter を送るとロック解除動作を1回行います");
}

void loop() {
  if (Serial.available() > 0) {
    char c = Serial.read();
    if (c == 'u') {
      unlockOnce();
    }
  }
}
