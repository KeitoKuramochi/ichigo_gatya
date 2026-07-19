import { deleteSession } from './_lib/store.js';
import { readJsonBody } from './_lib/util.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });

  const { sessionId } = await readJsonBody(req);
  if (typeof sessionId === 'string') {
    await deleteSession(sessionId);
  }
  return res.status(200).json({ ok: true });
}
