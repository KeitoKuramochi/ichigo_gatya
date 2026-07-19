import { ONLINE_ENABLED, ONLINE_MAX_CONCURRENT_NUM } from './_lib/config.js';
import { countActiveSessions } from './_lib/store.js';

export default async function handler(req, res) {
  const activeCount = await countActiveSessions();
  return res.status(200).json({
    enabled: ONLINE_ENABLED,
    maxConcurrent: ONLINE_MAX_CONCURRENT_NUM,
    activeCount,
  });
}
