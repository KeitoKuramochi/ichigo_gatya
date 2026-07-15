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
import { pickPrize, getPrizeTeasers, PRIZE_POOL } from './prize-pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_DIR = path.join(__dirname, '..', 'payment');
const TEST_DIR = path.join(__dirname, '..', 'test');
const ADMIN_DIR = path.join(__dirname, '..', 'admin');
const NEGOTIATE_DIR = path.join(__dirname, '..', 'negotiate');
const SPECTATOR_DIR = path.join(__dirname, '..', 'spectator');
const ONLINE_DIR = path.join(__dirname, '..', 'online');
const NFT_IMAGES_DIR = path.join(__dirname, 'nft-images');
const USED_TX_FILE = path.join(__dirname, 'used-tx-hashes.json');

// 確定から一定ブロック数経つまでは「まだ覆る可能性がある」として受け付けない
const MIN_CONFIRMATIONS = 2;
// 支払いから一定時間以上経過したtxHashは、後から使い回されるのを防ぐため受け付けない
const MAX_TX_AGE_SECONDS = 15 * 60;
// ESP32が解除指示を受け取ってから、実行結果(成功/失敗)を報告してくるまでの待ち時間。
// これを過ぎても報告が無ければ「失敗」とみなし、決済者に解除できなかったことを伝える
// (これが無いと、送金だけ成立してロックは開かない、という事故に誰も気づけない)。
//
// gachapon.ino側の実際のパイプラインは、購入者名のスクロール表示(最大4秒)→
// unlockOnce()(約2秒、この時点で実機は既に解除済み)→ 結果報告のHTTPS POST
// (接続5秒+送信5秒を最大2回リトライ=最悪20秒)という順番で、報告そのものが
// 最悪20秒近くかかることがある。15秒では「実機は正常に解除できたのに報告が遅れて
// 間に合わず、決済者には失敗と表示される」という誤検知が実際に起きたため、
// この待ち時間を広げた(2026-07-07、参加者からの実機での指摘を受けて修正)。
// negotiate/index.html側のポーリング上限(UNLOCK_POLL_MAX_TRIES)と揃えて45秒にしている。
const UNLOCK_ESP32_TIMEOUT_MS = 45 * 1000;
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
// 表示名(任意入力のニックネーム)の最大文字数。投影ページの大きい文字表示が
// 崩れないための上限で、機密情報ではないため短くても実害はない。
const DISPLAY_NAME_MAX_LENGTH = 20;
// スタッフが対面で交渉するmanualモードは、AIチャット(NEGOTIATE_SESSION_IDLE_MAX_AGE_MS=10分)
// より会話のペースが遅いことを想定し、放置判定の猶予を長めにする。
const NEGOTIATE_MANUAL_IDLE_MAX_AGE_MS = 20 * 60 * 1000;
// 「ありがとうございました」画面をスタッフが消し忘れても、一定時間で自動的に
// idle表示に戻す(他のsweep関数と同じ自己修復方針)。
const LAST_COMPLETED_MAX_AGE_MS = 10 * 60 * 1000;
// 管理者ページの購入履歴に保持する最大件数
const RECENT_PURCHASES_MAX = 20;
// レシート復元(/negotiate-receipt)で遡って探す範囲。決済ページ側のlocalStorage TTL
// (RECEIPT_TTL_MS, 30分)と揃えている。
const RECEIPT_LOOKUP_MAX_AGE_MS = 30 * 60 * 1000;

const {
  RPC_URL,
  TOKEN_ADDR,
  GAME_WALLET,
  COST,
  ESP32_SECRET,
  // 価格を直接操作できる/negotiate-admin-*系の認証専用の合言葉。実質的に金銭価値のある
  // 操作を守るため、物理操作用のESP32_SECRETとは別の値を設定することを推奨する
  // (未設定ならESP32_SECRETにフォールバックし、既存デプロイを壊さない)。
  NEGOTIATE_ADMIN_SECRET,
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
  // テスト専用: 両方設定されている場合、Anthropic/Geminiには一切問い合わせず
  // Cloudflare Workers AI(無料枠1日1万ニューロン)だけを使う。本番の利用枠・課金を
  // 消費せずに動作確認したい時のためのもので、Render(本番)には設定しないこと。
  CF_ACCOUNT_ID,
  CF_API_TOKEN,
  CF_MODEL = '@cf/meta/llama-3.1-8b-instruct',
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

// オンライン参加(ウォレット接続→AI交渉→ICHIGO送金→NFT受け取り)機能。現地用の
// negotiationSessions/currentSessionIdとは完全に別物として扱う(状態管理・エンドポイントを
// 共有しない)。AI交渉自体は現地と同じgetNegotiationReply()を使うため、AIが無効
// (NEGOTIATION_ENABLED=false)ならオンライン参加も無効にする(現地のmanualモードのような
// 「スタッフが対面で代わりに交渉する」代替が、遠隔の参加者には用意できないため)。
//
// NFTの配布(mint)は、参加者自身のウォレットが署名付きバウチャーを使ってclaimする方式。
// GACHA_NFT_MOCK_MODE='1'ならコントラクト未デプロイでも(偽の署名で)フロー全体を試せる。
// 本番ではNFT_CONTRACT_ADDR/ONLINE_MINTER_PRIVATE_KEYの両方を設定し、GACHA_NFT_MOCK_MODEは未設定にする。
const {
  GACHA_NFT_MOCK_MODE,
  NFT_CONTRACT_ADDR,
  ONLINE_MINTER_PRIVATE_KEY,
  ONLINE_MAX_CONCURRENT = '2',
  ONLINE_VOUCHER_TTL_MS = String(24 * 60 * 60 * 1000),
} = process.env;

const ONLINE_MOCK_MODE = GACHA_NFT_MOCK_MODE === '1';
const ONLINE_NFT_CONFIGURED = ONLINE_MOCK_MODE || Boolean(NFT_CONTRACT_ADDR && ONLINE_MINTER_PRIVATE_KEY);
// AIが有効、かつNFTの配布方法(mockまたは実コントラクト)が用意できている場合のみ、
// オンライン参加そのものを受け付ける(実ICHIGOを払わせておいてNFTを渡せない、という
// 事故を避けるため、決済より前の入口(/online-negotiate-start)でまとめて弾く)。
const ONLINE_ENABLED = NEGOTIATION_ENABLED && ONLINE_NFT_CONFIGURED;
const ONLINE_MAX_CONCURRENT_NUM = parseInt(ONLINE_MAX_CONCURRENT, 10);
const ONLINE_VOUCHER_TTL_MS_NUM = parseInt(ONLINE_VOUCHER_TTL_MS, 10);
const ONLINE_CHAIN_ID = 10; // Optimismメインネット。ICHIGO送金・NFTコントラクトともに同じチェーン

console.log(
  // /negotiate/自体は常に使える(AIが無ければスタッフが直接価格を決めるmanualモードに
  // なるだけ)。ここで有効/無効と表示しているのは「AIによる自動値切り」の部分だけ。
  NEGOTIATION_ENABLED
    ? `AI店番エージェント(値切り交渉)機能: 有効(通常フロア=${NEGOTIATE_FLOOR_COST_NUM} ICHIGO, 会話の質次第で最大${NEGOTIATE_ABSOLUTE_FLOOR_NUM} ICHIGOまで, 最大${NEGOTIATE_MAX_TURNS_NUM}ターン, Geminiフォールバック=${GEMINI_API_KEY ? '有効' : '無効'})`
    : 'AI店番エージェント(値切り交渉)機能: 無効(ANTHROPIC_API_KEY / NEGOTIATE_FLOOR_COSTが未設定) → /negotiate/はスタッフが価格を直接決めるmanualモードで動作します'
);
if (CF_ACCOUNT_ID && CF_API_TOKEN) {
  console.warn(
    `⚠️ テスト用切り替えが有効: 交渉はAnthropic/Geminiではなく Cloudflare Workers AI(${CF_MODEL}) を使います。本番運用時はCF_ACCOUNT_ID/CF_API_TOKENを未設定にしてください。`
  );
}

console.log(
  ONLINE_ENABLED
    ? `オンライン参加機能: 有効(同時最大${ONLINE_MAX_CONCURRENT_NUM}人, NFT配布=${ONLINE_MOCK_MODE ? 'モックモード(テスト運用中)' : `実コントラクト ${NFT_CONTRACT_ADDR}`})`
    : `オンライン参加機能: 無効(${!NEGOTIATION_ENABLED ? 'AI店番が無効' : 'NFT_CONTRACT_ADDR/ONLINE_MINTER_PRIVATE_KEYまたはGACHA_NFT_MOCK_MODEが未設定'})`
);
if (ONLINE_MOCK_MODE) {
  console.warn('⚠️ GACHA_NFT_MOCK_MODE=1: オンライン参加のNFT配布は実際にはmintされません(テスト運用)。本番前に必ず無効化してください。');
}

const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function decimals() view returns (uint8)',
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const tokenInterface = new ethers.Interface(ERC20_ABI);
const tokenContract = new ethers.Contract(TOKEN_ADDR, ERC20_ABI, provider);

// IchigoGachaNFT.sol(contracts/)側のclaim()と対応する、mint検知用の最小ABI。
// バウチャーの署名(signTypedData)自体はコントラクトを介さないオフチェーン処理なので、
// ここではclaim()の関数シグネチャ(参加者が実際に呼ぶ)とTransferSingleイベント
// (/online-claim-confirmでの検証用)だけを持たせる。
const NFT_ABI = [
  'function claim(tuple(address wallet, uint256 prizeId, bytes32 sessionNonce, uint256 expiry) voucher, bytes signature) external',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
];
const nftInterface = new ethers.Interface(NFT_ABI);
// バウチャーへの署名専用ウォレット。オフチェーン署名(signTypedData)しか行わないため、
// providerに接続する必要も、ETHを保有する必要も無い(mint自体のガス代は参加者が払う)。
const onlineMinterWallet = ONLINE_MINTER_PRIVATE_KEY ? new ethers.Wallet(ONLINE_MINTER_PRIVATE_KEY) : null;

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

// 直近に完了(redeemed)した交渉。currentSessionIdは決済確認直後に即座にnullへ戻す
// (次の人がすぐ交渉を始められるように)ため、それとは別に「投影ページに
// 『ありがとうございました』を出す対象」を保持する単一スロット。スタッフが
// admin/refill-lock.htmlのボタンで消すか、LAST_COMPLETED_MAX_AGE_MSで自動失効する。
let lastCompleted = null; // {displayName, wallet(masked), price, completedAt, txHash} | null

// 管理者ページの購入履歴用。/verify-and-unlockが成功するたびに先頭へ積み、
// RECENT_PURCHASES_MAXを超えたら末尾を捨てる(ディスク永続化はしない、教室内デモ相応)。
const recentPurchases = [];

// AI(Anthropic→Geminiフォールバック)が連続で失敗した回数。成功したら0に戻す。
// スタッフがAI障害に気付かず参加者を待たせ続ける事故を防ぐため、管理者ページに表示する。
let consecutiveAiFailures = 0;

const NEGOTIATE_SESSION_IDLE_MAX_AGE_MS = 10 * 60 * 1000; // 交渉中のまま放置されたセッションのタイムアウト(AIモード)
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

  // 「ありがとうございました」画面をスタッフが消し忘れても永遠に残らないようにする。
  if (lastCompleted && now - lastCompleted.completedAt > LAST_COMPLETED_MAX_AGE_MS) {
    lastCompleted = null;
  }

  for (const [sessionId, session] of negotiationSessions) {
    // lastActivityAt(直前の操作時刻)基準。createdAt基準にすると、参加者が途切れず
    // 会話を続けていてもセッション開始からの総経過時間だけで強制終了してしまう
    // (「放置」の検出になっていなかった、という不具合の修正)。
    // manualモード(スタッフとの対面交渉)はAIチャットより会話のペースが遅いことを
    // 想定し、放置判定の猶予を長めにする。
    const idleLimit = session.mode === 'manual' ? NEGOTIATE_MANUAL_IDLE_MAX_AGE_MS : NEGOTIATE_SESSION_IDLE_MAX_AGE_MS;
    if (session.status === 'negotiating' && now - session.lastActivityAt > idleLimit) {
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
// session.currentPriceはAIが口にした金額をそのまま反映した値(2026-07-08〜)なので、
// ここでは今表示されている価格をそのまま確定するだけでよい。
function finalizeNegotiationSession(session) {
  applyFinalPrice(session, session.currentPrice);
}

function maskWallet(wallet) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

// 表示名(任意入力のニックネーム)を、投影ページ・AIプロンプト・管理者ログに
// 出しても安全な形に整える。制御文字/改行を潰し、前後の空白を落とし、
// 長さを制限する。空になった場合はnull(=呼び出し側でmaskWallet表示にフォールバック)。
function sanitizeDisplayName(raw) {
  if (typeof raw !== 'string') return null;
  // ESP32のOLEDフォント(u8g2_font_unifont_t_japanese1)がひらがな・カタカナ・
  // 半角英数字中心のため、それ以外(漢字・絵文字・中国語等)は表示が欠ける。
  // 制御文字除去に加えて、半角英数字・ひらがな(぀-ゟ)・
  // カタカナ(゠-ヿ、長音符ー含む)・半角スペース以外を落とす。
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/[^0-9A-Za-z぀-ヿ ]/g, '')
    .trim()
    .slice(0, DISPLAY_NAME_MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

// finalizeNegotiationSession(AIとの交渉結果)と/negotiate-admin-set-price
// (スタッフが直接入力した価格)の両方が使う、価格確定後の共通処理。
function applyFinalPrice(session, price) {
  session.currentPrice = price;
  session.finalPriceWei = ethers.parseUnits(String(session.currentPrice), tokenDecimals);
  session.quoteExpiresAt = Date.now() + NEGOTIATE_QUOTE_TTL_MS_NUM;
  session.status = 'awaiting-payment';
}

// ============================================================================
// オンライン参加(ウォレット接続→AI交渉→ICHIGO送金→NFT受け取り)。
// 現地(negotiationSessions/currentSessionId、実機1台=同時1交渉の前提)とは
// 完全に別のMapで管理する。実機の解除とは無関係なので、ESP32・/poll-unlock側は
// このセクションを一切参照しない。
//
// 状態遷移: negotiating(AI交渉中) → awaiting-payment(価格確定・送金待ち)
//         → awaiting-claim(送金確認済み・景品抽選済み・mint待ち) → claimed(mint確認済み)
//         / expired(放置)
// ============================================================================
const onlineSessions = new Map(); // sessionId -> {status, wallet, displayName, transcript, ...}

// 直近の「こういうNFTが出ました」演出用の短命キュー。現地のlastCompleted(単一スロット、
// 手動解除のみ)と違い、オンラインは同時に複数人が完了しうるため配列にし、投影ページ側で
// 順番に1件ずつ表示させる(古いものはここで自動的に間引く)。
const onlineReveals = [];
const ONLINE_REVEAL_MAX_AGE_MS = 2 * 60 * 1000; // 投影側の表示時間(数秒)よりずっと長く持たせておくだけでよい

function sweepStaleOnlineSessions() {
  const now = Date.now();
  for (const [sessionId, session] of onlineSessions) {
    if (session.status === 'negotiating' && now - session.lastActivityAt > NEGOTIATE_SESSION_IDLE_MAX_AGE_MS) {
      session.status = 'expired';
    } else if (
      session.status === 'awaiting-payment' &&
      session.quoteExpiresAt &&
      now > session.quoteExpiresAt
    ) {
      session.status = 'expired';
    }
    if ((session.status === 'claimed' || session.status === 'expired') && now - session.createdAt > 60 * 60 * 1000) {
      onlineSessions.delete(sessionId);
    }
  }
  while (onlineReveals.length && now - onlineReveals[0].revealedAt > ONLINE_REVEAL_MAX_AGE_MS) {
    onlineReveals.shift();
  }
}

// オンラインで現在「交渉中」または「送金待ち」の件数(=枠を占有している件数)。
function countActiveOnlineSessions() {
  let count = 0;
  for (const session of onlineSessions.values()) {
    if (session.status === 'negotiating' || session.status === 'awaiting-payment') count += 1;
  }
  return count;
}

// /negotiate-startの濫用防止(canStartNewNegotiationSession)と同じ考え方だが、
// 現地用のレート制限とは完全に分けて数える(オンラインが混んでも現地に影響しないように)。
let onlineNegotiateStartTimestamps = [];
function canStartNewOnlineNegotiationSession() {
  const now = Date.now();
  onlineNegotiateStartTimestamps = onlineNegotiateStartTimestamps.filter(
    (t) => now - t < NEGOTIATE_START_RATE_WINDOW_MS
  );
  if (onlineNegotiateStartTimestamps.length >= NEGOTIATE_START_RATE_LIMIT) return false;
  onlineNegotiateStartTimestamps.push(now);
  return true;
}

const app = express();
app.use(cors()); // Vercel等、別オリジンで配信されたpayment/index.htmlからも叩けるようにする
app.use(express.json());
// ルート(/)はnegotiate/へ誘導する。payment/index.html(旧来のAI無し決済ページ)は
// currentSessionIdのロックを一切見ないため、これをそのまま/で生かしておくと
// 「同時に1人まで」を誰でも直接/にアクセスするだけで迂回できてしまう。
// manualモード(下記)の追加でnegotiate/側がAI無し時の代替も担えるようになったため、
// このブリッジ自身の/はリダイレクトで塞ぐ(express.staticより前に置く必要がある)。
app.get('/', (req, res) => res.redirect('/negotiate/'));
app.use(express.static(GAME_DIR)); // /verify-and-unlockのsessionIdなし分岐は、Vercel等の別オリジンにある独立deployのpayment/index.htmlが今も使うため残す
app.use('/test', express.static(TEST_DIR)); // モーターのテスト用ページを/test/以下で配信
app.use('/admin', express.static(ADMIN_DIR)); // 補充用ロックの管理者ページを/admin/以下で配信
app.use('/negotiate', express.static(NEGOTIATE_DIR)); // AI店番との値切り交渉ページを/negotiate/以下で配信
app.use('/spectator', express.static(SPECTATOR_DIR)); // 交渉の様子を投影する観客用ページを/spectator/以下で配信
app.use('/online', express.static(ONLINE_DIR)); // オンライン参加ページを/online/以下で配信
app.use('/nft-images', express.static(NFT_IMAGES_DIR)); // NFTの景品画像(nft-metadataのJSONが指す先)

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
      // 投影ページの「ありがとうございました、次の方どうぞ」画面のソース。
      lastCompleted = {
        displayName: session.displayName,
        wallet: maskWallet(session.wallet),
        price: session.currentPrice,
        completedAt: Date.now(),
        txHash,
      };
    }

    // 管理者ページの購入履歴。マスクしないウォレット・txHashを含める(この一覧自体が
    // NEGOTIATE_ADMIN_SECRETで保護されるため、物理操作と同じ信頼境界で問題ない)。
    // 金額は実際にオンチェーンで転送された額(transfer.args.value)を使う
    // (表示上の価格ではなく、本当に支払われた金額を記録する)。
    recentPurchases.unshift({
      txHash,
      price: ethers.formatUnits(transfer.args.value, tokenDecimals),
      wallet: transfer.args.from,
      displayName: session ? session.displayName : null,
      mode: session ? session.mode : 'direct',
      completedAt: Date.now(),
      // レシート復元(/negotiate-receipt)経由でも会話を読み返せるように保持する
      // (「会話が終わったらすぐ消えてしまう、読み返せて面白いのに」との指摘を受けて追加)。
      transcript: session ? session.transcript : [],
    });
    if (recentPurchases.length > RECENT_PURCHASES_MAX) {
      recentPurchases.length = RECENT_PURCHASES_MAX;
    }

    // ESP32へは直接送らず、「解除待ち」を積むだけ。ESP32が次のポーリングで拾いに来る。
    // 決済ページはこの後 /unlock-status?txHash=... をポーリングして、実際に
    // ESP32が解除に成功するまで「支払い完了」を表示しない(送金だけ成立してロックが
    // 開かない、という事故をユーザーに気づかせずに終わらせないため)。
    // displayNameはESP32のOLEDが「誰が購入したか」を表示するために使う(空ならESP32側で
    // 「だれかが」にフォールバックする)。sessionが無い(payment/index.html経由等)場合はnull。
    unlockRequests.set(txHash, { status: 'pending', createdAt: Date.now(), displayName: session ? session.displayName : null });

    return res.json({ ok: true, txHash });
  } catch (err) {
    console.error('verify-and-unlock処理中にエラー:', err);
    return res.status(500).json({ ok: false, error: 'サーバー内部エラー' });
  }
});

// 交渉関連のエンドポイント群。以前はNEGOTIATION_ENABLED(ANTHROPIC_API_KEY等が
// 設定されているか)で丸ごと有効/無効を切り替えていたが、AIが使えない場合の代替として
// 「スタッフが対面で交渉し、価格を直接入力するmanualモード」を追加したため、
// セッション自体は常に作れるようにする(AIモードかmanualモードかはmode1つで区別する)。
// X-Secret認証が無いエンドポイント(negotiate-start/message/finalize/current)は
// 参加者本人が自由に使えることを意図したもので、悪用対策は「実機1台=同時1交渉」
// 「最大ターン数」「新規セッション数の緩いレート制限」で足りる想定。

app.post('/negotiate-start', (req, res) => {
  sweepStaleNegotiationSessions();
  const { wallet, displayName } = req.body ?? {};
  if (typeof wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return res.status(400).json({ ok: false, error: 'walletの形式が不正です' });
  }
  if (displayName !== undefined && typeof displayName !== 'string') {
    return res.status(400).json({ ok: false, error: 'displayNameの形式が不正です' });
  }
  const normalizedWallet = wallet.toLowerCase();
  const sanitizedName = sanitizeDisplayName(displayName);

  if (currentSessionId) {
    const existing = negotiationSessions.get(currentSessionId);
    if (existing && (existing.status === 'negotiating' || existing.status === 'awaiting-payment')) {
      if (existing.wallet !== normalizedWallet) {
        return res.status(409).json({ ok: false, error: '他の方が交渉中です。しばらくお待ちください' });
      }
      // 同じウォレットからの再接続(ページ再読み込み等)。今回、空でない表示名が
      // 送られてきた場合だけ更新する(入力ミスの訂正を許可。何も送られなければ
      // 元の値を維持し、参加者側に再入力を求めない)。
      if (sanitizedName) {
        existing.displayName = sanitizedName;
      }
      return res.json({
        ok: true,
        sessionId: currentSessionId,
        status: existing.status,
        mode: existing.mode,
        displayName: existing.displayName,
        price: existing.currentPrice,
        turn: existing.turnCount,
        maxTurn: NEGOTIATE_MAX_TURNS_NUM,
        transcript: existing.transcript,
      });
    }
  }

  if (!canStartNewNegotiationSession()) {
    return res.status(429).json({ ok: false, error: '現在混み合っています。少し時間を置いてもう一度お試しください' });
  }

  const mode = NEGOTIATION_ENABLED ? 'ai' : 'manual';
  const startingPrice = Number(COST);
  const openingReply = `いらっしゃい!ICHIGOガチャガチャへようこそ。今日のお値段は${startingPrice} ICHIGOだよ。何か言いたいことある?`;

  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const session = {
    status: 'negotiating',
    mode,
    busy: false, // /negotiate-message処理中(await中)にfinalize等が競合しないようにするロック
    wallet: normalizedWallet,
    displayName: sanitizedName,
    // manualモードはクライアント側でチャットUI自体を出さないので、AIの第一声は不要。
    transcript: mode === 'ai' ? [{ role: 'assistant', content: openingReply }] : [],
    startingPrice,
    currentPrice: startingPrice,
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
    mode: session.mode,
    displayName: session.displayName,
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
  // manualモード(AI無し、スタッフが対面で交渉)のセッションではAIチャットは使えない。
  if (session.mode !== 'ai') {
    return res.status(400).json({ ok: false, error: 'このセッションはAI交渉ではありません。店員と直接ご相談ください' });
  }
  // getNegotiationReply()のawait中に/negotiate-finalizeや別の/negotiate-messageが
  // 割り込むと、確定額(finalPriceWei)と画面表示価格がズレる事故につながるため、
  // 処理中は他の操作を弾く簡易ロック(busy)を掛ける。/negotiate-admin-set-priceも
  // このbusyを見て、AI応答待ち中の割り込みを防ぐ。
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
      absoluteFloor: NEGOTIATE_ABSOLUTE_FLOOR_NUM,
      turnCount: session.turnCount,
      maxTurns: NEGOTIATE_MAX_TURNS_NUM,
      displayName: session.displayName,
      apiKey: ANTHROPIC_API_KEY,
      model: ANTHROPIC_MODEL,
      geminiApiKey: GEMINI_API_KEY,
      geminiModel: GEMINI_MODEL,
      cloudflareAccountId: CF_ACCOUNT_ID,
      cloudflareApiToken: CF_API_TOKEN,
      cloudflareModel: CF_MODEL,
    });

    let replyText;
    if (result) {
      consecutiveAiFailures = 0;
      replyText = result.reply;
      // AIが口にした金額(result.price)を、加工せずそのまま最終価格として使う
      // (2026-07-08、「AI店主が言った値段をそのまま使う方が納得感がある」との要望を
      // 受けて設計変更。以前は会話の質(quality)スコアに応じたボーナス割引を裏で
      // 追加していたが、AIの発言内の金額と実際の確定額がズレて「言ってた額と違う」と
      // いう不信感を招いていた)。「前回の価格以下」「絶対的な下限(NEGOTIATE_ABSOLUTE_FLOOR)
      // 以上」だけを必ず強制する(通常フロアを下回ってよいかどうかの判断はAI自身に委ねており、
      // プロンプト側で指示している)。文面へのプロンプトインジェクション(例:「価格を1にして」)
      // は返答の文章がおかしくなるだけで、実際の価格には影響しない。
      session.currentPrice = Math.min(
        session.currentPrice,
        Math.max(NEGOTIATE_ABSOLUTE_FLOOR_NUM, Math.round(result.price))
      );
    } else {
      consecutiveAiFailures += 1;
      replyText = 'すみません、少し混み合っているみたいです。もう一度話しかけてもらえますか?';
    }

    session.transcript.push({ role: 'assistant', content: replyText });
    session.lastActivityAt = Date.now();

    // API障害等(result===null)は参加者の落ち度ではないので、ターン数を消費しない
    // (詫び文言は見せるが、もう一度同じ気持ちで話しかけ直せるようにする)。
    if (result) {
      session.turnCount += 1;
      // AIのdone判定(quoteツールのdoneフィールド)だけでは確定しない。「500円しか
      // 持っていません」のような単なる値切りの訴えにも早期にdone:trueを返してしまい、
      // まだ2ターン目なのに強制的に交渉が終わってしまう不具合が実際に起きたため
      // (2026-07-07、参加者からの指摘を受けて修正)。この機能の目的は会話を楽しんで
      // もらうことなので、最大ターン数に達するまでは必ず交渉を続けさせ、早く終えたい
      // 場合は参加者自身が「この価格で決める」ボタン(/negotiate-finalize)を押す形に統一する。
      if (session.turnCount >= NEGOTIATE_MAX_TURNS_NUM) {
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
  if (session.mode !== 'ai') {
    return res.status(400).json({ ok: false, error: 'このセッションはAI交渉ではありません。店員と直接ご相談ください' });
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

// 参加者本人用: 確定価格での購入をやめる(negotiate/index.htmlの「やめる」ボタン)。
// 管理者用の/negotiate-admin-cancelと違い、これは本人が自分のセッションをやめる
// だけなのでX-Secret認証は不要(他の/negotiate-*系と同じ信頼境界)。これが無いと、
// 参加者が購入を見送った場合でもクオートの有効期限(NEGOTIATE_QUOTE_TTL_MS)が
// 切れるまで実機が専有されたままになり、次の人がすぐ使えなくなってしまう。
app.post('/negotiate-cancel', (req, res) => {
  sweepStaleNegotiationSessions();
  const { sessionId } = req.body ?? {};
  const session = typeof sessionId === 'string' ? negotiationSessions.get(sessionId) : null;
  if (session && (session.status === 'negotiating' || session.status === 'awaiting-payment')) {
    session.status = 'expired';
    if (currentSessionId === sessionId) {
      currentSessionId = null; // 実機を次の参加者のためにすぐ解放する
    }
  }
  // セッションが既に存在しない(タイムアウト等で消えた)場合も、参加者側は
  // どのみち離脱したい状態なのでエラーにはせず成功扱いにする。
  return res.json({ ok: true });
});

// 投影用ページ(spectator/index.html)・manualモード待機中のnegotiate/index.htmlが
// ポーリングする。認証不要(現在進行中の交渉のチャット内容と表示名以外、何も含まれないため)。
app.get('/negotiate-current', (req, res) => {
  sweepStaleNegotiationSessions();
  const session = currentSessionId ? negotiationSessions.get(currentSessionId) : null;
  if (!session) {
    // アクティブなセッションが無い場合、直近に完了した交渉があれば併せて返す
    // (投影ページの「ありがとうございました、次の方どうぞ」画面のソース)。
    return res.json({ active: false, justCompleted: lastCompleted, aiFailures: consecutiveAiFailures });
  }
  return res.json({
    active: true,
    status: session.status,
    mode: session.mode,
    displayName: session.displayName,
    wallet: maskWallet(session.wallet),
    transcript: session.transcript,
    price: session.currentPrice,
    turn: session.turnCount,
    maxTurn: NEGOTIATE_MAX_TURNS_NUM,
    aiFailures: consecutiveAiFailures,
  });
});

// スタッフ用: 進行中の交渉を強制終了して実機を解放する(admin/refill-lock.htmlから叩く)。
// 参加者のスマホが電池切れ・離脱等で止まった場合、これが無いとsweepStaleNegotiationSessions
// のタイムアウトを待つしかなく、列ができる実運用では現実的ではないため追加した。
app.post('/negotiate-admin-cancel', (req, res) => {
  if (!isValidNegotiateAdminSecret(req.get('X-Secret'))) {
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

// スタッフ用: 現在の交渉の価格をスタッフが直接確定する。manualモード(AI無し、対面交渉)の
// 通常フローと、aiモードへの割り込み上書き(AIが不調な時にスタッフが代わりに決める)の
// 両方をこの1本でカバーする。
app.post('/negotiate-admin-set-price', (req, res) => {
  if (!isValidNegotiateAdminSecret(req.get('X-Secret'))) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  sweepStaleNegotiationSessions();
  if (!currentSessionId) {
    return res.status(404).json({ ok: false, error: '現在進行中の交渉がありません' });
  }
  const session = negotiationSessions.get(currentSessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: '現在進行中の交渉がありません' });
  }
  // AIのawait中(session.busy)の割り込みを禁止する(2026-07-05に修正した
  // チャット送信中の競合バグと同種の事故を防ぐ)。
  if (session.busy) {
    return res.status(409).json({ ok: false, error: '前のやり取りを処理中です。少し待ってからもう一度お試しください' });
  }
  // すでにawaiting-payment(見積もり確定・参加者が送金しようとしている可能性がある状態)の
  // セッションに対する価格上書きは許可しない。送金がチェーン上で承認待ちの間に価格を
  // 書き換えると、/verify-and-unlockが新しい価格でしか検証できなくなり、「実際に払った
  // のに検証NG」という資金が絡む事故になるため。まずキャンセルしてやり直す運用にする。
  if (session.status !== 'negotiating') {
    return res.status(400).json({ ok: false, error: 'この交渉は既に価格確定済みです。先に/negotiate-admin-cancelでキャンセルしてください' });
  }
  const { price } = req.body ?? {};
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > session.startingPrice) {
    return res.status(400).json({ ok: false, error: `priceは0〜${session.startingPrice}の数値で指定してください` });
  }
  session.lastActivityAt = Date.now();
  applyFinalPrice(session, price);
  return res.json({ ok: true, price: session.currentPrice, status: session.status });
});

// スタッフ用: 「ありがとうございました」画面を消す(admin/refill-lock.htmlのボタン)。
app.post('/negotiate-admin-clear-completed', (req, res) => {
  if (!isValidNegotiateAdminSecret(req.get('X-Secret'))) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  lastCompleted = null;
  return res.json({ ok: true });
});

// スタッフ用: 直近の購入履歴。参加者本人のスマホ(レシート画面)が使えない場合の保険。
app.get('/negotiate-admin-recent-purchases', (req, res) => {
  if (!isValidNegotiateAdminSecret(req.get('X-Secret'))) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  sweepStaleUnlockRequests();
  const purchases = recentPurchases.map((p) => ({
    ...p,
    unlockStatus: unlockRequests.get(p.txHash)?.status ?? 'unknown',
  }));
  return res.json({ ok: true, purchases });
});

// 参加者本人用: 決済証拠(レシート)画面をサーバー側の記録から復元する。
// negotiate/index.htmlはlocalStorageにレシートを保存して画面上の再読み込みに耐えるが、
// スマホのブラウザ/ウォレットアプリがタブを破棄してlocalStorageまで失われた場合、
// 再度ウォレットを接続した時点でここを叩いて直近の購入を復元できるようにする保険。
//
// wallet単体を知っていれば誰でも呼べてしまうと、その人のニックネーム・支払額・解除状況が
// 見えてしまう(セキュリティレビューで指摘、2026-07-07修正)。ウォレットアドレスは秘密では
// ないが「本人だけが呼べる」ことは保証したいため、personal_signで本人であることを
// 検証してからのみレシートを返す(nonceは/negotiate-receipt-challengeで発行、1回使い切り)。
const NEGOTIATE_RECEIPT_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const negotiateReceiptChallenges = new Map(); // wallet(lowercase) -> {nonce, createdAt}

app.post('/negotiate-receipt-challenge', (req, res) => {
  const wallet = typeof req.body?.wallet === 'string' ? req.body.wallet.toLowerCase() : '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return res.status(400).json({ ok: false, error: 'walletの形式が不正です' });
  }
  const nonce = `ICHIGOガチャガチャ レシート確認用の署名です。nonce: ${crypto.randomUUID()}`;
  negotiateReceiptChallenges.set(wallet, { nonce, createdAt: Date.now() });
  return res.json({ ok: true, nonce });
});

app.post('/negotiate-receipt', (req, res) => {
  const wallet = typeof req.body?.wallet === 'string' ? req.body.wallet.toLowerCase() : '';
  const { signature } = req.body ?? {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return res.status(400).json({ ok: false, error: 'walletの形式が不正です' });
  }
  if (typeof signature !== 'string') {
    return res.status(400).json({ ok: false, error: 'signatureが必要です' });
  }

  const challenge = negotiateReceiptChallenges.get(wallet);
  if (!challenge || Date.now() - challenge.createdAt > NEGOTIATE_RECEIPT_CHALLENGE_TTL_MS) {
    negotiateReceiptChallenges.delete(wallet);
    return res.status(400).json({ ok: false, error: '署名の有効期限が切れました。もう一度お試しください' });
  }
  // 1回使い切り(同じ署名の再利用でリプレイされないようにする)。成否に関わらずここで消費する。
  negotiateReceiptChallenges.delete(wallet);

  let recovered;
  try {
    recovered = ethers.verifyMessage(challenge.nonce, signature);
  } catch {
    return res.status(403).json({ ok: false, error: '署名が無効です' });
  }
  if (recovered.toLowerCase() !== wallet) {
    return res.status(403).json({ ok: false, error: '署名がウォレットと一致しません' });
  }

  sweepStaleUnlockRequests();
  const purchase = recentPurchases.find(
    (p) => p.wallet.toLowerCase() === wallet && Date.now() - p.completedAt <= RECEIPT_LOOKUP_MAX_AGE_MS
  );
  if (!purchase) {
    return res.json({ ok: true, found: false });
  }
  return res.json({
    ok: true,
    found: true,
    displayName: purchase.displayName,
    price: purchase.price,
    txHash: purchase.txHash,
    paidAt: purchase.completedAt,
    unlockStatus: unlockRequests.get(purchase.txHash)?.status ?? 'unknown',
    transcript: purchase.transcript || [],
  });
});

// ============================================================================
// オンライン参加エンドポイント群。/negotiate-*とは意図的に完全に別実装にしている
// (「現地用とオンライン用は完全に別物として扱う」という方針。既存の/negotiate-*の
// コードは一切変更していない)。ただし汎用的な純粋ロジック(getNegotiationReply/
// findValidTransfer/sanitizeDisplayName/maskWallet/usedTxHashes等)はそのまま再利用する。
// ============================================================================

// オンライン参加ページ(online/index.html)が最初に叩く、機能そのものの有効/無効確認。
// AI無効時・NFT配布方法未設定時はここで理由付きで断る(決済させてからNFTを渡せない、
// という事故を避けるため、参加登録の入口でまとめて弾く)。
app.get('/online-status', (req, res) => {
  sweepStaleOnlineSessions();
  return res.json({
    enabled: ONLINE_ENABLED,
    maxConcurrent: ONLINE_MAX_CONCURRENT_NUM,
    activeCount: countActiveOnlineSessions(),
    mock: ONLINE_MOCK_MODE,
  });
});

// オンライン用の景品お披露目(モザイク/サンプル表示)。実画像URLは含めず、
// 名前と大まかな出現率だけを返す(ネタバレ防止)。
app.get('/prize-pool-teaser', (req, res) => {
  return res.json({ ok: true, prizes: getPrizeTeasers() });
});

app.post('/online-negotiate-start', (req, res) => {
  if (!ONLINE_ENABLED) {
    return res.status(503).json({ ok: false, error: 'オンライン参加は現在準備中です' });
  }
  sweepStaleOnlineSessions();
  const { wallet, displayName } = req.body ?? {};
  if (typeof wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return res.status(400).json({ ok: false, error: 'walletの形式が不正です' });
  }
  if (displayName !== undefined && typeof displayName !== 'string') {
    return res.status(400).json({ ok: false, error: 'displayNameの形式が不正です' });
  }
  const normalizedWallet = wallet.toLowerCase();
  const sanitizedName = sanitizeDisplayName(displayName);

  // 同じウォレットで既にアクティブなセッションがあれば、新規作成せずそれを返す
  // (ページ再読み込み等での復帰。/negotiate-startの再接続ロジックと同じ考え方)。
  for (const [sid, existing] of onlineSessions) {
    if (
      existing.wallet === normalizedWallet &&
      (existing.status === 'negotiating' || existing.status === 'awaiting-payment' || existing.status === 'awaiting-claim')
    ) {
      if (sanitizedName) existing.displayName = sanitizedName;
      return res.json({
        ok: true,
        sessionId: sid,
        status: existing.status,
        displayName: existing.displayName,
        price: existing.currentPrice,
        turn: existing.turnCount,
        maxTurn: NEGOTIATE_MAX_TURNS_NUM,
        transcript: existing.transcript,
        prize: existing.prize || null,
      });
    }
  }

  if (countActiveOnlineSessions() >= ONLINE_MAX_CONCURRENT_NUM) {
    return res.status(429).json({ ok: false, error: `現在オンライン参加が混み合っています(最大${ONLINE_MAX_CONCURRENT_NUM}人)。しばらくしてからもう一度お試しください` });
  }
  if (!canStartNewOnlineNegotiationSession()) {
    return res.status(429).json({ ok: false, error: '現在混み合っています。少し時間を置いてもう一度お試しください' });
  }

  const startingPrice = Number(COST);
  const openingReply = `いらっしゃい!ICHIGOガチャガチャへようこそ。オンラインでも同じお値段(${startingPrice} ICHIGO)から始めるよ。何か言いたいことある?`;
  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const session = {
    status: 'negotiating',
    busy: false,
    wallet: normalizedWallet,
    displayName: sanitizedName,
    transcript: [{ role: 'assistant', content: openingReply }],
    startingPrice,
    currentPrice: startingPrice,
    turnCount: 0,
    createdAt: now,
    lastActivityAt: now,
    finalPriceWei: null,
    quoteExpiresAt: null,
    prize: null,
    voucher: null,
    claimTxHash: null,
  };
  onlineSessions.set(sessionId, session);

  return res.json({
    ok: true,
    sessionId,
    status: session.status,
    displayName: session.displayName,
    price: session.currentPrice,
    turn: session.turnCount,
    maxTurn: NEGOTIATE_MAX_TURNS_NUM,
    transcript: session.transcript,
    prize: null,
  });
});

app.post('/online-negotiate-message', async (req, res) => {
  sweepStaleOnlineSessions();
  const { sessionId, message } = req.body ?? {};
  if (typeof sessionId !== 'string' || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ ok: false, error: 'sessionId/messageが不正です' });
  }
  if (message.length > 500) {
    return res.status(400).json({ ok: false, error: 'メッセージが長すぎます(500文字まで)' });
  }
  const session = onlineSessions.get(sessionId);
  if (!session || session.status !== 'negotiating') {
    return res.status(400).json({ ok: false, error: 'このセッションは交渉中ではありません' });
  }
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
      absoluteFloor: NEGOTIATE_ABSOLUTE_FLOOR_NUM,
      turnCount: session.turnCount,
      maxTurns: NEGOTIATE_MAX_TURNS_NUM,
      displayName: session.displayName,
      apiKey: ANTHROPIC_API_KEY,
      model: ANTHROPIC_MODEL,
      geminiApiKey: GEMINI_API_KEY,
      geminiModel: GEMINI_MODEL,
      cloudflareAccountId: CF_ACCOUNT_ID,
      cloudflareApiToken: CF_API_TOKEN,
      cloudflareModel: CF_MODEL,
    });

    let replyText;
    if (result) {
      consecutiveAiFailures = 0;
      replyText = result.reply;
      session.currentPrice = Math.min(
        session.currentPrice,
        Math.max(NEGOTIATE_ABSOLUTE_FLOOR_NUM, Math.round(result.price))
      );
    } else {
      consecutiveAiFailures += 1;
      replyText = 'すみません、少し混み合っているみたいです。もう一度話しかけてもらえますか?';
    }

    session.transcript.push({ role: 'assistant', content: replyText });
    session.lastActivityAt = Date.now();

    if (result) {
      session.turnCount += 1;
      if (session.turnCount >= NEGOTIATE_MAX_TURNS_NUM) {
        applyFinalPrice(session, session.currentPrice);
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

app.post('/online-negotiate-finalize', (req, res) => {
  sweepStaleOnlineSessions();
  const { sessionId } = req.body ?? {};
  const session = onlineSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'セッションが見つかりません' });
  }
  if (session.busy) {
    return res.status(409).json({ ok: false, error: '前のやり取りを処理中です。少し待ってからもう一度お試しください' });
  }
  if (session.status === 'negotiating') {
    session.lastActivityAt = Date.now();
    applyFinalPrice(session, session.currentPrice);
  }
  if (session.status !== 'awaiting-payment') {
    return res.status(400).json({ ok: false, error: 'この価格では確定できません' });
  }
  return res.json({ ok: true, price: session.currentPrice, status: session.status });
});

app.post('/online-negotiate-cancel', (req, res) => {
  sweepStaleOnlineSessions();
  const { sessionId } = req.body ?? {};
  const session = typeof sessionId === 'string' ? onlineSessions.get(sessionId) : null;
  if (session && (session.status === 'negotiating' || session.status === 'awaiting-payment')) {
    session.status = 'expired';
  }
  return res.json({ ok: true });
});

// 投影用ページ(spectator/index.html)がポーリングする。現地の/negotiate-currentとは別の
// エンドポイントで、最大ONLINE_MAX_CONCURRENT件のセッション概要(タイル表示用に軽量化、
// 直近の発言のみ)+直近の当選(reveal)キューを返す。認証不要(現地の/negotiate-currentと同じ信頼レベル)。
app.get('/online-negotiate-current', (req, res) => {
  sweepStaleOnlineSessions();
  const sessions = [];
  for (const session of onlineSessions.values()) {
    if (session.status !== 'negotiating' && session.status !== 'awaiting-payment' && session.status !== 'awaiting-claim') continue;
    const lastMessage = session.transcript.length ? session.transcript[session.transcript.length - 1].content : '';
    sessions.push({
      displayName: session.displayName || maskWallet(session.wallet),
      status: session.status,
      price: session.currentPrice,
      turn: session.turnCount,
      maxTurn: NEGOTIATE_MAX_TURNS_NUM,
      lastMessage,
    });
  }
  return res.json({
    sessions: sessions.slice(0, ONLINE_MAX_CONCURRENT_NUM),
    reveals: onlineReveals,
  });
});

// 決済確認後、景品を抽選してEIP-712バウチャーに署名する。/verify-and-unlockと同じ
// オンチェーン検証ロジック(findValidTransfer/usedTxHashes/isRecentEnough)を再利用するが、
// ESP32の解除リクエストは一切積まない(オンラインは物理カプセルを出さない)。
app.post('/online-verify-and-claim', async (req, res) => {
  if (!ONLINE_ENABLED) {
    return res.status(503).json({ ok: false, error: 'オンライン参加は現在準備中です' });
  }
  const { txHash, sessionId } = req.body ?? {};
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return res.status(400).json({ ok: false, error: 'txHashの形式が不正です' });
  }
  if (typeof sessionId !== 'string') {
    return res.status(400).json({ ok: false, error: 'sessionIdが必要です' });
  }

  sweepStaleOnlineSessions();
  const session = onlineSessions.get(sessionId);
  if (!session || session.status !== 'awaiting-payment') {
    return res.status(400).json({ ok: false, error: '交渉結果が見つからないか、まだ価格が確定していません' });
  }
  if (session.quoteExpiresAt && Date.now() > session.quoteExpiresAt) {
    return res.status(400).json({ ok: false, error: '確定した価格の有効期限が切れています。もう一度交渉からやり直してください' });
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

    const transfer = findValidTransfer(receipt, session.finalPriceWei);
    if (!transfer) {
      return res.status(400).json({ ok: false, error: 'GAME_WALLET宛の有効なICHIGO送金が見つかりません' });
    }
    if (transfer.args.from.toLowerCase() !== session.wallet) {
      return res.status(400).json({ ok: false, error: '送金元のウォレットが交渉時と一致しません' });
    }

    if (usedTxHashes.has(txHash)) {
      return res.status(409).json({ ok: false, error: 'このtxHashはすでに使用済みです' });
    }
    usedTxHashes.add(txHash);
    saveUsedTxHashes();
    console.log(`オンライン決済 検証OK: ${txHash}`);

    const prize = pickPrize();
    const sessionNonce = ethers.keccak256(ethers.toUtf8Bytes(sessionId));
    const expiry = Math.floor(Date.now() / 1000) + Math.floor(ONLINE_VOUCHER_TTL_MS_NUM / 1000);
    const voucher = { wallet: session.wallet, prizeId: prize.id, sessionNonce, expiry };

    let signature;
    if (ONLINE_MOCK_MODE) {
      // モックモード: コントラクト未デプロイでもフロー全体を試せるよう、有効な署名の
      // 代わりにダミー値を返す。クライアント側はmock:trueを見て実際のclaim()呼び出しを
      // スキップし、演出だけシミュレーションする(本物のNFTは配布されない)。
      signature = '0x' + '00'.repeat(65);
    } else {
      const domain = {
        name: 'IchigoGachaNFT',
        version: '1',
        chainId: ONLINE_CHAIN_ID,
        verifyingContract: NFT_CONTRACT_ADDR,
      };
      const types = {
        ClaimVoucher: [
          { name: 'wallet', type: 'address' },
          { name: 'prizeId', type: 'uint256' },
          { name: 'sessionNonce', type: 'bytes32' },
          { name: 'expiry', type: 'uint256' },
        ],
      };
      signature = await onlineMinterWallet.signTypedData(domain, types, voucher);
    }

    session.status = 'awaiting-claim';
    session.prize = prize;
    session.voucher = { voucher, signature };

    recentPurchases.unshift({
      txHash,
      price: ethers.formatUnits(transfer.args.value, tokenDecimals),
      wallet: transfer.args.from,
      displayName: session.displayName,
      mode: 'online',
      completedAt: Date.now(),
      transcript: session.transcript,
    });
    if (recentPurchases.length > RECENT_PURCHASES_MAX) {
      recentPurchases.length = RECENT_PURCHASES_MAX;
    }

    // 現地の投影ページでも「こういうNFTが出ました」を見せる演出のソース。mint(claim)自体が
    // 成功したかどうかを待たず、景品が決まった時点で見せる(参加者がmintに手間取っても、
    // 会場の演出自体は滞らせないため)。
    onlineReveals.push({
      sessionId,
      displayName: session.displayName || maskWallet(session.wallet),
      prize: { id: prize.id, name: prize.name, image: prize.image },
      revealedAt: Date.now(),
    });

    return res.json({
      ok: true,
      txHash,
      mock: ONLINE_MOCK_MODE,
      contractAddress: ONLINE_MOCK_MODE ? null : NFT_CONTRACT_ADDR,
      chainId: ONLINE_CHAIN_ID,
      prize: { id: prize.id, name: prize.name, image: prize.image },
      voucher,
      signature,
    });
  } catch (err) {
    console.error('online-verify-and-claim処理中にエラー:', err);
    return res.status(500).json({ ok: false, error: 'サーバー内部エラー' });
  }
});

// 参加者が実際にclaim()を叩いてmintした後の後追い通知(投影演出・レシート用)。
// 参加者自身の成功画面表示はこれを待たない(mintのtx.wait()が成功した時点で即座に見せる)。
app.post('/online-claim-confirm', async (req, res) => {
  const { sessionId, txHash } = req.body ?? {};
  const session = typeof sessionId === 'string' ? onlineSessions.get(sessionId) : null;
  if (!session || session.status !== 'awaiting-claim') {
    return res.status(400).json({ ok: false, error: 'このセッションはmint待ちの状態ではありません' });
  }

  if (!ONLINE_MOCK_MODE) {
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return res.status(400).json({ ok: false, error: 'txHashの形式が不正です' });
    }
    try {
      const receipt = await getConfirmedReceiptWithRetry(txHash, 5, 1000);
      if (!receipt || receipt.status !== 1) {
        return res.status(400).json({ ok: false, error: 'mintトランザクションが確認できません' });
      }
      const minted = receipt.logs.some((log) => {
        if (log.address.toLowerCase() !== NFT_CONTRACT_ADDR.toLowerCase()) return false;
        let parsed;
        try {
          parsed = nftInterface.parseLog(log);
        } catch {
          return false;
        }
        return (
          parsed?.name === 'TransferSingle' &&
          parsed.args.from === ethers.ZeroAddress &&
          parsed.args.to.toLowerCase() === session.wallet &&
          parsed.args.id === BigInt(session.prize.id)
        );
      });
      if (!minted) {
        return res.status(400).json({ ok: false, error: 'このトランザクションからmintを確認できませんでした' });
      }
    } catch (err) {
      console.error('online-claim-confirm処理中にエラー:', err);
      return res.status(500).json({ ok: false, error: 'サーバー内部エラー' });
    }
  }

  session.status = 'claimed';
  session.claimTxHash = ONLINE_MOCK_MODE ? txHash || null : txHash;
  const purchase = recentPurchases.find((p) => p.wallet.toLowerCase() === session.wallet);
  if (purchase) purchase.claimTxHash = session.claimTxHash;

  return res.json({ ok: true });
});

// スタッフ用(時間があれば運用): 現在アクティブなオンラインセッション一覧。
app.get('/online-negotiate-admin-list', (req, res) => {
  if (!isValidNegotiateAdminSecret(req.get('X-Secret'))) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  sweepStaleOnlineSessions();
  const sessions = [...onlineSessions.entries()]
    .filter(([, s]) => s.status !== 'expired' && s.status !== 'claimed')
    .map(([sessionId, s]) => ({
      sessionId,
      wallet: s.wallet,
      displayName: s.displayName,
      status: s.status,
      price: s.currentPrice,
      turn: s.turnCount,
      transcript: s.transcript,
    }));
  return res.json({ ok: true, sessions });
});

// スタッフ用: 参加者のスマホが止まった等で放置されたオンラインセッションを強制終了する。
app.post('/online-negotiate-admin-cancel', (req, res) => {
  if (!isValidNegotiateAdminSecret(req.get('X-Secret'))) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const { sessionId } = req.body ?? {};
  const session = typeof sessionId === 'string' ? onlineSessions.get(sessionId) : null;
  if (!session) {
    return res.json({ ok: true, cancelled: false });
  }
  session.status = 'expired';
  return res.json({ ok: true, cancelled: true });
});

// NFTのERC-1155メタデータ。ウォレット/マーケットプレイスがtokenURI(コントラクトの
// uri())中の"{id}"を実際のtoken id(64桁の0埋め16進数)に置き換えてfetchしてくる
// (ERC-1155標準の挙動)ため、末尾の.jsonを外して16進として解釈し、対応する
// PRIZE_POOLのエントリからその場でJSONを生成する(静的ファイルを個別に用意しない)。
app.get('/nft-metadata/:idHex', (req, res) => {
  const idHex = req.params.idHex.replace(/\.json$/i, '');
  const id = parseInt(idHex, 16);
  const prize = PRIZE_POOL.find((p) => p.id === id);
  if (!prize) {
    return res.status(404).json({ error: 'not found' });
  }
  return res.json({
    name: prize.name,
    description: 'ICHIGOガチャガチャ オンライン参加記念NFT',
    image: `${req.protocol}://${req.get('host')}/nft-images/${prize.image}`,
  });
});

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

function timingSafeStringEqual(expected, provided) {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // 長さが違うとtimingSafeEqualが例外を投げるため、その場合は先に弾く
  // (このタイミング差はURL/クエリに秘密を載せる場合ほど実用上の脅威にはならない)
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isValidEsp32Secret(provided) {
  return timingSafeStringEqual(ESP32_SECRET, provided);
}

// /negotiate-admin-*系(価格を直接操作できる、実質的に金銭価値のある操作)専用の合言葉。
// NEGOTIATE_ADMIN_SECRETが未設定なら、物理操作用のESP32_SECRETにフォールバックする
// (既存の単一シークレット運用のデプロイを壊さないため)。
function isValidNegotiateAdminSecret(provided) {
  return timingSafeStringEqual(NEGOTIATE_ADMIN_SECRET || ESP32_SECRET, provided);
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
  sweepStaleNegotiationSessions();

  let unlockPayload = { unlock: false };
  for (const [txHash, request] of unlockRequests) {
    if (request.status === 'pending') {
      request.status = 'dispatched';
      request.dispatchedAt = Date.now();
      unlockPayload = { unlock: true, requestId: txHash, displayName: request.displayName || '' };
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

  // 交渉中(まだ支払い前)であることをESP32のOLEDに常時流させるためのフラグ。
  // 実機1台=同時1交渉の前提なのでcurrentSessionIdだけを見ればよい(spectator/index.htmlの
  // /negotiate-currentと同じ考え方)。displayNameは客が登録していれば呼び名込みで、
  // 無ければ名前無しの文言をESP32側で出し分ける。
  let negotiatingPayload = { negotiating: false };
  if (currentSessionId) {
    const negotiatingSession = negotiationSessions.get(currentSessionId);
    if (negotiatingSession && negotiatingSession.status === 'negotiating') {
      negotiatingPayload = { negotiating: true, negotiatingName: negotiatingSession.displayName || '' };
    }
  }

  return res.json({ ...unlockPayload, ...testMovePayload, ...adminLockPayload, ...negotiatingPayload });
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
