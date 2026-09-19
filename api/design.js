// api/design.js — создание своего голоса по описанию (ElevenLabs Voice Design).
//
// Такие голоса — собственные голоса аккаунта, а не из библиотеки,
// поэтому через API работают и на бесплатном плане.
//
// POST { token, action:'preview', description, text, model, keyIndex, seed }
//   → { previews: [{ id, audio (base64 mp3), dur }], text, keyIndex, seed }
//   Три варианта голоса, каждый читает text.
//
// POST { token, action:'save', keyIndex, generatedVoiceId, index, name, description, text, model, seed, everywhere }
//   → { ok, results: [{ keyIndex, ok, id?, error? }], ids: { [keyIndex]: voiceId } }
//   Сохраняет выбранный вариант в аккаунт keyIndex. everywhere=true — ещё и в остальные:
//   там голос создаётся заново с тем же seed и теми же данными, а ElevenLabs
//   обещает при этом тот же голос. id голоса в каждом аккаунте свой.
//
// Env: ELEVENLABS_API_KEY (+ _2 … _5 или ELEVENLABS_API_KEYS), EDITOR_PASSWORD
import { checkToken, delay } from './_token.js';
import { getKeys } from './_eleven.js';

export const config = { maxDuration: 60 };

const MODELS = ['eleven_multilingual_ttv_v2', 'eleven_ttv_v3'];

async function el(key, path, body) {
  const r = await fetch('https://api.elevenlabs.io' + path, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = 'ElevenLabs ' + r.status;
    let status = '';
    try {
      const d = JSON.parse(text).detail;
      if (d && d.message) msg = d.message;
      if (d && d.status) status = d.status;
    } catch (_) {}
    if (/voice_limit|limit.*voices|maximum.*voices/i.test(status + ' ' + msg)) {
      msg = 'В аккаунте закончились места для своих голосов — удалите ненужный на сайте ElevenLabs';
    } else if (/quota|credits|character/i.test(status + ' ' + msg) && r.status !== 400) {
      msg = 'В аккаунте кончились символы';
    }
    const e = new Error(msg);
    e.status = r.status;
    throw e;
  }
  return JSON.parse(text || '{}');
}

function designBody(b) {
  const body = {
    voice_description: String(b.description || '').trim().slice(0, 1000),
    model_id: MODELS.includes(b.model) ? b.model : 'eleven_multilingual_ttv_v2',
    text: String(b.text || '').trim().slice(0, 1000),
    loudness: 0.5,
  };
  if (Number.isInteger(b.seed) && b.seed >= 0) body.seed = b.seed;
  return body;
}

// 192 кбит/с (формат по умолчанию) доступен только на платных планах
const DESIGN_PATH = '/v1/text-to-voice/design?output_format=mp3_44100_128';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const b = req.body || {};
  if (!checkToken(b.token)) {
    await delay(500);
    return res.status(401).json({ error: 'Сессия истекла — войдите снова', code: 'auth' });
  }
  const keys = getKeys();
  if (!keys.length) return res.status(500).json({ error: 'ELEVENLABS_API_KEY не задан в Vercel' });

  const idx = Number.isInteger(b.keyIndex) && b.keyIndex >= 0 && b.keyIndex < keys.length ? b.keyIndex : 0;
  const body = designBody(b);
  if (body.voice_description.length < 20) return res.status(400).json({ error: 'Описание голоса — минимум 20 символов' });
  if (body.text.length < 100) return res.status(400).json({ error: 'Текст для пробы — минимум 100 символов' });

  try {
    if (b.action === 'preview') {
      const d = await el(keys[idx], DESIGN_PATH, body);
      const previews = (d.previews || []).map((p) => ({
        id: p.generated_voice_id,
        audio: p.audio_base_64,
        dur: p.duration_secs || 0,
        lang: p.language || '',
      }));
      return res.json({ previews, text: d.text || body.text, keyIndex: idx, seed: body.seed ?? null });
    }

    if (b.action === 'save') {
      const name = String(b.name || '').trim().slice(0, 40) || 'Deutsch';
      const labels = { language: 'de', accent: 'german', made_in: 'ozvuchka' };
      const create = (key, generated) => el(key, '/v1/text-to-voice', {
        voice_name: name,
        voice_description: body.voice_description,
        generated_voice_id: generated,
        labels,
      });

      const targets = b.everywhere ? keys.map((_, i) => i) : [idx];
      const pick = Math.max(0, Math.min(2, parseInt(b.index, 10) || 0));

      const results = await Promise.all(targets.map(async (i) => {
        try {
          let generated = b.generatedVoiceId;
          if (i !== idx) {
            // в другом аккаунте тот же голос получаем повтором с тем же seed
            if (body.seed == null) throw new Error('нет seed — голос нельзя повторить');
            const d = await el(keys[i], DESIGN_PATH, Object.assign({}, body, { stream_previews: true }));
            const p = (d.previews || [])[pick];
            if (!p) throw new Error('вариант не повторился');
            generated = p.generated_voice_id;
          }
          const v = await create(keys[i], generated);
          return { keyIndex: i, ok: true, id: v.voice_id };
        } catch (e) {
          return { keyIndex: i, ok: false, error: e.message };
        }
      }));

      const ids = {};
      results.forEach((r) => { if (r.ok) ids[r.keyIndex] = r.id; });
      const ok = Object.keys(ids).length > 0;
      return res.status(ok ? 200 : 502).json({ ok, results, ids, error: ok ? undefined : results[0].error });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(e.status === 401 ? 502 : (e.status || 502)).json({ error: e.message });
  }
}
