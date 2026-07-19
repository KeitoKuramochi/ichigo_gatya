import crypto from 'crypto';

// 表示名(任意入力のニックネーム)を安全な形に整える。制御文字/改行を潰し、
// 前後の空白を落とし、長さを制限する。空になった場合はnull。
// (bridge/server.jsのsanitizeDisplayNameと同じ考え方だが、ESP32のOLED文字制限は
// このオンライン専用デプロイには存在しないため、絵文字以外は広めに許可する)
const DISPLAY_NAME_MAX_LENGTH = 20;
export function sanitizeDisplayName(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, DISPLAY_NAME_MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

export function maskWallet(wallet) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

export function timingSafeStringEqual(expected, provided) {
  if (!expected || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function isValidAdminSecret(provided) {
  return timingSafeStringEqual(process.env.ADMIN_SECRET, provided);
}

// Vercelのサーバーレス関数はNode.js標準のhttp.IncomingMessageに近いreq/resを受け取るが、
// Next.js無しの素の/api関数ではJSONボディが自動パースされないため、ここで読む。
export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body; // 既にパース済みならそのまま
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
