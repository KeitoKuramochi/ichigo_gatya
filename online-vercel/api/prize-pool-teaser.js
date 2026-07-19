import { getPrizeTeasers } from './_lib/prize-pool.js';

export default function handler(req, res) {
  return res.status(200).json({ ok: true, prizes: getPrizeTeasers() });
}
