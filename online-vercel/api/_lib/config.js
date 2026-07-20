// bridge/server.jsの環境変数まわりのバリデーション(fail closed)と同じ考え方を踏襲しつつ、
// 現地専用の値(ESP32_SECRET等)は取り除いた、オンライン参加専用の設定。
const {
  COST = '2000',
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001',
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o-mini',
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_MODEL = '@cf/meta/llama-3.1-8b-instruct',
  NEGOTIATE_FLOOR_COST,
  NEGOTIATE_ABSOLUTE_FLOOR = '0',
  NEGOTIATE_MAX_TURNS = '4',
  NEGOTIATE_QUOTE_TTL_MS = String(10 * 60 * 1000),
  // 現地版(実機1台)の名残で当初2にしていたが、オンライン専用になった今は
  // 台数の制約が無いため、実質無制限とみなせる大きめの値をデフォルトにする
  // (0や極端な巨大値にしない理由: AI API呼び出しが同時に集中した場合の
  // 異常系(タイムアウト連鎖等)を完全に無視しないための緩い安全弁として残す)。
  ONLINE_MAX_CONCURRENT = '100',
} = process.env;

export const COST_NUM = Number(COST);
export const NEGOTIATE_MAX_TURNS_NUM = parseInt(NEGOTIATE_MAX_TURNS, 10);
export const NEGOTIATE_ABSOLUTE_FLOOR_NUM = parseFloat(NEGOTIATE_ABSOLUTE_FLOOR);
export const NEGOTIATE_QUOTE_TTL_MS_NUM = parseInt(NEGOTIATE_QUOTE_TTL_MS, 10);
export const NEGOTIATE_FLOOR_COST_NUM = NEGOTIATE_FLOOR_COST ? parseFloat(NEGOTIATE_FLOOR_COST) : null;
export const ONLINE_MAX_CONCURRENT_NUM = parseInt(ONLINE_MAX_CONCURRENT, 10);

// AI(Anthropic/OpenAI/Cloudflareのいずれか)+ NEGOTIATE_FLOOR_COSTが揃って初めて有効。
// 揃っていなければ「決済させたのに景品を渡せない」事故を避けるため、入口
// (/online-negotiate-start)でオンライン参加自体を503にする。
export const ONLINE_ENABLED = Boolean(
  (OPENAI_API_KEY || ANTHROPIC_API_KEY || (CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN)) && NEGOTIATE_FLOOR_COST
);

export const aiKeys = {
  anthropicApiKey: ANTHROPIC_API_KEY,
  anthropicModel: ANTHROPIC_MODEL,
  openaiApiKey: OPENAI_API_KEY,
  openaiModel: OPENAI_MODEL,
  cloudflareAccountId: CLOUDFLARE_ACCOUNT_ID,
  cloudflareApiToken: CLOUDFLARE_API_TOKEN,
  cloudflareModel: CLOUDFLARE_MODEL,
};
