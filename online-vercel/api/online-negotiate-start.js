import crypto from 'crypto';
import { ONLINE_ENABLED, ONLINE_MAX_CONCURRENT_NUM, COST_NUM, NEGOTIATE_MAX_TURNS_NUM } from './_lib/config.js';
import {
  findActiveSessionIdByWallet,
  getSession,
  saveSession,
  linkWallet,
  addActiveSession,
  countActiveSessions,
  canStartNewNegotiationSession,
} from './_lib/store.js';
import { sanitizeDisplayName, readJsonBody } from './_lib/util.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });
  if (!ONLINE_ENABLED) {
    return res.status(503).json({ ok: false, error: 'ただいま準備中です' });
  }

  const { wallet, displayName } = await readJsonBody(req);
  if (typeof wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return res.status(400).json({ ok: false, error: 'walletの形式が不正です' });
  }
  if (displayName !== undefined && typeof displayName !== 'string') {
    return res.status(400).json({ ok: false, error: 'displayNameの形式が不正です' });
  }
  const normalizedWallet = wallet.toLowerCase();
  const sanitizedName = sanitizeDisplayName(displayName);

  // 同じウォレットで既にアクティブなセッションがあれば、新規作成せずそれを返す
  // (ページ再読み込み等での復帰)。
  const existingId = await findActiveSessionIdByWallet(normalizedWallet);
  if (existingId) {
    const existing = await getSession(existingId);
    if (existing && (existing.status === 'negotiating' || existing.status === 'awaiting-payment' || existing.status === 'awaiting-claim')) {
      if (sanitizedName) existing.displayName = sanitizedName;
      await saveSession(existingId, existing);
      return res.status(200).json({
        ok: true,
        sessionId: existingId,
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

  if ((await countActiveSessions()) >= ONLINE_MAX_CONCURRENT_NUM) {
    return res.status(429).json({ ok: false, error: `現在混み合っています(同時最大${ONLINE_MAX_CONCURRENT_NUM}人)。しばらくしてからもう一度お試しください` });
  }
  if (!(await canStartNewNegotiationSession())) {
    return res.status(429).json({ ok: false, error: '現在混み合っています。少し時間を置いてもう一度お試しください' });
  }

  const startingPrice = COST_NUM;
  const openingReply = `いらっしゃい!ICHIGOガチャガチャ延長戦へようこそ。今日も定価(${startingPrice} ICHIGO)から始めるよ。授業でやったような話でもしてくれたら、ちょっとサービスしちゃうかもよ?何か言いたいことある?`;
  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const session = {
    status: 'negotiating',
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
  };

  await saveSession(sessionId, session);
  await linkWallet(normalizedWallet, sessionId);
  await addActiveSession(sessionId);

  return res.status(200).json({
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
}
