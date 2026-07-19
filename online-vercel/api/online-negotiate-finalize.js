import { getSession, saveSession, acquireLock, releaseLock } from './_lib/store.js';
import { readJsonBody } from './_lib/util.js';
import { applyFinalPrice } from './_lib/pricing.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });

  const { sessionId } = await readJsonBody(req);
  const session = typeof sessionId === 'string' ? await getSession(sessionId) : null;
  if (!session) {
    return res.status(404).json({ ok: false, error: 'セッションが見つかりません' });
  }
  if (!(await acquireLock(sessionId))) {
    return res.status(409).json({ ok: false, error: '前のやり取りを処理中です。少し待ってからもう一度お試しください' });
  }
  try {
    if (session.status === 'negotiating') {
      session.lastActivityAt = Date.now();
      await applyFinalPrice(session);
    }
    if (session.status !== 'awaiting-payment') {
      return res.status(400).json({ ok: false, error: 'この価格では確定できません' });
    }
    await saveSession(sessionId, session);
    return res.status(200).json({ ok: true, price: session.currentPrice, status: session.status });
  } finally {
    await releaseLock(sessionId);
  }
}
