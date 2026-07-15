import { randomInt } from "node:crypto";

// オンライン参加者向け景品(記念画像)プール。NFTのmintは行わず、この画像を
// その場で見せる/保存させるだけ(id/weight/画像の差し替えは自由)。
// image は bridge/nft-images/ 以下のファイル名(実画像が用意でき次第、プレースホルダーから差し替える)。
export const PRIZE_POOL = [
  { id: 1, name: "いちごほし(仮)", weight: 18, image: "prize-1.png" },
  { id: 2, name: "いちごつぶ(仮)", weight: 18, image: "prize-2.png" },
  { id: 3, name: "いちごリボン(仮)", weight: 18, image: "prize-3.png" },
  { id: 4, name: "いちごクラウン(仮)", weight: 18, image: "prize-4.png" },
  { id: 5, name: "いちごスター(仮)", weight: 18, image: "prize-5.png" },
  // 手描きイラスト枠。合計100のうち10 = 10%の低確率(何度でも出うる、一点物ではない)。
  { id: 6, name: "てがきスペシャル(仮)", weight: 10, image: "prize-6-special.png" },
];

/**
 * weight(重み)に基づく加重ランダム抽選。
 * @param {Array} pool - 省略時はPRIZE_POOLを使う(テスト用に差し替え可能にしている)
 * @returns {{id:number, name:string, weight:number, image:string}}
 */
export function pickPrize(pool = PRIZE_POOL) {
  const total = pool.reduce((sum, p) => sum + p.weight, 0);
  if (total <= 0) {
    throw new Error("PRIZE_POOL: weightの合計が0以下です");
  }
  // 実際にICHIGOを払った上での抽選(特に低確率の手描きレア枠)なので、公平性の観点から
  // Math.random()(暗号論的に安全ではなく、理論上は出力から内部状態を推測されうる)ではなく
  // 暗号学的に安全な乱数(crypto.randomInt、整数専用なのでweightが整数である前提と相性がよい)を使う。
  let r = randomInt(0, total);
  for (const prize of pool) {
    r -= prize.weight;
    if (r < 0) return prize;
  }
  return pool[pool.length - 1]; // 念のための保険(整数演算なので本来ここには来ない)
}

/** オンラインページの「サンプル/モザイク表示」用。実画像URLは含めない(ネタバレ防止)。 */
export function getPrizeTeasers(pool = PRIZE_POOL) {
  const total = pool.reduce((sum, p) => sum + p.weight, 0);
  return pool.map((p) => ({
    id: p.id,
    name: p.name,
    rarityPercent: Math.round((p.weight / total) * 100),
  }));
}
