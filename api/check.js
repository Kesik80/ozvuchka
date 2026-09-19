// api/check.js — проверка каждого ключа ElevenLabs.
//
// POST { token, tts: true|false }
//   → { keys: [{ index, tail, user, voices, tts }] }
//   каждая проверка: { ok, error?, hint?, ... }
//
// Ключ целиком в браузер не уходит — только последние 4 символа, чтобы понять, какой это ключ.
// Озвучка проверяется одним словом «Ja.» (около 3 символов с аккаунта).
import { checkToken, delay } from './_token.js';
import { getKeys } from './_eleven.js';

export const config = { maxDuration: 30 };

const FALLBACK_VOICE = 'JBFqnCBsd6RMkjVDRZzb';   // George — стандартный голос у старых аккаунтов

// Понятная причина по ответу ElevenLabs
function explain(status, body, perm) {
  let d = {};
  try { d = JSON.parse(body || '{}').detail || {}; } catch (_) {}
  const code = String(d.status || '');
  const msg = String(d.message || body || '').slice(0, 200);
  if (code === 'invalid_api_key' || (status === 401 && /invalid.*api.*key/i.test(msg))) {
    return { error: 'Ключ неверный или удалён', hint: 'Скопируйте ключ заново на сайте ElevenLabs → Developers → API Keys' };
  }
  if (code === 'missing_permissions') {
    return { error: 'Нет права «' + perm + '»', hint: 'На сайте ElevenLabs откройте ключ и включите это право (или «Unrestricted»)' };
  }
  if (code === 'detected_unusual_activity') {
    return { error: 'ElevenLabs отключил бесплатный доступ этому аккаунту', hint: 'Так бывает при VPN или нескольких бесплатных аккаунтах. Помогает только платный план' };
  }
  if (code === 'quota_exceeded' || /quota/i.test(msg)) {
    return { error: 'Символы кончились', hint: 'Ключ рабочий — дождитесь обновления лимита' };
  }
  if (status === 402 || code === 'paid_plan_required') {
    return { error: 'Нужен платный план', hint: '' };
  }
  if (status === 429) return { error: 'Слишком много запросов', hint: 'Повторите проверку через минуту' };
  return { error: 'ElevenLabs ' + status + (msg ? ': ' + msg : ''), hint: '' };
}

async function call(key, path, init) {
  const r = await fetch('https://api.elevenlabs.io' + path, Object.assign({}, init, {
    headers: Object.assign({ 'xi-api-key': key }, (init && init.headers) || {}),
  }));
  return r;
}

async function checkKey(key, i, withTts) {
  const out = { index: i, tail: key.slice(-4) };

  // 1. аккаунт и остаток символов — право User → Read
  try {
    const r = await call(key, '/v1/user/subscription');
    const t = await r.text();
    if (r.ok) {
      const d = JSON.parse(t);
      out.user = { ok: true, tier: d.tier || '—', left: Math.max(0, (d.character_limit || 0) - (d.character_count || 0)), limit: d.character_limit || 0 };
    } else out.user = Object.assign({ ok: false }, explain(r.status, t, 'User → Read'));
  } catch (e) { out.user = { ok: false, error: e.message }; }

  // 2. список голосов — право Voices → Read
  let voiceId = FALLBACK_VOICE;
  try {
    const r = await call(key, '/v2/voices?page_size=30');
    const t = await r.text();
    if (r.ok) {
      const list = JSON.parse(t).voices || [];
      // для пробы — свой или стандартный голос: библиотечные на бесплатном плане через API не работают
      const own = list.find((v) => v.category === 'premade') || list.find((v) => v.category === 'generated' || v.category === 'cloned');
      if (own) voiceId = own.voice_id;
      out.voices = { ok: true, count: list.length, premade: list.some((v) => v.category === 'premade') };
    } else out.voices = Object.assign({ ok: false }, explain(r.status, t, 'Voices → Read'));
  } catch (e) { out.voices = { ok: false, error: e.message }; }

  // 3. озвучка — право Text to Speech (тратит ~3 символа)
  if (withTts) {
    try {
      const r = await call(key, `/v1/text-to-speech/${voiceId}?output_format=mp3_22050_32`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: 'Ja.', model_id: 'eleven_flash_v2_5' }),
      });
      if (r.ok) { await r.arrayBuffer(); out.tts = { ok: true }; }
      else {
        const t = await r.text();
        out.tts = Object.assign({ ok: false }, explain(r.status, t, 'Text to Speech'));
        if (/voice_not_found/.test(t)) out.tts = { ok: false, error: 'В аккаунте нет голоса для пробы', hint: 'Выберите или создайте голос в этом аккаунте и проверьте снова' };
      }
    } catch (e) { out.tts = { ok: false, error: e.message }; }
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const b = req.body || {};
  if (!checkToken(b.token)) {
    await delay(500);
    return res.status(401).json({ error: 'Сессия истекла — войдите снова', code: 'auth' });
  }
  const keys = getKeys();
  if (!keys.length) return res.status(500).json({ error: 'Ни одного ключа: задайте ELEVENLABS_API_KEYS в Vercel и сделайте Redeploy' });

  const results = await Promise.all(keys.map((k, i) => checkKey(k, i, b.tts !== false)));
  return res.json({ keys: results });
}
