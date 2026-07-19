import { listActiveSessions } from './_lib/store.js';
import { isValidAdminSecret } from './_lib/util.js';

// スタッフ用: 現在アクティブなオンラインセッション一覧。
export default async function handler(req, res) {
  if (!isValidAdminSecret(req.headers['x-secret'])) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const active = await listActiveSessions();
  const sessions = active
    .filter(({ session }) => session.status !== 'claimed')
    .map(({ id, session }) => ({
      sessionId: id,
      wallet: session.wallet,
      displayName: session.displayName,
      status: session.status,
      price: session.currentPrice,
      turn: session.turnCount,
      transcript: session.transcript,
    }));
  return res.status(200).json({ ok: true, sessions });
}
