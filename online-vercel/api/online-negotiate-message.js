import { NEGOTIATE_FLOOR_COST_NUM, NEGOTIATE_ABSOLUTE_FLOOR_NUM, NEGOTIATE_MAX_TURNS_NUM, aiKeys } from './_lib/config.js';
import { getSession, saveSession, acquireLock, releaseLock } from './_lib/store.js';
import { readJsonBody } from './_lib/util.js';
import { getNegotiationReply } from './_lib/negotiation.js';
import { applyFinalPrice } from './_lib/pricing.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });

  const { sessionId, message } = await readJsonBody(req);
  if (typeof sessionId !== 'string' || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ ok: false, error: 'sessionId/messageが不正です' });
  }
  if (message.length > 500) {
    return res.status(400).json({ ok: false, error: 'メッセージが長すぎます(500文字まで)' });
  }
  const session = await getSession(sessionId);
  if (!session || session.status !== 'negotiating') {
    return res.status(400).json({ ok: false, error: 'このセッションは交渉中ではありません' });
  }
  if (!(await acquireLock(sessionId))) {
    return res.status(409).json({ ok: false, error: '前のやり取りを処理中です。少し待ってからもう一度お試しください' });
  }

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
      ...aiKeys,
    });

    let replyText;
    if (result) {
      replyText = result.reply;
      session.currentPrice = Math.min(
        session.currentPrice,
        Math.max(NEGOTIATE_ABSOLUTE_FLOOR_NUM, Math.round(result.price))
      );
    } else {
      replyText = 'すみません、少し混み合っているみたいです。もう一度話しかけてもらえますか?';
    }

    session.transcript.push({ role: 'assistant', content: replyText });
    session.lastActivityAt = Date.now();

    if (result) {
      session.turnCount += 1;
      if (session.turnCount >= NEGOTIATE_MAX_TURNS_NUM) {
        await applyFinalPrice(session);
      }
    }

    await saveSession(sessionId, session);
    return res.status(200).json({
      ok: true,
      reply: replyText,
      price: session.currentPrice,
      turn: session.turnCount,
      maxTurn: NEGOTIATE_MAX_TURNS_NUM,
      status: session.status,
      done: session.status === 'awaiting-payment',
    });
  } finally {
    await releaseLock(sessionId);
  }
}
