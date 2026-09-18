// _eleven.js — ключи ElevenLabs: несколько аккаунтов и переход на следующий,
// когда у текущего закончились символы.
//
// Переменные в Vercel (достаточно одной):
//   ELEVENLABS_API_KEY     — первый аккаунт
//   ELEVENLABS_API_KEY_2   — второй, _3, _4, _5 — дальше
//   ELEVENLABS_API_KEYS    — или все сразу через запятую
//
// Файл с «_» в начале Vercel не публикует как отдельную функцию.

export function getKeys() {
  const out = [];
  const add = (v) => {
    const k = String(v || '').trim();
    if (k && !out.includes(k)) out.push(k);
  };
  add(process.env.ELEVENLABS_API_KEY);
  for (let i = 2; i <= 5; i++) add(process.env['ELEVENLABS_API_KEY_' + i]);
  String(process.env.ELEVENLABS_API_KEYS || '').split(',').forEach(add);
  return out;
}

// Кончились символы: ElevenLabs отвечает 401 с quota_exceeded, иногда 429
export function isOutOfCredits(status, body) {
  const t = String(body || '').toLowerCase();
  if (status === 429) return true;
  return status === 401 && (t.includes('quota_exceeded') || t.includes('quota exceeded') || t.includes('credits'));
}

export async function subscription(key) {
  const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': key } });
  const text = await r.text();
  if (!r.ok) {
    const e = new Error('ElevenLabs ' + r.status);
    e.status = r.status;
    e.body = text.slice(0, 200);
    throw e;
  }
  const d = JSON.parse(text);
  const used = d.character_count || 0;
  const limit = d.character_limit || 0;
  return {
    used, limit,
    left: Math.max(0, limit - used),
    percent: limit ? Math.round(used / limit * 100) : 0,
    tier: d.tier || '—',
    resetUnix: d.next_character_count_reset_unix || null,
  };
}
