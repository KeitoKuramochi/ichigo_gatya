import { ONLINE_MAX_CONCURRENT_NUM, NEGOTIATE_MAX_TURNS_NUM } from './_lib/config.js';
import { listActiveSessions, listReveals } from './_lib/store.js';
import { maskWallet } from './_lib/util.js';

// 投影/一覧表示用。認証不要(bridge/server.jsの/online-negotiate-currentと同じ信頼レベル)。
export default async function handler(req, res) {
  const active = await listActiveSessions();
  const sessions = active
    .map(({ session }) => session)
    .filter((s) => s.status === 'negotiating' || s.status === 'awaiting-payment' || s.status === 'awaiting-claim')
    .map((session) => {
      const lastMessage = session.transcript.length ? session.transcript[session.transcript.length - 1].content : '';
      return {
        displayName: session.displayName || maskWallet(session.wallet),
        status: session.status,
        price: session.currentPrice,
        turn: session.turnCount,
        maxTurn: NEGOTIATE_MAX_TURNS_NUM,
        lastMessage,
      };
    });

  return res.status(200).json({
    sessions: sessions.slice(0, ONLINE_MAX_CONCURRENT_NUM),
    reveals: await listReveals(),
  });
}
