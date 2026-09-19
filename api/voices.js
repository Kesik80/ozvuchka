// api/voices.js — голоса ElevenLabs: список своих и поиск по общей библиотеке.
//
// GET  ?action=mine&keyIndex=0|all    → { voices: [{ id, name, category, labels, langs, preview, accounts }], errors }
// GET  ?action=library&search=&gender=&language=de&page=0
//                                     → { voices: [{ id, ownerId, name, accent, useCase, gender, language, preview, added }], hasMore }
// POST { token, action:'add', voiceId, ownerId, name }
//                                     → добавляет голос ВО ВСЕ аккаунты (иначе при переходе
//                                       на другой аккаунт голоса там не окажется)
//
// Авторизация: Bearer-токен (GET) или token в теле (POST) — тот же, что у редактора.
import { checkToken } from './_token.js';
import { getKeys } from './_eleven.js';

export const config = { maxDuration: 30 };

async function el(key, path, init) {
  const r = await fetch('https://api.elevenlabs.io' + path, {
    ...init,
    headers: Object.assign({ 'xi-api-key': key }, (init && init.headers) || {}),
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = 'ElevenLabs ' + r.status;
    try {
      const d = JSON.parse(text).detail;
      if (d && d.message) msg = d.message;
    } catch (_) {}
    const e = new Error(msg);
    e.status = r.status;
    throw e;
  }
  return JSON.parse(text || '{}');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const body = req.body || {};
  if (!checkToken(bearer) && !checkToken(body.token)) {
    return res.status(401).json({ error: 'unauthorized', code: 'auth' });
  }

  const keys = getKeys();
  if (!keys.length) return res.status(500).json({ error: 'ELEVENLABS_API_KEY не задан в Vercel' });

  const q = req.query || {};
  const action = req.method === 'POST' ? body.action : q.action;

  try {
    // ── свои голоса: одного аккаунта (keyIndex=N) или всех сразу (keyIndex=all) ──
    // Голоса у каждого аккаунта свои: немецкие из библиотеки могут быть добавлены
    // только в часть аккаунтов. В режиме all список сливается, у голоса — номера аккаунтов.
    if (action === 'mine') {
      const all = q.keyIndex === 'all';
      const idxs = all ? keys.map((_, i) => i) : [Math.min(keys.length - 1, Math.max(0, parseInt(q.keyIndex, 10) || 0))];
      const byId = new Map();
      const errors = [];
      await Promise.all(idxs.map(async (i) => {
        try {
          const d = await el(keys[i], '/v1/voices');
          (d.voices || []).forEach((v) => {
            let cur = byId.get(v.voice_id);
            if (!cur) {
              const labels = v.labels || {};
              const langs = new Set();
              if (labels.language) langs.add(String(labels.language).toLowerCase());
              (v.verified_languages || []).forEach((l) => l && l.language && langs.add(String(l.language).toLowerCase()));
              if (v.fine_tuning && v.fine_tuning.language) langs.add(String(v.fine_tuning.language).toLowerCase());
              cur = {
                id: v.voice_id,
                name: v.name,
                category: v.category || 'premade',   // premade | cloned | professional | generated
                labels,
                description: v.description || '',
                langs: [...langs],
                preview: v.preview_url || '',
                accounts: [],
              };
              byId.set(v.voice_id, cur);
            }
            cur.accounts.push(i);
          });
        } catch (e) {
          errors.push({ index: i, error: e.message });
        }
      }));
      if (!byId.size && errors.length) throw new Error(errors[0].error);
      const voices = [...byId.values()];
      voices.forEach((v) => v.accounts.sort((a, b) => a - b));
      return res.json({ voices, errors, keyIndex: all ? 'all' : idxs[0] });
    }

    // ── поиск по общей библиотеке ──
    if (action === 'library') {
      const p = new URLSearchParams({ page_size: '24' });
      if (q.search) p.set('search', String(q.search).slice(0, 60));
      if (q.gender) p.set('gender', String(q.gender));
      if (q.language) p.set('language', String(q.language));
      if (q.page) p.set('page', String(parseInt(q.page, 10) || 0));
      const d = await el(keys[Math.min(keys.length - 1, Math.max(0, parseInt(q.keyIndex, 10) || 0))], '/v1/shared-voices?' + p.toString());
      const voices = (d.voices || []).map((v) => ({
        id: v.voice_id,
        ownerId: v.public_owner_id,
        name: v.name,
        accent: v.accent || '',
        useCase: v.use_case || '',
        gender: v.gender || '',
        language: v.language || '',
        descriptive: v.descriptive || '',
        preview: v.preview_url || '',
        added: !!v.is_added_by_user,
      }));
      return res.json({ voices, hasMore: !!d.has_more });
    }

    // ── добавить голос из библиотеки во все аккаунты ──
    if (action === 'add' && req.method === 'POST') {
      const { voiceId, ownerId, name } = body;
      if (!voiceId || !ownerId) return res.status(400).json({ error: 'voiceId и ownerId обязательны' });
      const newName = String(name || 'Voice').slice(0, 40);

      const results = await Promise.all(keys.map(async (key, i) => {
        try {
          const d = await el(key, `/v1/voices/add/${encodeURIComponent(ownerId)}/${encodeURIComponent(voiceId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ new_name: newName }),
          });
          return { keyIndex: i, ok: true, id: d.voice_id };
        } catch (e) {
          // 400 c «already» — голос уже добавлен, это не ошибка
          const already = /already/i.test(e.message);
          return { keyIndex: i, ok: already, already, error: already ? null : e.message };
        }
      }));
      const ok = results.filter((r) => r.ok).length;
      return res.json({ ok: ok > 0, added: ok, total: keys.length, results });
    }

    return res.status(400).json({ error: 'action: mine | library | add' });

  } catch (e) {
    return res.status(502).json({ error: e.message, status: e.status || 0 });
  }
}
