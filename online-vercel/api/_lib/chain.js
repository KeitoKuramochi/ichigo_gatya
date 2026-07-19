// Optimism上のICHIGO(ERC-20)送金をオンチェーンで検証する。bridge/server.jsの
// 同名ロジック(findValidTransfer/isRecentEnough/getConfirmedReceiptWithRetry)を、
// 現地ESP32連携やunlockRequests等の物理ガチャ専用の部分を除いてそのまま移植したもの。
import { ethers } from 'ethers';

const {
  // Optimism公式の無料公開RPC(mainnet.optimism.io)はVercel等クラウド事業者のIPからの
  // アクセスをレート制限/ブロックすることがあり(decimals()呼び出しが空応答"0x"を返し
  // BAD_DATAで落ちる不具合として発覚、2026-07-19)、bridgeのRender環境では問題なく
  // 動いていたためこの移植時点では気づけなかった。drpc.orgの公開RPCに変更。
  RPC_URL = 'https://optimism.drpc.org',
  TOKEN_ADDR = '0x836700463Dce76D9Cc3CDf6F6EDF946312c01869',
  GAME_WALLET = '0x70775B1d24176De0fda2776303B8a603C671cFFb',
} = process.env;

// 確定から一定ブロック数経つまでは「まだ覆る可能性がある」として受け付けない
const MIN_CONFIRMATIONS = 2;
// 支払いから一定時間以上経過したtxHashは、後から使い回されるのを防ぐため受け付けない
const MAX_TX_AGE_SECONDS = 15 * 60;

const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function decimals() view returns (uint8)',
];

// コールドスタートのたびに再生成されるが、同じ実行コンテキストが温かいまま
// 次のリクエストを処理する場合はこのモジュールごと再利用される(decimalsのキャッシュも同様)。
const provider = new ethers.JsonRpcProvider(RPC_URL);
const tokenInterface = new ethers.Interface(ERC20_ABI);
const tokenContract = new ethers.Contract(TOKEN_ADDR, ERC20_ABI, provider);

let tokenDecimalsPromise = null;
export function getTokenDecimals() {
  if (!tokenDecimalsPromise) {
    tokenDecimalsPromise = tokenContract.decimals().catch((err) => {
      tokenDecimalsPromise = null; // 失敗時は次回リクエストで再試行できるようにする
      throw err;
    });
  }
  return tokenDecimalsPromise;
}

export async function getConfirmedReceiptWithRetry(txHash, attempts = 10, delayMs = 1000) {
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

export async function isRecentEnough(receipt) {
  const block = await provider.getBlock(receipt.blockNumber);
  const ageSeconds = Date.now() / 1000 - block.timestamp;
  return ageSeconds <= MAX_TX_AGE_SECONDS;
}

export function findValidTransfer(receipt, minWei) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== TOKEN_ADDR.toLowerCase()) continue;
    let parsed;
    try {
      parsed = tokenInterface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed?.name !== 'Transfer') continue;
    if (parsed.args.to.toLowerCase() !== GAME_WALLET.toLowerCase()) continue;
    if (parsed.args.value < minWei) continue;
    return parsed;
  }
  return null;
}

// デバッグ用: 実際に使われているRPC_URLのホスト名だけを安全に取り出す(APIキー部分は伏せる)
export function getRpcHostForDebug() {
  try {
    return new URL(RPC_URL).hostname;
  } catch {
    return `(invalid RPC_URL: ${JSON.stringify(RPC_URL)})`;
  }
}

export { ethers, GAME_WALLET, TOKEN_ADDR };
