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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_DIR = path.join(__dirname, '..', 'payment');
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

function findValidTransfer(receipt) {
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
    if (parsed.args.value < costInWei) continue;

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

const app = express();
app.use(cors()); // Vercel等、別オリジンで配信されたpayment/index.htmlからも叩けるようにする
app.use(express.json());
app.use(express.static(GAME_DIR)); // 同じオリジンでpayment/を配信(スマホからも同じIP:PORTで開ける)

app.post('/verify-and-unlock', async (req, res) => {
  const { txHash } = req.body ?? {};

  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return res.status(400).json({ ok: false, error: 'txHashの形式が不正です' });
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

    const transfer = findValidTransfer(receipt);
    if (!transfer) {
      return res.status(400).json({ ok: false, error: 'GAME_WALLET宛の有効なICHIGO送金が見つかりません' });
    }

    // 二重チェック: リトライ中に別リクエストが同じtxHashを先に使用済みにしていないか再確認
    if (usedTxHashes.has(txHash)) {
      return res.status(409).json({ ok: false, error: 'このtxHashはすでに使用済みです' });
    }
    usedTxHashes.add(txHash);
    saveUsedTxHashes();
    console.log(`検証OK: ${txHash}(送金額はCOST以上、GAME_WALLET宛のICHIGO送金を確認、${MIN_CONFIRMATIONS}confirmations以上)`);

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
app.get('/poll-unlock', (req, res) => {
  if (!isValidEsp32Secret(req.get('X-Secret'))) {
    return res.status(403).json({ unlock: false, error: 'forbidden' });
  }
  sweepStaleUnlockRequests();
  for (const [txHash, request] of unlockRequests) {
    if (request.status === 'pending') {
      request.status = 'dispatched';
      request.dispatchedAt = Date.now();
      return res.json({ unlock: true, requestId: txHash });
    }
  }
  return res.json({ unlock: false });
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
