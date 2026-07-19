import { ethers } from 'ethers';
import { getTokenDecimals } from './chain.js';
import { NEGOTIATE_QUOTE_TTL_MS_NUM } from './config.js';

// 交渉確定時にsession.currentPriceから確定額(finalPriceWei)を固める。
// Redis(JSON)にはBigIntをそのまま保存できないため文字列で持つ
// (オンチェーン検証側ではBigIn化して比較する。api/_lib/chain.js参照)。
export async function applyFinalPrice(session) {
  const decimals = await getTokenDecimals();
  session.finalPriceWei = ethers.parseUnits(String(session.currentPrice), decimals).toString();
  session.quoteExpiresAt = Date.now() + NEGOTIATE_QUOTE_TTL_MS_NUM;
  session.status = 'awaiting-payment';
}
