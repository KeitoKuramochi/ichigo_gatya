import { listWonPrizes } from './_lib/store.js';

// トップページが接続したウォレット宛に、これまで実際に当てた景品(永続記録)を返す。
// 認証は無い(walletは公開アドレスであり、他人のwalletを指定されても
// 「その人が何を当てたか」という秘匿性の無い情報が見えるだけ)。
export default async function handler(req, res) {
  const wallet = typeof req.query?.wallet === 'string' ? req.query.wallet : '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return res.status(400).json({ ok: false, error: 'walletの形式が不正です' });
  }
  const prizes = await listWonPrizes(wallet);
  return res.status(200).json({ ok: true, prizes });
}
