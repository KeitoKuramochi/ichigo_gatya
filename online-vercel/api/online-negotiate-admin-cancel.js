import { getSession, deleteSession } from './_lib/store.js';
import { isValidAdminSecret, readJsonBody } from './_lib/util.js';

// スタッフ用: 参加者のスマホが止まった等で放置されたオンラインセッションを強制終了する。
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });
  if (!isValidAdminSecret(req.headers['x-secret'])) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const { sessionId } = await readJsonBody(req);
  const session = typeof sessionId === 'string' ? await getSession(sessionId) : null;
  if (!session) {
    return res.status(200).json({ ok: true, cancelled: false });
  }
  await deleteSession(sessionId);
  return res.status(200).json({ ok: true, cancelled: true });
}
