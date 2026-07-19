import { ONLINE_ENABLED } from './_lib/config.js';
import { getSession, saveSession, isTxUsed, markTxUsed, pushReveal } from './_lib/store.js';
import { readJsonBody, maskWallet } from './_lib/util.js';
import { getConfirmedReceiptWithRetry, isRecentEnough, findValidTransfer, getTokenDecimals, ethers } from './_lib/chain.js';
import { pickPrize } from './_lib/prize-pool.js';

export const config = { maxDuration: 30 };

// 決済確認後、景品を抽選する。findValidTransfer/isRecentEnough等はbridge/server.jsと
// 同じオンチェーン検証ロジック。ESP32の解除リクエストは一切積まない(オンラインは
// 物理カプセルを出さない)。景品はNFTをmintするのではなく、この時点で決まった
// 画像情報をレスポンスにそのまま含めて返すだけ(コントラクト連携なし)。
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });
  if (!ONLINE_ENABLED) {
    return res.status(503).json({ ok: false, error: 'ただいま準備中です' });
  }

  const { txHash, sessionId } = await readJsonBody(req);
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return res.status(400).json({ ok: false, error: 'txHashの形式が不正です' });
  }
  if (typeof sessionId !== 'string') {
    return res.status(400).json({ ok: false, error: 'sessionIdが必要です' });
  }

  const session = await getSession(sessionId);
  if (!session || session.status !== 'awaiting-payment') {
    return res.status(400).json({ ok: false, error: '交渉結果が見つからないか、まだ価格が確定していません' });
  }
  if (session.quoteExpiresAt && Date.now() > session.quoteExpiresAt) {
    return res.status(400).json({ ok: false, error: '確定した価格の有効期限が切れています。もう一度交渉からやり直してください' });
  }
  if (await isTxUsed(txHash)) {
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

    const minWei = BigInt(session.finalPriceWei);
    const transfer = findValidTransfer(receipt, minWei);
    if (!transfer) {
      return res.status(400).json({ ok: false, error: 'GAME_WALLET宛の有効なICHIGO送金が見つかりません' });
    }
    if (transfer.args.from.toLowerCase() !== session.wallet) {
      return res.status(400).json({ ok: false, error: '送金元のウォレットが交渉時と一致しません' });
    }

    // 検証にかかる数秒〜十数秒の間に同じtxHashで二重にこのエンドポイントを叩かれるレースを防ぐ
    if (await isTxUsed(txHash)) {
      return res.status(409).json({ ok: false, error: 'このtxHashはすでに使用済みです' });
    }
    await markTxUsed(txHash);
    console.log(`ICHIGO決済 検証OK: ${txHash}`);

    const prize = pickPrize();
    const decimals = await getTokenDecimals();

    session.status = 'awaiting-claim';
    session.prize = prize;
    await saveSession(sessionId, session);

    await pushReveal({
      sessionId,
      displayName: session.displayName || maskWallet(session.wallet),
      prize: { id: prize.id, name: prize.name, image: prize.image, special: prize.special || false },
      revealedAt: Date.now(),
    });

    return res.status(200).json({
      ok: true,
      txHash,
      price: ethers.formatUnits(transfer.args.value, decimals),
      prize: { id: prize.id, name: prize.name, image: prize.image, special: prize.special || false },
    });
  } catch (err) {
    console.error('online-verify-and-claim処理中にエラー:', err);
    return res.status(500).json({ ok: false, error: 'サーバー内部エラー' });
  }
}
