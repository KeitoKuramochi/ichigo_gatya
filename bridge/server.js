// Step 2: ICHIGO送金の検証ブリッジ
//
// payment/index.html から送金成功時の txHash を受け取り、Optimism上で
// 「本当にGAME_WALLET宛にCOST以上のICHIGOが送られたか」をオンチェーンで検証する。
//
// ESP32とはローカルネットワークで直接繋がっているとは限らない(スマホのテザリング等、
// 別ネットワークにいることがある)ため、ブリッジからESP32へ直接リクエストは送らない。
// 代わりに、ESP32側が数秒おきにこのブリッジの /poll-unlock を問い合わせに来る
// (ポーリング)方式にしている。ブリッジはインターネット上に公開されている
// (cloudflaredトンネル等)前提なので、ESP32はインターネットさえ繋がっていればよい。
//
// 起動方法:
//   cp .env.example .env  (中身を自分の環境に合わせて編集)
//   npm install
//   npm start

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getNegotiationReply } from './negotiation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_DIR = path.join(__dirname, '..', 'payment');
const TEST_DIR = path.join(__dirname, '..', 'test');
const ADMIN_DIR = path.join(__dirname, '..', 'admin');
const NEGOTIATE_DIR = path.join(__dirname, '..', 'negotiate');
const SPECTATOR_DIR = path.join(__dirname, '..', 'spectator');
const USED_TX_FILE = path.join(__dirname, 'used-tx-hashes.json');

// 確定から一定ブロック数経つまでは「まだ覆る可能性がある」として受け付けない
const MIN_CONFIRMATIONS = 2;
// 支払いから一定時間以上経過したtxHashは、後から使い回されるのを防ぐため受け付けない
const MAX_TX_AGE_SECONDS = 15 * 60;
// ESP32が解除指示を受け取ってから、実行結果(成功/失敗)を報告してくるまでの待ち時間。
// これを過ぎても報告が無ければ「失敗」とみなし、決済者に解除できなかったことを伝える
// (これが無いと、送金だけ成立してロックは開かない、という事故に誰も気づけない)。
const UNLOCK_ESP32_TIMEOUT_MS = 15 * 1000;
// ESP32がオフライン等で解除リクエストを一度も取得しに来ないまま放置される時間の上限。
// これが無いと、支払いからずっと後にESP32が復帰した際、無関係なタイミングで
// 古い支払いの解除が実行されてしまう(誰もいない時にカプセルが出る事故)を防げない。
const PENDING_MAX_AGE_MS = 5 * 60 * 1000;
// モーターのテスト動作(/test-move)がESP32から結果報告されるまでの待ち時間
const TEST_MOVE_TIMEOUT_MS = 10 * 1000;
// モーターのテスト動作で受け付ける角度・保持時間の範囲(サーボ・機構の可動範囲を超えないようにする)
const TEST_MOVE_MIN_ANGLE = 0;
const TEST_MOVE_MAX_ANGLE = 180;
const TEST_MOVE_MIN_HOLD_MS = 50;
const TEST_MOVE_MAX_HOLD_MS = 5000;
// 回転そのものにかける時間(0=瞬時に動く、従来通り)
const TEST_MOVE_MIN_MOVE_MS = 0;
const TEST_MOVE_MAX_MOVE_MS = 5000;
// 補充用ロックの開閉(/admin-lock)がESP32から結果報告されるまでの待ち時間
const ADMIN_LOCK_TIMEOUT_MS = 10 * 1000;

const {
  RPC_URL,
  TOKEN_ADDR,
  GAME_WALLET,
  COST,
  ESP32_SECRET,
  PORT = 3001,
} = process.env;

// ESP32_SECRETが無いと/poll-unlockの認証が成立しないため、他の値と同様に必須にする
// (未設定を「認証なし」として素通りさせない = fail closed)。
for (const [name, value] of Object.entries({ RPC_URL, TOKEN_ADDR, GAME_WALLET, COST, ESP32_SECRET })) {
  if (!value) {
    console.error(`環境変数 ${name} が設定されていません。.env を確認してください。`);
    process.exit(1);
  }
}

// AI店番エージェント(値切り交渉)は完全にオプトインの機能。ANTHROPIC_API_KEYと
// NEGOTIATE_FLOOR_COSTの両方が設定されている場合のみ有効にし、/negotiate-*ルート自体を
// 登録する。未設定の環境(開発機・APIキー未取得時など)では今までの起動シーケンス・
// 挙動を一切変えない(fail closedではなくfeature-optional、という設計)。
const {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001',
  // Anthropicが障害・タイムアウト等で応答できなかった場合だけのフォールバック先。
  // 未設定ならフォールバックせず、従来通り(詫び文言・ターン非消費)にとどまる。
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemini-2.0-flash',
  NEGOTIATE_FLOOR_COST,
  NEGOTIATE_ABSOLUTE_FLOOR = '0',
  NEGOTIATE_MAX_TURNS = '4',
  NEGOTIATE_QUOTE_TTL_MS = String(10 * 60 * 1000),
} = process.env;

const NEGOTIATION_ENABLED = Boolean(ANTHROPIC_API_KEY && NEGOTIATE_FLOOR_COST);
const NEGOTIATE_MAX_TURNS_NUM = parseInt(NEGOTIATE_MAX_TURNS, 10);
const NEGOTIATE_ABSOLUTE_FLOOR_NUM = parseFloat(NEGOTIATE_ABSOLUTE_FLOOR);
const NEGOTIATE_QUOTE_TTL_MS_NUM = parseInt(NEGOTIATE_QUOTE_TTL_MS, 10);
const NEGOTIATE_FLOOR_COST_NUM = NEGOTIATE_FLOOR_COST ? parseFloat(NEGOTIATE_FLOOR_COST) : null;

if (NEGOTIATION_ENABLED && !(NEGOTIATE_FLOOR_COST_NUM >= 0 && NEGOTIATE_FLOOR_COST_NUM <= Number(COST))) {
  console.error('NEGOTIATE_FLOOR_COSTは0以上COST以下の数値で設定してください。.envを確認してください。');
  process.exit(1);
}
if (NEGOTIATION_ENABLED && !(NEGOTIATE_ABSOLUTE_FLOOR_NUM >= 0 && NEGOTIATE_ABSOLUTE_FLOOR_NUM <= NEGOTIATE_FLOOR_COST_NUM)) {
  console.error('NEGOTIATE_ABSOLUTE_FLOORは0以上NEGOTIATE_FLOOR_COST以下の数値で設定してください。.envを確認してください。');
  process.exit(1);
}

console.log(
  NEGOTIATION_ENABLED
    ? `AI店番エージェント(値切り交渉)機能: 有効(通常フロア=${NEGOTIATE_FLOOR_COST_NUM} ICHIGO, 会話の質次第で最大${NEGOTIATE_ABSOLUTE_FLOOR_NUM} ICHIGOまで, 最大${NEGOTIATE_MAX_TURNS_NUM}ターン, Geminiフォールバック=${GEMINI_API_KEY ? '有効' : '無効'})`
    : 'AI店番エージェント(値切り交渉)機能: 無効(ANTHROPIC_API_KEY / NEGOTIATE_FLOOR_COSTが未設定)'
);

const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function decimals() view returns (uint8)',
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const tokenInterface = new ethers.Interface(ERC20_ABI);
const tokenContract = new ethers.Contract(TOKEN_ADDR, ERC20_ABI, provider);

// プロセス再起動をまたいでも二重使用を防げるよう、使用済みtxHashをファイルに永続化する
function loadUsedTxHashes() {
  try {
    const raw = fs.readFileSync(USED_TX_FILE, 'utf8');
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}
function saveUsedTxHashes() {
  fs.writeFileSync(USED_TX_FILE, JSON.stringify([...usedTxHashes]));
}

const usedTxHashes = loadUsedTxHashes();
let tokenDecimals;
let costInWei;

async function loadTokenDecimals() {
  tokenDecimals = await tokenContract.decimals();
  costInWei = ethers.parseUnits(String(COST), tokenDecimals);
  console.log(`ICHIGOトークンのdecimals=${tokenDecimals}, COST=${COST} ICHIGO (=${costInWei.toString()} wei相当)`);
}

// receiptがまだ取得できない(ブロック伝播待ち)場合や、確定ブロック数が
// MIN_CONFIRMATIONSに達していない場合に備えて数回リトライする
async function getConfirmedReceiptWithRetry(txHash, attempts = 10, delayMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) {
      const currentBlock = await provider.getBlockNumber();
      const confirmations = currentBlock - receipt.blockNumber + 1;
      if (confirmations >= MIN_CONFIRMATIONS) return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

// 古い(すでに一度支払いに使われた可能性のある)txHashを後から使い回されないよう、
// トランザクションが含まれるブロックの時刻が新しいことを確認する
async function isRecentEnough(receipt) {
  const block = await provider.getBlock(receipt.blockNumber);
  const ageSeconds = Date.now() / 1000 - block.timestamp;
  return ageSeconds <= MAX_TX_AGE_SECONDS;
}

// minWeiを省略した場合は従来通りグローバルなCOSTを最低額とする。値切り交渉セッション
// (sessionId)経由の場合だけ、呼び出し側がそのセッションの確定価格(finalPriceWei)を渡す。
function findValidTransfer(receipt, minWei = costInWei) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== TOKEN_ADDR.toLowerCase()) continue;

    let parsed;
    try {
      parsed = tokenInterface.parseLog(log);
    } catch {
      continue; // このトークンコントラクトの別イベント、もしくは無関係なログ
    }

    if (parsed?.name !== 'Transfer') continue;
    if (parsed.args.to.toLowerCase() !== GAME_WALLET.toLowerCase()) continue;
    if (parsed.args.value < minWei) continue;

    return parsed;
  }
  return null;
}

// 解除リクエストをtxHashごとに状態管理する(メモリ上だけで十分。ブリッジが
// 再起動したら未処理のリクエスト自体が失われるが、その場合は決済ページ側の
// ポーリングがタイムアウトしてユーザーに「解除確認できず」を伝えるので事故にはならない)。
//
// 状態遷移: pending(検証OK、ESP32のポーリング待ち)
//         → dispatched(ESP32が/poll-unlockで取得、実行結果報告待ち)
//         → unlocked(ESP32が成功報告) / failed(ESP32が失敗報告、またはタイムアウト)
const unlockRequests = new Map(); // txHash -> { status, createdAt, dispatchedAt? }

// モーターのテスト動作(角度・保持時間を指定して1回動かす)のリクエストを管理する。
// unlockRequestsと同じ状態遷移(pending → dispatched → done/failed)だが、
// キーがtxHashではなくランダムなrequestIdである点だけが違う。
const testMoveRequests = new Map(); // requestId -> { status, angle, holdMs, createdAt, dispatchedAt? }

// 補充用ロックの開閉(管理者ページから)のリクエストを管理する。
// unlockRequests/testMoveRequestsと同じ状態遷移(pending → dispatched → done/failed)。
const adminLockRequests = new Map(); // requestId -> { status, action, createdAt, dispatchedAt? }

// pending/dispatchedのまま古くなったリクエストをfailedに倒し、完了済みリクエストを
// 一定時間後にメモリから捨てる。各エンドポイントの先頭で毎回呼ぶ。
function sweepStaleUnlockRequests() {
  const now = Date.now();
  for (const [txHash, request] of unlockRequests) {
    if (request.status === 'pending' && now - request.createdAt > PENDING_MAX_AGE_MS) {
      request.status = 'failed';
      request.failReason = 'esp32-offline';
      console.warn(`ESP32が一定時間ポーリングに来ず、解除リクエストを失効させました: ${txHash}`);
    } else if (request.status === 'dispatched' && now - request.dispatchedAt > UNLOCK_ESP32_TIMEOUT_MS) {
      request.status = 'failed';
      request.failReason = 'esp32-timeout';
      console.warn(`解除結果がESP32から届かずタイムアウトしました: ${txHash}`);
    }
    if ((request.status === 'unlocked' || request.status === 'failed') && now - request.createdAt > 60 * 60 * 1000) {
      unlockRequests.delete(txHash);
    }
  }
}

// testMoveRequests版のsweep(ロジックはsweepStaleUnlockRequestsと同じだが、
// 対象マップ・タイムアウト時間・完了ステータス名(done)が異なる)
function sweepStaleTestMoveRequests() {
  const now = Date.now();
  for (const [requestId, request] of testMoveRequests) {
    if (request.status === 'pending' && now - request.createdAt > PENDING_MAX_AGE_MS) {
      request.status = 'failed';
      request.failReason = 'esp32-offline';
    } else if (request.status === 'dispatched' && now - request.dispatchedAt > TEST_MOVE_TIMEOUT_MS) {
      request.status = 'failed';
      request.failReason = 'esp32-timeout';
    }
    if ((request.status === 'done' || request.status === 'failed') && now - request.createdAt > 60 * 60 * 1000) {
      testMoveRequests.delete(requestId);
    }
  }
}

// adminLockRequests版のsweep(ロジックはtestMoveRequests版と同じ)
function sweepStaleAdminLockRequests() {
  const now = Date.now();
  for (const [requestId, request] of adminLockRequests) {
    if (request.status === 'pending' && now - request.createdAt > PENDING_MAX_AGE_MS) {
      request.status = 'failed';
      request.failReason = 'esp32-offline';
    } else if (request.status === 'dispatched' && now - request.dispatchedAt > ADMIN_LOCK_TIMEOUT_MS) {
      request.status = 'failed';
      request.failReason = 'esp32-timeout';
    }
    if ((request.status === 'done' || request.status === 'failed') && now - request.createdAt > 60 * 60 * 1000) {
      adminLockRequests.delete(requestId);
    }
  }
}

// AI店番エージェントとの値切り交渉セッション。実機は1台なので同時に1交渉で十分、
// という前提で「今どのセッションが進行中か」をcurrentSessionIdで単一管理する
// (投影用ページ/spectatorはこれを見るだけでよく、sessionIdを別途知る必要がない)。
//
// 状態遷移: negotiating(チャット中) → awaiting-payment(価格確定、支払い待ち)
//         → redeemed(支払い済み・解除リクエスト発行済み) / expired(放置・期限切れ)
const negotiationSessions = new Map(); // sessionId -> {status, wallet, transcript, ...}
let currentSessionId = null;

const NEGOTIATE_SESSION_IDLE_MAX_AGE_MS = 10 * 60 * 1000; // 交渉中のまま放置されたセッションのタイムアウト
// /negotiate-startの濫用でAPIコストが膨らまないよう、新規セッション開始数だけ緩く抑える
// (教室内デモ相応の軽さでよく、IP単位のレート制限等までは行わない)。
const NEGOTIATE_START_RATE_LIMIT = 100;
const NEGOTIATE_START_RATE_WINDOW_MS = 60 * 60 * 1000;
let negotiateStartTimestamps = [];

function canStartNewNegotiationSession() {
  const now = Date.now();
  negotiateStartTimestamps = negotiateStartTimestamps.filter((t) => now - t < NEGOTIATE_START_RATE_WINDOW_MS);
  if (negotiateStartTimestamps.length >= NEGOTIATE_START_RATE_LIMIT) return false;
  negotiateStartTimestamps.push(now);
  return true;
}

// negotiationSessions版のsweep(他の3つと同じ形: 放置されたものをexpiredに倒し、
// 完了済み・期限切れのものを一定時間後にMapから削除する)。
function sweepStaleNegotiationSessions() {
  const now = Date.now();
  for (const [sessionId, session] of negotiationSessions) {
    // lastActivityAt(直前の操作時刻)基準。createdAt基準にすると、参加者が途切れず
    // 会話を続けていてもセッション開始からの総経過時間だけで強制終了してしまう
    // (「放置」の検出になっていなかった、という不具合の修正)。
    if (session.status === 'negotiating' && now - session.lastActivityAt > NEGOTIATE_SESSION_IDLE_MAX_AGE_MS) {
      session.status = 'expired';
    } else if (
      session.status === 'awaiting-payment' &&
      session.quoteExpiresAt &&
      now > session.quoteExpiresAt
    ) {
      session.status = 'expired';
    }
    if (session.status === 'expired' && currentSessionId === sessionId) {
      currentSessionId = null;
    }
    if ((session.status === 'redeemed' || session.status === 'expired') && now - session.createdAt > 60 * 60 * 1000) {
      negotiationSessions.delete(sessionId);
    }
  }
}

// 交渉を確定させ、以後/verify-and-unlockで使う確定額(finalPriceWei)を固める。
//
// 通常の値切り(ターンごとのclamp)はNEGOTIATE_FLOOR_COSTまでしか下がらない。それより下、
// NEGOTIATE_ABSOLUTE_FLOORまでの追加ボーナスは、会話の質(session.lastQuality, 0〜100。
// モデルが毎ターン「機転・説得力・楽しさ」を評価した値)に比例して適用する。
// 「価格が下がるのは運ではなく会話内容の良さであるべき」という方針なので、抽選は行わない。
function finalizeNegotiationSession(session) {
  const bonusRange = NEGOTIATE_FLOOR_COST_NUM - NEGOTIATE_ABSOLUTE_FLOOR_NUM;
  const qualityBonus = (Math.max(0, Math.min(100, session.lastQuality)) / 100) * bonusRange;
  const priceAfterBonus = Math.round(session.currentPrice - qualityBonus);
  session.currentPrice = Math.max(NEGOTIATE_ABSOLUTE_FLOOR_NUM, priceAfterBonus);

  session.finalPriceWei = ethers.parseUnits(String(session.currentPrice), tokenDecimals);
  session.quoteExpiresAt = Date.now() + NEGOTIATE_QUOTE_TTL_MS_NUM;
  session.status = 'awaiting-payment';
}

function maskWallet(wallet) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

const app = express();
app.use(cors()); // Vercel等、別オリジンで配信されたpayment/index.htmlからも叩けるようにする
app.use(express.json());
app.use(express.static(GAME_DIR)); // 同じオリジンでpayment/を配信(スマホからも同じIP:PORTで開ける)
app.use('/test', express.static(TEST_DIR)); // モーターのテスト用ページを/test/以下で配信
app.use('/admin', express.static(ADMIN_DIR)); // 補充用ロックの管理者ページを/admin/以下で配信
app.use('/negotiate', express.static(NEGOTIATE_DIR)); // AI店番との値切り交渉ページを/negotiate/以下で配信
app.use('/spectator', express.static(SPECTATOR_DIR)); // 交渉の様子を投影する観客用ページを/spectator/以下で配信

app.post('/verify-and-unlock', async (req, res) => {
  const { txHash, sessionId } = req.body ?? {};

  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return res.status(400).json({ ok: false, error: 'txHashの形式が不正です' });
  }

  // sessionIdが付いている場合(値切り交渉経由)だけ、その交渉で確定した価格・ウォレットを使う。
  // 付いていない場合(payment/index.htmlからの従来の決済)は今までと1バイトも挙動を変えない。
  let session = null;
  if (sessionId !== undefined) {
    if (typeof sessionId !== 'string') {
      return res.status(400).json({ ok: false, error: 'sessionIdの形式が不正です' });
    }
    sweepStaleNegotiationSessions();
    session = negotiationSessions.get(sessionId);
    if (!session || session.status !== 'awaiting-payment') {
      return res.status(400).json({ ok: false, error: '交渉結果が見つからないか、まだ価格が確定していません' });
    }
    if (session.quoteExpiresAt && Date.now() > session.quoteExpiresAt) {
      return res.status(400).json({ ok: false, error: '確定した価格の有効期限が切れています。もう一度交渉からやり直してください' });
    }
  }

  if (usedTxHashes.has(txHash)) {
    return res.status(409).json({ ok: false, error: 'このtxHashはすでに使用済みです' });
  }

  try {
    const receipt = await getConfirmedReceiptWithRetry(txHash);
    if (!receipt) {
      return res.status(404).json({ ok: false, error: 'トランザクションが見つからないか、まだ十分に確定していません' });
    }
    if (receipt.status !== 1) {
      return res.status(400).json({ ok: false, error: 'トランザクションが失敗しています' });
    }
    if (!(await isRecentEnough(receipt))) {
      return res.status(400).json({ ok: false, error: '古すぎる取引です(過去の送金の使い回しは無効)' });
    }

    const transfer = findValidTransfer(receipt, session ? session.finalPriceWei : undefined);
    if (!transfer) {
      return res.status(400).json({ ok: false, error: 'GAME_WALLET宛の有効なICHIGO送金が見つかりません' });
    }

    // セッション経由の場合、送金元が「その価格を交渉した本人」と一致することを必須にする。
    // これが無いと、sessionId(推測不能なUUIDだが通信は見える)を知っている誰でも他人の
    // 値切り済み価格を使い回せてしまう。Transfer.fromはチェーンが保証する事実なので偽装できない。
    if (session && transfer.args.from.toLowerCase() !== session.wallet) {
      return res.status(400).json({ ok: false, error: '送金元のウォレットが交渉時と一致しません' });
    }

    // 二重チェック: リトライ中に別リクエストが同じtxHashを先に使用済みにしていないか再確認
    if (usedTxHashes.has(txHash)) {
      return res.status(409).json({ ok: false, error: 'このtxHashはすでに使用済みです' });
    }
    usedTxHashes.add(txHash);
    saveUsedTxHashes();
    console.log(`検証OK: ${txHash}(送金額は要求額以上、GAME_WALLET宛のICHIGO送金を確認、${MIN_CONFIRMATIONS}confirmations以上)`);

    if (session) {
      // 同じ確定価格のクオートを2度目の送金に使い回されないよう、ここでredeemed済みにする。
      session.status = 'redeemed';
      if (currentSessionId === sessionId) {
        currentSessionId = null; // 実機を次の参加者のために解放する
      }
    }

    // ESP32へは直接送らず、「解除待ち」を積むだけ。ESP32が次のポーリングで拾いに来る。
    // 決済ページはこの後 /unlock-status?txHash=... をポーリングして、実際に
    // ESP32が解除に成功するまで「支払い完了」を表示しない(送金だけ成立してロックが
    // 開かない、という事故をユーザーに気づかせずに終わらせないため)。
    unlockRequests.set(txHash, { status: 'pending', createdAt: Date.now() });

    return res.json({ ok: true, txHash });
  } catch (err) {
    console.error('verify-and-unlock処理中にエラー:', err);
    return res.status(500).json({ ok: false, error: 'サーバー内部エラー' });
  }
});

if (NEGOTIATION_ENABLED) {
  // AI店番エージェントとの値切り交渉。参加者のスマホ(negotiate/index.html)が叩く。
  // X-Secret認証は無し — 参加者本人が自由に使えることを意図したエンドポイントで、
  // 悪用対策は「実機1台=同時1交渉」「最大ターン数」「新規セッション数の緩いレート制限」で足りる想定。

  app.post('/negotiate-start', (req, res) => {
    sweepStaleNegotiationSessions();
    const { wallet } = req.body ?? {};
    if (typeof wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return res.status(400).json({ ok: false, error: 'walletの形式が不正です' });
    }
    const normalizedWallet = wallet.toLowerCase();

    if (currentSessionId) {
      const existing = negotiationSessions.get(currentSessionId);
      if (existing && (existing.status === 'negotiating' || existing.status === 'awaiting-payment')) {
        if (existing.wallet !== normalizedWallet) {
          return res.status(409).json({ ok: false, error: '他の方が交渉中です。しばらくお待ちください' });
        }
        // 同じウォレットからの再接続(ページ再読み込み等)。今の状態をそのまま返す。
        return res.json({
          ok: true,
          sessionId: currentSessionId,
          status: existing.status,
          price: existing.currentPrice,
          turn: existing.turnCount,
          maxTurn: NEGOTIATE_MAX_TURNS_NUM,
          transcript: existing.transcript,
        });
      }
    }

    if (!canStartNewNegotiationSession()) {
      return res.status(429).json({ ok: false, error: '現在混み合っています。少し時間を置くか、通常の決済ページをご利用ください' });
    }

    const startingPrice = Number(COST);
    const openingReply = `いらっしゃい!ICHIGOガチャガチャへようこそ。今日のお値段は${startingPrice} ICHIGOだよ。何か言いたいことある?`;

    const sessionId = crypto.randomUUID();
    const now = Date.now();
    const session = {
      status: 'negotiating',
      busy: false, // /negotiate-message処理中(await中)にfinalize等が競合しないようにするロック
      wallet: normalizedWallet,
      transcript: [{ role: 'assistant', content: openingReply }],
      startingPrice,
      currentPrice: startingPrice,
      lastQuality: 0, // 会話の質(0〜100)。モデルの評価をターンごとに更新し、確定時のボーナス割引に使う
      turnCount: 0,
      createdAt: now,
      lastActivityAt: now, // 直前の操作時刻。放置検出(アイドルタイムアウト)はこちらを基準にする
      finalPriceWei: null,
      quoteExpiresAt: null,
    };
    negotiationSessions.set(sessionId, session);
    currentSessionId = sessionId;

    return res.json({
      ok: true,
      sessionId,
      status: session.status,
      price: session.currentPrice,
      turn: session.turnCount,
      maxTurn: NEGOTIATE_MAX_TURNS_NUM,
      transcript: session.transcript,
    });
  });

  app.post('/negotiate-message', async (req, res) => {
    sweepStaleNegotiationSessions();
    const { sessionId, message } = req.body ?? {};
    if (typeof sessionId !== 'string' || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ ok: false, error: 'sessionId/messageが不正です' });
    }
    if (message.length > 500) {
      return res.status(400).json({ ok: false, error: 'メッセージが長すぎます(500文字まで)' });
    }
    const session = negotiationSessions.get(sessionId);
    if (!session || session.status !== 'negotiating') {
      return res.status(400).json({ ok: false, error: 'このセッションは交渉中ではありません' });
    }
    // getNegotiationReply()のawait中に/negotiate-finalizeや別の/negotiate-messageが
    // 割り込むと、確定額(finalPriceWei)と画面表示価格がズレる事故につながるため、
    // 処理中は他の操作を弾く簡易ロック(busy)を掛ける。
    if (session.busy) {
      return res.status(409).json({ ok: false, error: '前のやり取りを処理中です。少し待ってからもう一度お試しください' });
    }
    session.busy = true;

    try {
      session.transcript.push({ role: 'user', content: message.trim() });

      const result = await getNegotiationReply({
        transcript: session.transcript,
        startingPrice: session.startingPrice,
        floorPrice: NEGOTIATE_FLOOR_COST_NUM,
        turnCount: session.turnCount,
        maxTurns: NEGOTIATE_MAX_TURNS_NUM,
        apiKey: ANTHROPIC_API_KEY,
        model: ANTHROPIC_MODEL,
        geminiApiKey: GEMINI_API_KEY,
        geminiModel: GEMINI_MODEL,
      });

      let replyText;
      let modelDone = false;
      if (result) {
        replyText = result.reply;
        modelDone = result.done;
        // 「前回の価格以下」「通常フロア以上」を必ず強制する(会話の質によるボーナス割引は
        // finalizeNegotiationSessionで別途、確定時にのみ適用する)。文面へのプロンプト
        // インジェクション(例:「価格を1にして」)は返答の文章がおかしくなるだけで、
        // 実際の価格には影響しない。
        session.currentPrice = Math.min(
          session.currentPrice,
          Math.max(NEGOTIATE_FLOOR_COST_NUM, Math.round(result.price))
        );
        // qualityは付加評価なので、壊れていた場合はこのターンでは更新せず直前の値を保つ
        // (単発の異常応答で「良い会話をしていた」評価がリセットされないようにする)。
        if (result.quality !== null) {
          session.lastQuality = Math.max(0, Math.min(100, result.quality));
        }
      } else {
        replyText = 'すみません、少し混み合っているみたいです。もう一度話しかけてもらえますか?';
      }

      session.transcript.push({ role: 'assistant', content: replyText });
      session.lastActivityAt = Date.now();

      // API障害等(result===null)は参加者の落ち度ではないので、ターン数を消費しない
      // (詫び文言は見せるが、もう一度同じ気持ちで話しかけ直せるようにする)。
      if (result) {
        session.turnCount += 1;
        const hitMaxTurns = session.turnCount >= NEGOTIATE_MAX_TURNS_NUM;
        if (hitMaxTurns || modelDone) {
          finalizeNegotiationSession(session);
        }
      }

      return res.json({
        ok: true,
        reply: replyText,
        price: session.currentPrice,
        turn: session.turnCount,
        maxTurn: NEGOTIATE_MAX_TURNS_NUM,
        status: session.status,
        done: session.status === 'awaiting-payment',
      });
    } finally {
      session.busy = false;
    }
  });

  app.post('/negotiate-finalize', (req, res) => {
    sweepStaleNegotiationSessions();
    const { sessionId } = req.body ?? {};
    const session = negotiationSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ ok: false, error: 'セッションが見つかりません' });
    }
    if (session.busy) {
      return res.status(409).json({ ok: false, error: '前のやり取りを処理中です。少し待ってからもう一度お試しください' });
    }
    if (session.status === 'negotiating') {
      session.lastActivityAt = Date.now();
      finalizeNegotiationSession(session);
    }
    if (session.status !== 'awaiting-payment') {
      return res.status(400).json({ ok: false, error: 'この価格では確定できません' });
    }
    return res.json({ ok: true, price: session.currentPrice, status: session.status });
  });

  // 投影用ページ(spectator/index.html)がポーリングする。認証不要
  // (現在進行中の交渉のチャット内容以外、何も含まれないため)。
  app.get('/negotiate-current', (req, res) => {
    sweepStaleNegotiationSessions();
    const session = currentSessionId ? negotiationSessions.get(currentSessionId) : null;
    if (!session) {
      return res.json({ active: false });
    }
    return res.json({
      active: true,
      status: session.status,
      wallet: maskWallet(session.wallet),
      transcript: session.transcript,
      price: session.currentPrice,
      turn: session.turnCount,
      maxTurn: NEGOTIATE_MAX_TURNS_NUM,
    });
  });

  // スタッフ用: 進行中の交渉を強制終了して実機を解放する(admin/refill-lock.htmlから叩く)。
  // 参加者のスマホが電池切れ・離脱等で止まった場合、これが無いとsweepStaleNegotiationSessions
  // のタイムアウト(最大NEGOTIATE_SESSION_IDLE_MAX_AGE_MS)を待つしかなく、列ができる実運用では
  // 現実的ではないため追加した。既存の/admin-lockと同じX-Secret認証パターンを流用する。
  app.post('/negotiate-admin-cancel', (req, res) => {
    if (!isValidEsp32Secret(req.get('X-Secret'))) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    sweepStaleNegotiationSessions();
    if (!currentSessionId) {
      return res.json({ ok: true, cancelled: false });
    }
    const session = negotiationSessions.get(currentSessionId);
    if (session) {
      session.status = 'expired';
    }
    currentSessionId = null;
    return res.json({ ok: true, cancelled: true });
  });
}

// モーター調整用: 角度と保持時間を指定して1回だけ動かすテストリクエストを積む。
// 決済フローとは無関係の開発/調整用エンドポイントなので、送金検証は行わないが、
// 誰でも実機を動かせてしまわないようESP32と同じ合言葉(X-Secret)で保護する。
app.post('/test-move', (req, res) => {
  if (!isValidEsp32Secret(req.get('X-Secret'))) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  const { angle, holdMs, moveMs, servo } = req.body ?? {};
  const servoName = servo === 'refill' ? 'refill' : 'main';
  if (
    typeof angle !== 'number' || !Number.isFinite(angle) ||
    angle < TEST_MOVE_MIN_ANGLE || angle > TEST_MOVE_MAX_ANGLE
  ) {
    return res.status(400).json({ ok: false, error: `angleは${TEST_MOVE_MIN_ANGLE}〜${TEST_MOVE_MAX_ANGLE}の数値で指定してください` });
  }
  if (
    typeof holdMs !== 'number' || !Number.isFinite(holdMs) ||
    holdMs < TEST_MOVE_MIN_HOLD_MS || holdMs > TEST_MOVE_MAX_HOLD_MS
  ) {
    return res.status(400).json({ ok: false, error: `holdMsは${TEST_MOVE_MIN_HOLD_MS}〜${TEST_MOVE_MAX_HOLD_MS}の数値で指定してください` });
  }
  if (
    typeof moveMs !== 'number' || !Number.isFinite(moveMs) ||
    moveMs < TEST_MOVE_MIN_MOVE_MS || moveMs > TEST_MOVE_MAX_MOVE_MS
  ) {
    return res.status(400).json({ ok: false, error: `moveMsは${TEST_MOVE_MIN_MOVE_MS}〜${TEST_MOVE_MAX_MOVE_MS}の数値で指定してください` });
  }

  sweepStaleTestMoveRequests();
  const requestId = crypto.randomUUID();
  testMoveRequests.set(requestId, {
    status: 'pending',
    angle: Math.round(angle),
    holdMs: Math.round(holdMs),
    moveMs: Math.round(moveMs),
    servo: servoName,
    createdAt: Date.now(),
  });
  return res.json({ ok: true, requestId });
});

// 補充用ロック(2個目のサーボ)の開閉を指示する。メインの解除動作と違い、
// 動かしたら管理者が/admin-lockでもう一度指示するまで開閉状態を保持する
// (自動で元に戻らない)。決済とは無関係だが、誰でも動かせないようX-Secretで保護する。
app.post('/admin-lock', (req, res) => {
  if (!isValidEsp32Secret(req.get('X-Secret'))) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  const { action } = req.body ?? {};
  if (action !== 'open' && action !== 'close') {
    return res.status(400).json({ ok: false, error: 'actionは"open"または"close"で指定してください' });
  }

  sweepStaleAdminLockRequests();
  const requestId = crypto.randomUUID();
  adminLockRequests.set(requestId, { status: 'pending', action, createdAt: Date.now() });
  return res.json({ ok: true, requestId });
});

// 管理者ページがポーリングで結果を確認する。requestIdはランダムなUUIDで、
// これ単体を知られても実害はないため認証不要。
app.get('/admin-lock-status', (req, res) => {
  sweepStaleAdminLockRequests();
  const { requestId } = req.query;
  const request = adminLockRequests.get(requestId);
  if (!request) return res.json({ status: 'unknown' });
  return res.json({ status: request.status, failReason: request.failReason });
});

// 決済ページと同様、テストページもポーリングで結果を確認する。
// requestIdはランダムなUUIDで、これ単体を知られても実害はないため認証不要。
app.get('/test-move-status', (req, res) => {
  sweepStaleTestMoveRequests();
  const { requestId } = req.query;
  const request = testMoveRequests.get(requestId);
  if (!request) return res.json({ status: 'unknown' });
  return res.json({ status: request.status, failReason: request.failReason });
});

function isValidEsp32Secret(provided) {
  if (!ESP32_SECRET || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(ESP32_SECRET);
  // 長さが違うとtimingSafeEqualが例外を投げるため、その場合は先に弾く
  // (このタイミング差はURL/クエリに秘密を載せる場合ほど実用上の脅威にはならない)
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ESP32が数秒おきに問い合わせてくるエンドポイント。解除待ち(pending)が1件でもあれば、
// 一番古いものを1件だけdispatched状態にして返す(以後の実行結果は/unlock-resultで報告させる)。
// 合言葉はURLではなくヘッダー(X-Secret)で受け取る(URLはログ等に残りやすいため)。
// モーターのテスト動作も、解除待ちと同じ/poll-unlockの応答に相乗りさせて返す
// (ESP32はHTTPSを数秒おきに繰り返すとヒープが減っていく問題を抱えているため、
// テスト動作のためだけに別のポーリング先を増やしてHTTPSリクエスト回数を倍にしない)。
function findPendingTestMove() {
  for (const [requestId, request] of testMoveRequests) {
    if (request.status === 'pending') return { requestId, request };
  }
  return null;
}

function findPendingAdminLock() {
  for (const [requestId, request] of adminLockRequests) {
    if (request.status === 'pending') return { requestId, request };
  }
  return null;
}

app.get('/poll-unlock', (req, res) => {
  if (!isValidEsp32Secret(req.get('X-Secret'))) {
    return res.status(403).json({ unlock: false, error: 'forbidden' });
  }
  sweepStaleUnlockRequests();
  sweepStaleTestMoveRequests();
  sweepStaleAdminLockRequests();

  let unlockPayload = { unlock: false };
  for (const [txHash, request] of unlockRequests) {
    if (request.status === 'pending') {
      request.status = 'dispatched';
      request.dispatchedAt = Date.now();
      unlockPayload = { unlock: true, requestId: txHash };
      break;
    }
  }

  let testMovePayload = { testMove: false };
  const pendingTestMove = findPendingTestMove();
  if (pendingTestMove) {
    pendingTestMove.request.status = 'dispatched';
    pendingTestMove.request.dispatchedAt = Date.now();
    testMovePayload = {
      testMove: true,
      testRequestId: pendingTestMove.requestId,
      testAngle: pendingTestMove.request.angle,
      testHoldMs: pendingTestMove.request.holdMs,
      testMoveMs: pendingTestMove.request.moveMs,
      testServo: pendingTestMove.request.servo,
    };
  }

  let adminLockPayload = { adminLock: false };
  const pendingAdminLock = findPendingAdminLock();
  if (pendingAdminLock) {
    pendingAdminLock.request.status = 'dispatched';
    pendingAdminLock.request.dispatchedAt = Date.now();
    adminLockPayload = {
      adminLock: true,
      adminRequestId: pendingAdminLock.requestId,
      adminAction: pendingAdminLock.request.action,
    };
  }

  return res.json({ ...unlockPayload, ...testMovePayload, ...adminLockPayload });
});

// ESP32がサーボを実際に動かした後、その結果(成功/失敗)を報告してくるエンドポイント。
// これが一定時間届かない場合はsweepStaleUnlockRequestsがタイムアウト扱いにする。
app.post('/unlock-result', (req, res) => {
  if (!isValidEsp32Secret(req.get('X-Secret'))) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  sweepStaleUnlockRequests();
  const { requestId, success } = req.body ?? {};
  const request = unlockRequests.get(requestId);
  if (!request) {
    // すでにタイムアウトでfailed扱いになった後の遅延到着、または不明なrequestId。実害はない。
    return res.json({ ok: true, noted: false });
  }
  request.status = success ? 'unlocked' : 'failed';
  if (!success) request.failReason = 'esp32-reported-failure';
  console.log(`ESP32から解除結果の報告: ${requestId} -> ${request.status}`);
  return res.json({ ok: true, noted: true });
});

// ESP32がテスト動作を実行した後、その結果(成功/失敗)を報告してくるエンドポイント。
app.post('/test-move-result', (req, res) => {
  if (!isValidEsp32Secret(req.get('X-Secret'))) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  sweepStaleTestMoveRequests();
  const { requestId, success } = req.body ?? {};
  const request = testMoveRequests.get(requestId);
  if (!request) {
    return res.json({ ok: true, noted: false });
  }
  request.status = success ? 'done' : 'failed';
  if (!success) request.failReason = 'esp32-reported-failure';
  console.log(`ESP32からテスト動作結果の報告: ${requestId} -> ${request.status}`);
  return res.json({ ok: true, noted: true });
});

// ESP32が補充用ロックの開閉を実行した後、その結果(成功/失敗)を報告してくるエンドポイント。
app.post('/admin-lock-result', (req, res) => {
  if (!isValidEsp32Secret(req.get('X-Secret'))) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  sweepStaleAdminLockRequests();
  const { requestId, success } = req.body ?? {};
  const request = adminLockRequests.get(requestId);
  if (!request) {
    return res.json({ ok: true, noted: false });
  }
  request.status = success ? 'done' : 'failed';
  if (!success) request.failReason = 'esp32-reported-failure';
  console.log(`ESP32から補充ロック結果の報告: ${requestId} -> ${request.status}`);
  return res.json({ ok: true, noted: true });
});

// 決済ページが「実際に解除されたか」を確認するためにポーリングするエンドポイント。
// txHashは決済者本人が送金した取引のハッシュであり、これ単体を知られても実害はないため認証不要。
app.get('/unlock-status', (req, res) => {
  sweepStaleUnlockRequests();
  const { txHash } = req.query;
  const request = unlockRequests.get(txHash);
  if (!request) return res.json({ status: 'unknown' });
  return res.json({ status: request.status, failReason: request.failReason });
});

loadTokenDecimals()
  .then(() => {
    // "0.0.0.0"で待ち受けることで、同じWiFi上の他の端末(スマホ等)からも
    // このMacのIPアドレス経由でアクセスできるようにする。
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`検証ブリッジサーバー起動: http://localhost:${PORT}`);
      console.log(`決済画面: http://localhost:${PORT}/`);
      console.log('同じWiFi上の別端末(スマホ等)からは、上のlocalhostをこのMacのIPアドレスに置き換えてアクセスしてください');
      console.log('(MacのIPアドレスはターミナルで `ipconfig getifaddr en0` で確認できます)');
    });
  })
  .catch((err) => {
    console.error('起動時にトークン情報の取得に失敗しました:', err);
    process.exit(1);
  });
