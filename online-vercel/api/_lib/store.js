// Vercelのサーバーレス関数はリクエスト間でメモリを共有しない(コールドスタート/複数
// インスタンスへの分散があるため、bridge/server.jsのようにMapに状態を持たせる方式は使えない)。
// 代わりにUpstash Redis(REST API経由、常時接続を張らないためサーバーレスと相性が良い)に
// 状態を持たせる。TTLでの自動失効に任せることで、bridge側にあった「sweepStale*」系の
// 定期掃除関数が不要になっている(キーが無くなる=セッションが無い、として扱うだけでよい)。
import { Redis } from '@upstash/redis';

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

if (!url || !token) {
  console.error(
    'Redis接続情報が設定されていません。Vercelダッシュボードの Storage タブから ' +
    'Upstash for Redis(またはVercel KV)を作成し、環境変数を連携してください。'
  );
}

export const redis = new Redis({ url, token });

// 交渉(negotiating)〜支払い確定(awaiting-payment、クオート有効期限=NEGOTIATE_QUOTE_TTL_MS)の
// 両方をカバーできるだけの長さにしておく(クオート有効期限より短いとTTLが先に切れてしまうため)。
const SESSION_TTL_SEC = 20 * 60;
// 支払い直後(awaiting-claim、景品お披露目〜claim-confirmまでの数秒)だけの短いTTL
const CLAIMED_TTL_SEC = 2 * 60;
// 送金tx replayを防ぐための「使用済み」マーカー。オンチェーン検証側で15分より古い
// txはどのみち拒否されるため、それより十分長く持たせておけば実用上問題ない。
const USED_TX_TTL_SEC = 60 * 60;

const ACTIVE_SET_KEY = 'online:active';
const REVEALS_KEY = 'online:reveals';
const REVEALS_MAX = 20;
const REVEALS_MAX_AGE_MS = 2 * 60 * 1000;

const sessionKey = (id) => `online:session:${id}`;
const walletKey = (wallet) => `online:wallet:${wallet.toLowerCase()}`;
const usedTxKey = (txHash) => `online:usedtx:${txHash.toLowerCase()}`;

export async function getSession(sessionId) {
  if (!sessionId) return null;
  return redis.get(sessionKey(sessionId));
}

export async function saveSession(sessionId, session, ttlSec = SESSION_TTL_SEC) {
  await redis.set(sessionKey(sessionId), session, { ex: ttlSec });
}

export async function deleteSession(sessionId) {
  await Promise.all([redis.del(sessionKey(sessionId)), removeActiveSession(sessionId)]);
}

export async function linkWallet(wallet, sessionId, ttlSec = SESSION_TTL_SEC) {
  await redis.set(walletKey(wallet), sessionId, { ex: ttlSec });
}

// 同じウォレットで既にアクティブなセッションがあればそのIDを返す(ページ再読み込み等での復帰)。
// walletKeyが指すセッションが既にTTL切れ/削除済みならnullを返す(sweep相当の自己修復)。
export async function findActiveSessionIdByWallet(wallet) {
  const sessionId = await redis.get(walletKey(wallet));
  if (!sessionId) return null;
  const session = await getSession(sessionId);
  if (!session) return null;
  return sessionId;
}

export async function addActiveSession(sessionId) {
  await redis.sadd(ACTIVE_SET_KEY, sessionId);
}

export async function removeActiveSession(sessionId) {
  await redis.srem(ACTIVE_SET_KEY, sessionId);
}

// 現在「交渉中」または「支払い待ち」で枠を占有しているセッション数。
// awaiting-claim(支払い済み・お披露目中)はカウントに含めない(bridge/server.jsの
// countActiveOnlineSessionsと同じ挙動)。setに残ったままの失効エントリはここで間引く。
export async function countActiveSessions() {
  const ids = await redis.smembers(ACTIVE_SET_KEY);
  if (!ids.length) return 0;
  const sessions = await Promise.all(ids.map((id) => getSession(id)));
  const stale = [];
  let count = 0;
  sessions.forEach((session, i) => {
    if (!session) {
      stale.push(ids[i]);
    } else if (session.status === 'negotiating' || session.status === 'awaiting-payment') {
      count += 1;
    }
  });
  if (stale.length) await redis.srem(ACTIVE_SET_KEY, ...stale);
  return count;
}

// 投影/一覧表示用: 現在アクティブな(negotiating/awaiting-payment/awaiting-claim)
// セッション本体をまとめて返す。
export async function listActiveSessions() {
  const ids = await redis.smembers(ACTIVE_SET_KEY);
  if (!ids.length) return [];
  const sessions = await Promise.all(ids.map(async (id) => ({ id, session: await getSession(id) })));
  return sessions.filter((s) => s.session);
}

export async function isTxUsed(txHash) {
  return Boolean(await redis.get(usedTxKey(txHash)));
}

export async function markTxUsed(txHash) {
  await redis.set(usedTxKey(txHash), '1', { ex: USED_TX_TTL_SEC });
}

export async function pushReveal(reveal) {
  await redis.lpush(REVEALS_KEY, reveal);
  await redis.ltrim(REVEALS_KEY, 0, REVEALS_MAX - 1);
}

export async function listReveals() {
  const items = await redis.lrange(REVEALS_KEY, 0, REVEALS_MAX - 1);
  const now = Date.now();
  return items.filter((r) => r && now - r.revealedAt <= REVEALS_MAX_AGE_MS);
}

// /online-negotiate-startの濫用防止。固定ウィンドウ方式のレートリミット
// (bridge/server.jsのcanStartNewOnlineNegotiationSessionと同じ緩さでよい)。
const RATE_LIMIT_KEY = 'online:ratelimit:start';
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_SEC = 60 * 60;

export async function canStartNewNegotiationSession() {
  const count = await redis.incr(RATE_LIMIT_KEY);
  if (count === 1) await redis.expire(RATE_LIMIT_KEY, RATE_LIMIT_WINDOW_SEC);
  return count <= RATE_LIMIT_MAX;
}

export const SESSION_TTL = SESSION_TTL_SEC;
export const CLAIMED_TTL = CLAIMED_TTL_SEC;

// session.busyを読んでから書き戻すまでの間に別リクエストが割り込める(TOCTOU)問題は、
// bridge/server.js(単一Nodeプロセス、awaitを挟まない同期チェックだったため race が
// 起きなかった)と違い、サーバーレスは複数インスタンスが本当に並行実行されうるため、
// セッションオブジェクトのフィールドではなくRedisのSET NXによる原子的なロックを使う。
const lockKey = (sessionId) => `online:lock:${sessionId}`;
const LOCK_TTL_SEC = 30; // AI呼び出しの最大待ち時間(negotiation.jsのREQUEST_TIMEOUT_MS×フォールバック段数)より長く

export async function acquireLock(sessionId) {
  const ok = await redis.set(lockKey(sessionId), '1', { nx: true, ex: LOCK_TTL_SEC });
  return ok === 'OK' || ok === true;
}

export async function releaseLock(sessionId) {
  await redis.del(lockKey(sessionId));
}
