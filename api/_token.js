// Общие помощники авторизации редактора.
// Файл с «_» в начале Vercel не публикует как отдельную функцию.
import crypto from 'crypto';

const TTL_MS = 12 * 60 * 60 * 1000; // токен живёт 12 часов

function sign(exp, secret) {
    return crypto.createHmac('sha256', secret).update('ozvuchka:' + exp).digest('hex');
}

// Сравнение за постоянное время (защита от timing-атак)
export function safeEqual(a, b) {
    const A = Buffer.from(String(a));
    const B = Buffer.from(String(b));
    return A.length === B.length && crypto.timingSafeEqual(A, B);
}

export function checkPassword(pwd) {
    const secret = process.env.EDITOR_PASSWORD;
    return Boolean(secret && pwd && safeEqual(pwd, secret));
}

// Токен = срок.подпись — пароль больше не хранится в браузере.
// Смена EDITOR_PASSWORD автоматически делает старые токены недействительными.
export function makeToken() {
    const exp = Date.now() + TTL_MS;
    return exp + '.' + sign(exp, process.env.EDITOR_PASSWORD);
}

export function checkToken(token) {
    const secret = process.env.EDITOR_PASSWORD;
    if (!secret || typeof token !== 'string') return false;
    const [exp, sig] = token.split('.');
    if (!exp || !sig || !(Number(exp) > Date.now())) return false;
    return safeEqual(sig, sign(exp, secret));
}

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
