import { getSession, deleteSession } from './_lib/store.js';
import { readJsonBody } from './_lib/util.js';

// 景品画像を見せ終わったこと(=このセッションの用が済んだこと)の後追い通知。
// オンライン枠(同時最大人数)の解放のために呼ぶ。以後この記録は不要なため、
// bridge/server.js版(status='claimed'のまま1時間保持)と違い、ここでは即座に削除する。
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });

  const { sessionId } = await readJsonBody(req);
  const session = typeof sessionId === 'string' ? await getSession(sessionId) : null;
  if (!session || session.status !== 'awaiting-claim') {
    return res.status(400).json({ ok: false, error: 'このセッションは受け取り待ちの状態ではありません' });
  }

  await deleteSession(sessionId);
  return res.status(200).json({ ok: true });
}
