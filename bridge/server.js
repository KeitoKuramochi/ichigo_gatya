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

// ESP32がポーリングで見に来る「解除待ち」フラグ。メモリ上だけで十分
// (ブリッジが再起動したら未処理の解除request自体が失われるが、実運用上は
// せいぜい数秒のポーリング間隔なので、ほぼ即座にESP32が拾いに来る想定)。
let pendingUnlock = false;

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

    // ESP32へは直接送らず、「解除待ち」フラグを立てるだけ。ESP32が次のポーリングで拾いに来る。
    pendingUnlock = true;

    return res.json({ ok: true, queued: true });
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

// ESP32が数秒おきに問い合わせてくるエンドポイント。解除待ちがあれば1回だけ通知して消費する。
// 合言葉はURLではなくヘッダー(X-Secret)で受け取る(URLはログ等に残りやすいため)。
app.get('/poll-unlock', (req, res) => {
  if (!isValidEsp32Secret(req.get('X-Secret'))) {
    return res.status(403).json({ unlock: false, error: 'forbidden' });
  }
  const unlock = pendingUnlock;
  pendingUnlock = false;
  return res.json({ unlock });
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
