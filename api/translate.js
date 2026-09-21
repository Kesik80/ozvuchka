// api/translate.js — перевод реплик через Gemini (тот же ключ, что у tlumach).
//
// POST { token, lines: [строки], from: 'de'|'auto', to: 'ru'|'uk', title? }
//   → 200 { tr: [переводы в том же порядке], model }
//   → 4xx/5xx { error, code? }
//
// Реплики переводятся пачкой и как один диалог: так местоимения, «ты/вы»
// и шутки переводятся связно, а не каждая строка сама по себе.
//
// Env: GEMINI_API_KEY (обязательно), MODEL_TEXT (необязательно), EDITOR_PASSWORD
import { checkToken, delay } from './_token.js';

export const config = { maxDuration: 30 };

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = process.env.MODEL_TEXT || 'gemini-3.5-flash-lite';
const LANG = { de: 'German', ru: 'Russian', uk: 'Ukrainian', en: 'English' };
const MAX_LINES = 60;
const MAX_CHARS = 8000;

function prompt(from, to, title) {
  return [
    `You translate numbered lines of a text or dialogue that a learner uses to study ${from === 'auto' ? 'a foreign language' : LANG[from]}.`,
    `Translate every line ${from === 'auto' ? '' : 'from ' + LANG[from] + ' '}into ${LANG[to]}.`,
    '- Translate by meaning, the way a native speaker would say it. Idioms and set phrases get their natural equivalent, not a word-for-word rendering.',
    '- Keep the register: casual stays casual, polite stays polite. Keep "du" vs "Sie" consistent across the dialogue.',
    '- Keep emojis, names, numbers and punctuation style.',
    '- Square-bracket tags like [laughs] or [whispers] are voice directions: leave them out of the translation.',
    '- The lines belong together; use the neighbouring lines as context, but translate each line on its own row.',
    '- A line that is already in ' + LANG[to] + ' is returned unchanged.',
    title ? '- Title of the text, for context only: ' + String(title).slice(0, 120) : '',
    'Return a JSON array of strings: exactly one translation per input line, same order, same count.'
  ].filter(Boolean).join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const b = req.body || {};
  if (!checkToken(b.token)) {
    await delay(500);
    return res.status(401).json({ error: 'Сессия истекла — войдите снова', code: 'auth' });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY не задан в Vercel (тот же ключ, что у tlumach)', code: 'no_key' });
  }

  const from = b.from === 'auto' || LANG[b.from] ? b.from : 'auto';
  const to = LANG[b.to] ? b.to : 'ru';
  if (from === to) return res.status(400).json({ error: 'Языки совпадают' });

  const lines = Array.isArray(b.lines) ? b.lines.map((s) => String(s || '').replace(/\s+/g, ' ').trim()) : [];
  if (!lines.length || !lines.some(Boolean)) return res.status(400).json({ error: 'Нечего переводить' });
  if (lines.length > MAX_LINES) return res.status(413).json({ error: 'Слишком много реплик за раз' });
  const total = lines.reduce((n, s) => n + s.length, 0);
  if (total > MAX_CHARS) return res.status(413).json({ error: 'Слишком длинный текст за раз' });

  const payload = {
    systemInstruction: { parts: [{ text: prompt(from, to, b.title) }] },
    contents: [{ role: 'user', parts: [{ text: lines.map((s, i) => (i + 1) + '. ' + (s || '—')).join('\n') }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: Math.min(8000, 400 + total * 2),
      thinkingConfig: { thinkingLevel: 'MINIMAL' },
      responseMimeType: 'application/json',
      responseSchema: { type: 'ARRAY', items: { type: 'STRING' } }
    }
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(`${API}/${MODEL}:generateContent`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const raw = (await r.text().catch(() => '')).slice(0, 300);
      console.error('Gemini', r.status, raw);
      if (r.status === 429) return res.status(429).json({ error: 'Дневной лимит Gemini исчерпан — попробуйте завтра' });
      if (r.status === 404) return res.status(502).json({ error: 'Модель ' + MODEL + ' недоступна для этого ключа' });
      return res.status(502).json({ error: 'Gemini ' + r.status });
    }
    const data = await r.json().catch(() => null);
    const cand = data && data.candidates && data.candidates[0];
    const text = ((cand && cand.content && cand.content.parts) || [])
      .filter((p) => p && typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
    let arr = null;
    try { arr = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim()); } catch (e) {}
    if (!Array.isArray(arr)) return res.status(502).json({ error: 'Модель вернула неразбираемый ответ' });
    // ровно столько строк, сколько пришло; пустые реплики — пустой перевод
    const tr = lines.map((s, i) => (s ? String(arr[i] == null ? '' : arr[i]).replace(/^\s*\d+\.\s+/, '').trim() : ''));
    return res.status(200).json({ tr, model: MODEL });
  } catch (e) {
    return res.status(502).json({ error: e.name === 'AbortError' ? 'Gemini не ответил вовремя' : e.message });
  } finally {
    clearTimeout(timer);
  }
}
