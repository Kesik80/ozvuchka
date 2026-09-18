// api/quota.js — остаток символов по всем аккаунтам ElevenLabs.
// Ключи остаются на сервере, в браузер уходят только цифры.
// GET с заголовком Authorization: Bearer <token из /api/auth>
import { checkToken } from './_token.js';
import { getKeys, subscription } from './_eleven.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!checkToken(auth)) return res.status(401).json({ error: 'unauthorized', code: 'auth' });

  const keys = getKeys();
  if (!keys.length) return res.status(500).json({ error: 'ELEVENLABS_API_KEY не задан в Vercel' });

  const accounts = await Promise.all(keys.map(async (key, i) => {
    try {
      const d = await subscription(key);
      return Object.assign({ index: i }, d);
    } catch (e) {
      // Частый случай: у ключа нет права User → Access. Озвучка при этом работает,
      // просто остаток символов посмотреть нельзя.
      let msg = e.message, noPerm = false;
      try {
        const d = JSON.parse(e.body || '{}').detail || {};
        if (d.message) msg = d.message;
        noPerm = d.status === 'missing_permissions';
      } catch (_) {}
      return { index: i, error: msg, noPermission: noPerm, status: e.status || 0,
               used: 0, limit: 0, left: 0, percent: 0, tier: '—' };
    }
  }));

  const usable = accounts.filter((a) => !a.error);
  const left = usable.reduce((n, a) => n + a.left, 0);
  const limit = usable.reduce((n, a) => n + a.limit, 0);
  // следующий рабочий аккаунт — с наибольшим остатком
  const best = usable.slice().sort((a, b) => b.left - a.left)[0];

  return res.json({
    accounts,
    left, limit,
    percent: limit ? Math.round((limit - left) / limit * 100) : 0,
    best: best ? best.index : 0,
  });
}
