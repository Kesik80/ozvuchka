// api/speak.js — озвучка одной реплики через ElevenLabs.
//
// POST { token, text, voiceId, modelId, voiceSettings, previousText, nextText, keyIndex, format }
//   → 200 audio/mpeg (сырые байты MP3), заголовок X-Key-Index — какой аккаунт озвучил
//   → 4xx/5xx JSON { error, code?, details? }
//
// Звук отдаётся бинарно, а не base64 в JSON: на треть меньше трафика,
// и длинные реплики не упираются в лимит ответа Vercel (~4,5 МБ).
//
// Если у аккаунта кончились символы — запрос повторяется следующим ключом (см. _eleven.js).
// Env: ELEVENLABS_API_KEY (+ _2 … _5 или ELEVENLABS_API_KEYS), EDITOR_PASSWORD
import { checkToken, delay } from './_token.js';
import { getKeys, isOutOfCredits } from './_eleven.js';

export const config = { maxDuration: 60 };

const VOICE_ID = /^[A-Za-z0-9]{15,40}$/;
const ALLOWED_MODELS = ['eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2_5'];
const ALLOWED_FORMATS = ['mp3_44100_64', 'mp3_44100_128'];
const MAX_CHARS = 3000;   // у eleven_v3 предел запроса — 3000 символов

const num = (v, min, max, dflt) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const b = req.body || {};
  if (!checkToken(b.token)) {
    await delay(500);
    return res.status(401).json({ error: 'Сессия истекла — войдите снова', code: 'auth' });
  }

  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'Пустой текст' });
  if (text.length > MAX_CHARS) {
    return res.status(400).json({ error: 'Реплика длиннее ' + MAX_CHARS + ' символов — разделите её', code: 'too_long' });
  }
  if (!VOICE_ID.test(String(b.voiceId || ''))) {
    return res.status(400).json({ error: 'Не выбран голос', code: 'no_voice' });
  }
  // карта «аккаунт → id голоса»: у созданных голосов id в каждом аккаунте свой
  const voiceMap = {};
  if (b.voiceMap && typeof b.voiceMap === 'object') {
    for (const k of Object.keys(b.voiceMap)) {
      if (/^\d+$/.test(k) && VOICE_ID.test(String(b.voiceMap[k]))) voiceMap[k] = String(b.voiceMap[k]);
    }
  }
  const hasMap = Object.keys(voiceMap).length > 0;

  const keys = getKeys();
  if (!keys.length) return res.status(500).json({ error: 'ELEVENLABS_API_KEY не задан в Vercel' });

  const start = Number.isInteger(b.keyIndex) && b.keyIndex >= 0 && b.keyIndex < keys.length ? b.keyIndex : 0;
  // с картой пробуем только аккаунты, где голос есть
  const order = keys.map((_, i) => (start + i) % keys.length).filter((i) => !hasMap || voiceMap[i]);
  if (!order.length) return res.status(400).json({ error: 'Этого голоса нет ни в одном аккаунте', code: 'no_voice' });

  const model = ALLOWED_MODELS.includes(b.modelId) ? b.modelId : 'eleven_multilingual_v2';
  const format = ALLOWED_FORMATS.includes(b.format) ? b.format : 'mp3_44100_64';
  const isV3 = model === 'eleven_v3';

  const vs = b.voiceSettings || {};
  let stability = num(vs.stability, 0, 1, 0.5);
  // v3 принимает только 0 / 0.5 / 1 (Creative / Natural / Robust)
  if (isV3) stability = stability < 0.25 ? 0 : stability > 0.75 ? 1 : 0.5;

  const settings = {
    stability,
    similarity_boost: num(vs.similarity_boost, 0, 1, 0.75),
    style: num(vs.style, 0, 1, 0),
    use_speaker_boost: vs.use_speaker_boost !== false,
  };
  const speed = num(vs.speed, 0.7, 1.2, 1);
  if (speed !== 1) settings.speed = speed;

  const body = { text, model_id: model, voice_settings: settings };
  // Невидимый контекст интонации: соседние реплики. У v3 не поддерживается.
  if (!isV3) {
    if (b.previousText) body.previous_text = String(b.previousText).slice(-400);
    if (b.nextText) body.next_text = String(b.nextText).slice(0, 400);
  }

  let lastError = null;
  for (const idx of order) {
    try {
      const r = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceMap[idx] || b.voiceId}?output_format=${format}`,
        {
          method: 'POST',
          headers: { Accept: 'audio/mpeg', 'Content-Type': 'application/json', 'xi-api-key': keys[idx] },
          body: JSON.stringify(body),
        }
      );
      if (!r.ok) {
        const details = (await r.text()).slice(0, 400);
        if (r.status === 402 || /paid_plan_required/.test(details)) {
          // голос из библиотеки на бесплатном аккаунте — вдруг следующий аккаунт платный
          lastError = { error: 'Голос из библиотеки: на бесплатном плане ElevenLabs он через API не работает', code: 'paid_voice', details };
          continue;
        }
        if (/voice_not_found/.test(details) && order.length > 1) {
          // голос добавлен не во все аккаунты — пробуем следующий
          lastError = { error: 'Голоса нет в аккаунте ' + (idx + 1), details };
          continue;
        }
        if (isOutOfCredits(r.status, details) && order.length > 1) {
          lastError = { error: 'У аккаунта ' + (idx + 1) + ' кончились символы', details, code: 'credits' };
          continue;
        }
        return res.status(502).json({ error: 'ElevenLabs ' + r.status, details });
      }
      const audio = Buffer.from(await r.arrayBuffer());
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('X-Key-Index', String(idx));
      res.setHeader('X-Model', model);
      return res.status(200).send(audio);
    } catch (e) {
      lastError = { error: e.message };
    }
  }
  const status = lastError && lastError.code === 'paid_voice' ? 402 : 502;
  return res.status(status).json(Object.assign({ error: 'Символы кончились на всех аккаунтах', code: 'credits' }, lastError));
}
