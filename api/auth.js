import { checkPassword, makeToken, delay } from './_token.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }
    if (!process.env.EDITOR_PASSWORD) {
        return res.status(500).json({ ok: false, error: 'EDITOR_PASSWORD не задан в Vercel' });
    }
    const { password } = req.body || {};
    if (!checkPassword(password)) {
        await delay(800); // тормозим перебор паролей
        return res.status(401).json({ ok: false, error: 'Неверный пароль' });
    }
    return res.status(200).json({ ok: true, token: makeToken() });
}
