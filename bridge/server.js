// Step 2: ICHIGO送金の検証ブリッジ
//
// payment/index.html から送金成功時の txHash を受け取り、Optimism上で
// 「本当にGAME_WALLET宛にCOST以上のICHIGOが送られたか」をオンチェーンで検証し、
// OKであればESP32の /unlock にリクエストを送って物理ガチャを動かす。
//
// 起動方法:
//   cp .env.example .env  (中身を自分の環境に合わせて編集)
//   npm install
//   npm start

import 'dotenv/config';
import express from 'express';
import { ethers } from 'ethers';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_DIR = path.join(__dirname, '..', 'payment');

const {
  RPC_URL,
  TOKEN_ADDR,
  GAME_WALLET,
  COST,
  ESP32_IP,
  ESP32_SECRET,
  PORT = 3001,
} = process.env;

// ESP32_IP/ESP32_SECRETは未設定でも動く(ICHIGO_gameとMacだけで送金検証を試す段階でも使えるように)。
// それ以外の、送金検証そのものに必須の値だけ必須チェックする。
for (const [name, value] of Object.entries({ RPC_URL, TOKEN_ADDR, GAME_WALLET, COST })) {
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

const usedTxHashes = new Set();
let tokenDecimals;
let costInWei;

async function loadTokenDecimals() {
  tokenDecimals = await tokenContract.decimals();
  costInWei = ethers.parseUnits(String(COST), tokenDecimals);
  console.log(`ICHIGOトークンのdecimals=${tokenDecimals}, COST=${COST} ICHIGO (=${costInWei.toString()} wei相当)`);
}

// receiptがまだ取得できない(ブロック伝播待ち)場合に備えて数回リトライする
async function getReceiptWithRetry(txHash, attempts = 5, delayMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
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

async function triggerEsp32Unlock() {
  if (!ESP32_IP || !ESP32_SECRET) {
    console.warn('ESP32_IP/ESP32_SECRET未設定のため、物理ガチャへの通知はスキップします(送金検証のみ実施)');
    return false;
  }
  const response = await fetch(`http://${ESP32_IP}/unlock`, {
    method: 'POST',
    headers: { 'X-Secret': ESP32_SECRET },
  });
  if (!response.ok) {
    throw new Error(`ESP32が${response.status}を返しました`);
  }
  return true;
}

const app = express();
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
    const receipt = await getReceiptWithRetry(txHash);
    if (!receipt) {
      return res.status(404).json({ ok: false, error: 'トランザクションが見つかりません(未確定の可能性)' });
    }
    if (receipt.status !== 1) {
      return res.status(400).json({ ok: false, error: 'トランザクションが失敗しています' });
    }

    const transfer = findValidTransfer(receipt);
    if (!transfer) {
      return res.status(400).json({ ok: false, error: 'GAME_WALLET宛の有効なICHIGO送金が見つかりません' });
    }

    usedTxHashes.add(txHash);
    console.log(`検証OK: ${txHash}(送金額はCOST以上、GAME_WALLET宛のICHIGO送金を確認)`);

    // 送金の検証自体は成功しているので、ESP32側の失敗(未接続など)で
    // レスポンス全体を失敗扱いにはしない(検証とハード連携を切り分ける)。
    let esp32Notified = false;
    try {
      esp32Notified = await triggerEsp32Unlock();
    } catch (err) {
      console.warn('ESP32への通知に失敗しました(送金検証自体は成功):', err.message);
    }

    return res.json({ ok: true, esp32Notified });
  } catch (err) {
    console.error('verify-and-unlock処理中にエラー:', err);
    return res.status(500).json({ ok: false, error: 'サーバー内部エラー' });
  }
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
