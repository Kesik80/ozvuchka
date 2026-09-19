/* app.js — ОЗВУЧКА: редактор диалогов с озвучкой ElevenLabs.
 *
 * Данные живут в браузере (IndexedDB): проекты — текст и роли, звук — отдельными MP3.
 * Сервер (/api/*) нужен только для ElevenLabs: ключи там, в браузер они не попадают.
 *
 * Проект: { id, v, title, created, updated,
 *           settings: { gap, repeat, format, hideTags, tapMode, showTr },
 *           roles:  [{ id, name, color, narrator, voiceId, voiceName, preview, model,
 *                      stability, similarity, style, speed, mood }],
 *           blocks: [{ id, type:'line'|'heading', roleId, html, tr, mood,
 *                      audio: { key, sig, dur, src:'tts'|'file' } }] }
 */
(function () {
  'use strict';

  var T = window.OzText;
  var $ = function (id) { return document.getElementById(id); };
  var esc = T.esc;

  // ── константы ──────────────────────────────────────────
  var COLORS = ['#3d6ef5', '#e0533d', '#1f9e74', '#b0569e', '#d08a00', '#0f8fb3', '#7a5cd6', '#6f8a1c'];
  var MODELS = [
    { id: 'eleven_multilingual_v2', name: 'Multilingual v2', note: 'Естественно и ровно. Слышит соседние реплики — интонация связная.' },
    { id: 'eleven_flash_v2_5', name: 'Flash 2.5', note: 'Быстро и вдвое дешевле по символам. Для черновиков.' },
    { id: 'eleven_v3', name: 'Eleven v3', note: 'Самая живая. Эмоции через [теги], но каждая реплика звучит сама по себе.' }
  ];
  var MOODS = [
    ['[cheerful]', '😊 Весело'], ['[warmly]', '🤗 Тепло'], ['[friendly]', '🙂 Дружелюбно'],
    ['[calm]', '😌 Спокойно'], ['[excited]', '🤩 Восторженно'], ['[curious]', '🤔 С интересом'],
    ['[confident]', '💪 Уверенно'], ['[softly]', '🪶 Мягко'], ['[whispers]', '🤫 Шёпотом'],
    ['[sad]', '😔 Грустно'], ['[surprised]', '😮 Удивлённо'], ['[sarcastic]', '😏 С сарказмом'],
    ['[laughs]', '😂 Со смехом'], ['[sighs]', '😮‍💨 Со вздохом']
  ];
  var MOOD_LABEL = {};
  MOODS.forEach(function (m) { MOOD_LABEL[m[0]] = m[1]; });
  var PRESETS = {
    flat: { label: 'Ровно', stability: 0.8, similarity: 0.8, style: 0, speed: 0.92 },
    live: { label: 'Живо', stability: 0.45, similarity: 0.75, style: 0.15, speed: 1 },
    warm: { label: 'Тепло', stability: 0.35, similarity: 0.75, style: 0.35, speed: 0.95 }
  };
  var ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18.5" cy="12" r="1.8"/></svg>',
    mic: '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z"/></svg>',
    doc: '<svg viewBox="0 0 24 24"><path d="M6 3h8l5 5v13H6V3zm7 1.5V9h4.5L13 4.5zM8.5 12v1.5h8V12h-8zm0 3.5V17h8v-1.5h-8z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zM6 8h12l-1 13H7L6 8z"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><path d="M8 7V3h12v14h-4v4H4V7h4zm2 0h6v8h2V5h-8v2zM6 9v10h8V9H6z"/></svg>'
  };

  // ── состояние ──────────────────────────────────────────
  var S = {
    proj: null,
    projects: [],          // [{ id, title, updated, lines }]
    mode: 'edit',
    token: '',
    quota: null,
    voices: null,          // свои голоса аккаунта
    busy: {},              // id реплики → идёт озвучка
    errors: {},            // id → текст ошибки
    gen: { running: false, stop: false, done: 0, total: 0 },
    urls: {},              // ключ звука → blob:URL
    focusId: null,
    undo: null
  };

  var prefs = lsGet('ozv.prefs', { theme: 'auto', lastId: '', tr: true });
  function savePrefs() { lsSet('ozv.prefs', prefs); }

  function lsGet(k, d) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function uid() { return Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 7); }
  function hash(s) {                                    // FNV-1a, 32 бита
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }
  function nf(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f'); }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }
  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many);
  }
  function h(tag, attrs, html) {
    var e = document.createElement(tag);
    for (var k in (attrs || {})) {
      if (k === 'class') e.className = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    }
    if (html != null) e.innerHTML = html;
    return e;
  }

  // ── IndexedDB ──────────────────────────────────────────
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var r = indexedDB.open('ozvuchka', 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio');
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function tx(store, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(store, mode), s = t.objectStore(store), out;
        var req = fn(s);
        if (req) req.onsuccess = function () { out = req.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = t.onabort = function () { rej(t.error); };
      });
    });
  }
  var idb = {
    get: function (st, k) { return tx(st, 'readonly', function (s) { return s.get(k); }); },
    put: function (st, v, k) { return tx(st, 'readwrite', function (s) { return k == null ? s.put(v) : s.put(v, k); }); },
    del: function (st, k) { return tx(st, 'readwrite', function (s) { return s.delete(k); }); },
    all: function (st) { return tx(st, 'readonly', function (s) { return s.getAll(); }); }
  };

  // ── модель ─────────────────────────────────────────────
  function newRole(name, i, extra) {
    return Object.assign({
      id: uid(), name: name, color: COLORS[i % COLORS.length], narrator: false,
      voiceId: '', voiceName: '', preview: '', model: 'eleven_multilingual_v2',
      stability: 0.45, similarity: 0.75, style: 0.15, speed: 1, mood: ''
    }, extra || {});
  }
  function newProject(title) {
    return {
      id: uid(), v: 1, title: title || 'Без названия', created: Date.now(), updated: Date.now(),
      settings: { gap: 450, repeat: 0, format: 'mp3_44100_64', hideTags: true, tapMode: 'one', showTr: true },
      roles: [newRole('Рассказчик', 6, { narrator: true })],
      blocks: []
    };
  }
  function line(roleId, text, tr, mood) {
    return { id: uid(), type: 'line', roleId: roleId, html: esc(text), tr: tr || '', mood: mood || '' };
  }
  function demoProject() {
    var p = newProject('Im Café');
    // Стандартные голоса ElevenLabs — есть в каждом аккаунте
    var nar = p.roles[0];
    Object.assign(nar, { name: 'Erzähler', voiceId: 'JBFqnCBsd6RMkjVDRZzb', voiceName: 'George' });
    var anna = newRole('Anna', 0, { voiceId: 'EXAVITQu4vr4xnSDxMaL', voiceName: 'Sarah' });
    var kel = newRole('Kellner', 1, { voiceId: 'CwhRBWXzGAHq8TQ4Fs17', voiceName: 'Roger' });
    p.roles.push(anna, kel);
    p.blocks = [
      line(nar.id, 'Samstagmorgen. Anna betritt ein kleines Café in der Altstadt.', 'Субботнее утро. Анна заходит в маленькое кафе в старом городе.'),
      line(kel.id, 'Guten Morgen! Was darf es sein?', 'Доброе утро! Что желаете?'),
      line(anna.id, 'Einen Cappuccino, bitte. Und ein Croissant.', 'Капучино, пожалуйста. И круассан.'),
      line(kel.id, 'Gern. Zum Mitnehmen oder zum Hiertrinken?', 'С удовольствием. С собой или здесь?'),
      line(anna.id, 'Zum Hiertrinken. Heute habe ich Zeit.', 'Здесь. Сегодня у меня есть время.'),
      line(kel.id, 'Das macht dann sechs Euro vierzig.', 'С вас шесть евро сорок.'),
      line(anna.id, 'Sieben, bitte. Stimmt so!', 'Семь, пожалуйста. Сдачи не надо!')
    ];
    return p;
  }

  function roleById(id) {
    var rs = S.proj.roles;
    for (var i = 0; i < rs.length; i++) if (rs[i].id === id) return rs[i];
    return rs[0];
  }
  function blockById(id) {
    var bs = S.proj.blocks;
    for (var i = 0; i < bs.length; i++) if (bs[i].id === id) return bs[i];
    return null;
  }
  function blockIndex(id) {
    var bs = S.proj.blocks;
    for (var i = 0; i < bs.length; i++) if (bs[i].id === id) return i;
    return -1;
  }
  function isLine(b) { return b && b.type !== 'heading'; }

  // Текст, который уходит в модель: v3 получает тег настроения впереди
  function ttsText(b) {
    var r = roleById(b.roleId), t = T.plain(b.html);
    var mood = b.mood || r.mood;
    if (r.model === 'eleven_v3' && mood && t) t = mood + ' ' + t;
    if (r.model !== 'eleven_v3') t = t.replace(/\[[a-zA-Z][a-zA-Z \-']{0,30}\]\s*/g, '');   // теги понимает только v3
    return t;
  }
  // Подпись озвучки: изменился текст, голос или настройки → звук устарел
  function sig(b) {
    var r = roleById(b.roleId);
    var set = r.model === 'eleven_v3' ? [r.stability] : [r.stability, r.similarity, r.style];
    return hash(JSON.stringify([ttsText(b), r.voiceId, r.model, set, r.speed, S.proj.settings.format]));
  }
  function status(b) {
    if (S.busy[b.id]) return 'busy';
    if (S.errors[b.id]) return 'err';
    if (!b.audio) return T.plain(b.html) ? 'none' : 'empty';
    if (b.audio.src === 'file') return 'file';
    return b.audio.sig === sig(b) ? 'ok' : 'stale';
  }
  var STATUS_TEXT = { none: 'Не озвучено', ok: 'Озвучено', stale: 'Текст или голос изменились — озвучить заново', err: 'Ошибка', busy: 'Озвучиваю…', file: 'Свой звук', empty: 'Пустая реплика' };

  function needsWork() {
    var list = [], chars = 0, noVoice = {};
    S.proj.blocks.forEach(function (b) {
      if (!isLine(b)) return;
      var st = status(b);
      if (st !== 'none' && st !== 'stale' && st !== 'err') return;
      var r = roleById(b.roleId);
      if (!r.voiceId) { noVoice[r.id] = r; return; }
      list.push(b);
      chars += ttsText(b).length;
    });
    return { list: list, chars: chars, noVoice: Object.keys(noVoice).map(function (k) { return noVoice[k]; }) };
  }

  // ── сохранение ─────────────────────────────────────────
  var saveSoon = debounce(saveNow, 450);
  function saveNow() {
    if (!S.proj) return Promise.resolve();
    S.proj.updated = Date.now();
    var meta = S.projects.filter(function (p) { return p.id === S.proj.id; })[0];
    if (meta) { meta.title = S.proj.title; meta.updated = S.proj.updated; meta.lines = countLines(S.proj); }
    return idb.put('projects', S.proj).catch(function (e) { toast('Не сохранилось: ' + e.message, { err: true }); });
  }
  var paintGenSoon = debounce(function () { paintGen(); paintQuota(); }, 300);
  function touch() { saveSoon(); paintGenSoon(); }
  function countLines(p) { return p.blocks.filter(isLine).length; }

  // ── звук ───────────────────────────────────────────────
  function audioUrl(key) {
    if (S.urls[key]) return Promise.resolve(S.urls[key]);
    return idb.get('audio', key).then(function (blob) {
      if (!blob) return null;
      S.urls[key] = URL.createObjectURL(blob);
      return S.urls[key];
    });
  }
  function dropAudio(key) {
    if (!key) return;
    if (S.urls[key]) { URL.revokeObjectURL(S.urls[key]); delete S.urls[key]; }
    idb.del('audio', key).catch(function () {});
  }
  function blobDuration(blob) {
    return new Promise(function (res) {
      var a = new Audio(), u = URL.createObjectURL(blob), done = false;
      var fin = function (d) { if (done) return; done = true; URL.revokeObjectURL(u); res(isFinite(d) && d > 0 ? d : 0); };
      a.preload = 'metadata';
      a.onloadedmetadata = function () { fin(a.duration); };
      a.onerror = function () { fin(0); };
      setTimeout(function () { fin(0); }, 6000);
      a.src = u;
    });
  }
  function setAudio(b, blob, src, signature) {
    var old = b.audio && b.audio.key;
    var key = b.id + ':' + uid();
    return idb.put('audio', blob, key).then(function () { return blobDuration(blob); }).then(function (dur) {
      b.audio = { key: key, sig: signature, dur: dur, src: src };
      if (old) dropAudio(old);
      saveSoon();
    });
  }

  // ── плеер ──────────────────────────────────────────────
  var player = new window.OzPlayer({
    items: function () {
      return S.proj.blocks.filter(function (b) { return isLine(b) && b.audio; }).map(function (b) {
        var r = roleById(b.roleId);
        return { id: b.id, dur: b.audio.dur, name: r.narrator ? '' : r.name, color: r.color, text: T.plain(T.hideTags(b.html)) };
      });
    },
    src: function (id) { var b = blockById(id); return b && b.audio ? audioUrl(b.audio.key) : null; },
    el: function (id) { return document.querySelector('#doc [data-id="' + id + '"]'); },
    gap: function (it) { return window.OzGap(S.proj.settings, it && it.dur); },
    title: function () { return S.proj.title; },
    onChange: function () { if (bar) bar.paint(); paintPlayButtons(); },
    onTick: function () { if (bar) bar.tick(); },
    onDuration: function (id, d) { var b = blockById(id); if (b && b.audio) { b.audio.dur = d; saveSoon(); } },
    onError: function () { toast('Звук этой реплики не открылся — озвучьте её заново', { err: true }); }
  });
  var bar = window.OzBar(document.body, player, {
    translation: true,
    idle: 'Нажмите ▶ у реплики или внизу',
    empty: 'Озвученных реплик пока нет',
    onTr: function (on) { prefs.tr = on; savePrefs(); }
  });

  function paintPlayButtons() {
    var cur = player.current();
    document.querySelectorAll('#doc .ed-play').forEach(function (btn) {
      var on = cur && player.playing && btn.closest('[data-id]').dataset.id === cur.id;
      btn.innerHTML = on ? ICON.pause : ICON.play;
    });
  }

  // ── отрисовка ──────────────────────────────────────────
  function renderAll() {
    $('title').value = S.proj.title;
    document.title = S.proj.title + ' — ОЗВУЧКА';
    renderCast();
    renderDoc();
    renderProjects($('sideList'));
    paintGen();
    paintQuota();
    player.refresh();
  }

  function renderCast() {
    var counts = {};
    S.proj.blocks.forEach(function (b) { if (isLine(b)) counts[b.roleId] = (counts[b.roleId] || 0) + 1; });
    var el = $('cast');
    el.innerHTML = '';
    S.proj.roles.forEach(function (r) {
      el.appendChild(h('button', { class: 'chip', type: 'button', style: '--c:' + r.color, onclick: function () { openRole(r.id); } },
        '<span class="dot"></span><span><b>' + esc(r.name) + '</b>' +
        (r.voiceId ? '<small>' + esc(r.voiceName || 'голос') + ' · ' + (counts[r.id] || 0) + '</small>' : '<small class="need">выбрать голос</small>') +
        '</span>'));
    });
    el.appendChild(h('button', { class: 'chip add', type: 'button', onclick: addRole }, '+ Роль'));
    var spare = unusedRoles();
    if (spare.length) {
      el.appendChild(h('button', { class: 'chip add', type: 'button', title: spare.map(function (r) { return r.name; }).join(', '), onclick: function () {
        var n = removeUnusedRoles();
        toast('Убрано: ' + n + ' ' + plural(n, 'роль', 'роли', 'ролей'), {
          action: 'Вернуть', onAction: function () { S.proj.roles = S.proj.roles.concat(spare); renderAll(); touch(); }
        });
      } }, 'Убрать лишние (' + spare.length + ')'));
    }
  }

  // роли без реплик; одну всегда оставляем
  function unusedRoles() {
    var used = {};
    S.proj.blocks.forEach(function (b) { if (isLine(b)) used[b.roleId] = 1; });
    var spare = S.proj.roles.filter(function (r) { return !used[r.id]; });
    if (spare.length === S.proj.roles.length) spare = spare.slice(1);
    return spare;
  }
  function removeUnusedRoles() {
    var spare = unusedRoles(), ids = {};
    spare.forEach(function (r) { ids[r.id] = 1; });
    S.proj.roles = S.proj.roles.filter(function (r) { return !ids[r.id]; });
    renderAll(); touch();
    return spare.length;
  }
  function deleteRole(r) {
    if (S.proj.roles.length < 2) { toast('Последнюю роль удалить нельзя'); return false; }
    var used = S.proj.blocks.filter(function (b) { return b.roleId === r.id; }).length;
    var rest = S.proj.roles.filter(function (x) { return x.id !== r.id; });
    if (used && !confirm('У роли «' + r.name + '» ' + used + ' ' + plural(used, 'реплика', 'реплики', 'реплик') + '. Они перейдут к «' + rest[0].name + '». Удалить роль?')) return false;
    S.proj.roles = rest;
    S.proj.blocks.forEach(function (b) { if (b.roleId === r.id) b.roleId = rest[0].id; });
    renderAll(); touch();
    return true;
  }

  function renderDoc() {
    var doc = $('doc');
    if (S.mode === 'read') {
      window.OzRender.doc(doc, S.proj, function (b) { return !!b.audio; });
      if (!S.proj.blocks.length) doc.querySelector('.oz-sheet').insertAdjacentHTML('beforeend', '<div class="empty"><p>Текста пока нет.</p></div>');
      return;
    }
    var sheet = h('article', { class: 'oz-sheet' });
    var prev = null;
    S.proj.blocks.forEach(function (b) {
      sheet.appendChild(b.type === 'heading' ? headingEl(b) : lineEl(b, prev));
      prev = b.type === 'heading' ? null : b.roleId;
    });
    if (!S.proj.blocks.length) {
      sheet.appendChild(h('div', { class: 'empty' },
        '<p>Начните писать или вставьте готовый диалог.<br>Строки вида <b>Anna: Hallo!</b> сами разойдутся по ролям.</p>' +
        '<div class="row" style="justify-content:center"><button class="btn primary" type="button" data-act="first">Написать реплику</button>' +
        '<button class="btn" type="button" data-act="import">Вставить текст</button></div>'));
    }
    doc.innerHTML = '';
    doc.appendChild(sheet);
    paintPlayButtons();
  }

  function lineEl(b, prevRole) {
    var r = roleById(b.roleId), st = status(b);
    var mood = b.mood || (r.model === 'eleven_v3' ? r.mood : '');
    var el = h('div', { class: 'oz-line ed' + (r.narrator ? ' is-narrator' : ''), 'data-id': b.id, style: '--c:' + r.color });
    el.innerHTML =
      '<div class="ed-head">' +
        '<button class="ed-who" type="button" data-act="menu" title="Роль и действия">' + esc(r.name) + '</button>' +
        (mood && r.model === 'eleven_v3' ? '<span class="ed-mood">' + esc(MOOD_LABEL[mood] || mood) + '</span>' : '') +
        '<span class="st ' + st + '" title="' + esc(S.errors[b.id] || STATUS_TEXT[st]) + '"></span>' +
        '<span class="ed-acts">' +
          (st === 'none' || st === 'stale' || st === 'err' ? '<button type="button" class="mic" data-act="speak" title="Озвучить">' + ICON.mic + '</button>' : '') +
          (b.audio ? '<button type="button" class="ed-play" data-act="play" title="Слушать">' + ICON.play + '</button>' : '') +
          '<button type="button" data-act="menu" title="Ещё">' + ICON.more + '</button>' +
        '</span>' +
      '</div>' +
      '<div class="oz-text ed-text" contenteditable="true" spellcheck="true" data-ph="' + (prevRole == null ? 'Текст реплики…' : '…') + '">' + b.html + '</div>' +
      '<div class="ed-tr" contenteditable="true" spellcheck="true" data-ph="перевод — необязательно" aria-label="Перевод">' + esc(b.tr || '') + '</div>';
    return el;
  }

  function headingEl(b) {
    return h('div', { class: 'ed-h', 'data-id': b.id },
      '<div class="oz-h ed-text" contenteditable="true" spellcheck="true" data-ph="Заголовок">' + b.html + '</div>' +
      '<span class="ed-acts"><button type="button" data-act="menu" title="Ещё">' + ICON.more + '</button></span>');
  }

  // точечное обновление одной реплики (без перерисовки листа — курсор не прыгает)
  function repaintHead(b) {
    var el = document.querySelector('#doc [data-id="' + b.id + '"]');
    if (!el || S.mode !== 'edit' || b.type === 'heading') return;
    var fresh = lineEl(b, null);
    var head = el.querySelector('.ed-head');
    head.replaceWith(fresh.querySelector('.ed-head'));
    el.style.setProperty('--c', roleById(b.roleId).color);
    el.classList.toggle('is-narrator', !!roleById(b.roleId).narrator);
    paintPlayButtons();
  }

  // ── кнопка «Озвучить» ──────────────────────────────────
  function paintGen() {
    var g = $('gen');
    if (!S.proj) return;
    if (S.gen.running) {
      g.hidden = false;
      g.className = 'gen running';
      g.innerHTML = '<span class="lamp"></span>Озвучиваю ' + (S.gen.done + 1 > S.gen.total ? S.gen.total : S.gen.done + 1) + ' из ' + S.gen.total + ' <small>· стоп</small>';
      return;
    }
    var w = needsWork();
    if (w.list.length) {
      g.hidden = false;
      g.className = 'gen';
      g.innerHTML = '<span class="lamp"></span>Озвучить ' + w.list.length + ' ' + plural(w.list.length, 'реплику', 'реплики', 'реплик') +
        ' <small>· ' + nf(w.chars) + ' симв.</small>';
    } else if (w.noVoice.length) {
      g.hidden = false;
      g.className = 'gen warn';
      g.innerHTML = '<span class="lamp"></span>Выберите голос: ' + esc(w.noVoice.map(function (r) { return r.name; }).join(', '));
    } else g.hidden = true;
  }
  $('gen').addEventListener('click', function () {
    if (S.gen.running) { S.gen.stop = true; toast('Останавливаю после текущих реплик'); return; }
    var w = needsWork();
    if (!w.list.length && w.noVoice.length) { openRole(w.noVoice[0].id); return; }
    generate(w.list.map(function (b) { return b.id; }));
  });

  // ── озвучка ────────────────────────────────────────────
  function neighbours(b) {
    var bs = S.proj.blocks, i = blockIndex(b.id), p = '', n = '';
    for (var a = i - 1; a >= 0 && !p; a--) if (isLine(bs[a])) p = T.plain(bs[a].html);
    for (var z = i + 1; z < bs.length && !n; z++) if (isLine(bs[z])) n = T.plain(bs[z].html);
    return { prev: p, next: n };
  }

  function generate(ids) {
    if (!ids.length) return;
    if (!S.token) { openLogin(function () { generate(ids); }); return; }
    if (S.gen.running) return;
    var queue = ids.slice();
    S.gen = { running: true, stop: false, done: 0, total: ids.length };
    paintGen();
    var fails = 0, authLost = false;

    function worker() {
      if (S.gen.stop || authLost || !queue.length) return Promise.resolve();
      var id = queue.shift();
      var b = blockById(id);
      if (!b) return worker();
      return speakOne(b).catch(function (e) {
        fails++;
        if (e.code === 'auth') authLost = true;
        if (e.code === 'credits') S.gen.stop = true;
      }).then(function () { S.gen.done++; paintGen(); return worker(); });
    }
    // две реплики одновременно — столько разрешает бесплатный план ElevenLabs
    Promise.all([worker(), worker()]).then(function () {
      S.gen.running = false;
      paintGen();
      player.refresh();
      loadQuota();
      if (authLost) { S.token = ''; lsSet('ozv.token', ''); openLogin(function () { generate(queue.concat(ids.filter(function (i) { return S.errors[i]; }))); }); }
      else if (fails) toast('Не удалось озвучить: ' + fails + ' — наведите на красную точку, там причина', { err: true });
      else if (!S.gen.stop) toast('Готово: ' + ids.length + ' ' + plural(ids.length, 'реплика', 'реплики', 'реплик'));
    });
  }

  // аккаунт для озвучки: тот, где этот голос есть и символов больше всего
  function keyFor(r) {
    var best = S.quota ? S.quota.best : 0;
    var accs = r.voiceAccounts;
    if (!accs || !accs.length) return best;
    if (accs.indexOf(best) >= 0) return best;
    var left = {};
    ((S.quota && S.quota.accounts) || []).forEach(function (a) { left[a.index] = a.error ? -1 : a.left; });
    return accs.slice().sort(function (a, b) { return (left[b] || 0) - (left[a] || 0); })[0];
  }

  function speakOne(b) {
    var r = roleById(b.roleId);
    var text = ttsText(b);
    if (!text) return Promise.resolve();
    if (!r.voiceId) { S.errors[b.id] = 'У роли «' + r.name + '» не выбран голос'; repaintHead(b); return Promise.reject(new Error('no voice')); }
    var signature = sig(b), nb = neighbours(b);
    S.busy[b.id] = true; delete S.errors[b.id];
    repaintHead(b);
    return fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: S.token, text: text, voiceId: r.voiceId, voiceMap: r.voiceMap || null, modelId: r.model,
        voiceSettings: { stability: r.stability, similarity_boost: r.similarity, style: r.style, speed: r.speed, use_speaker_boost: true },
        previousText: nb.prev, nextText: nb.next,
        keyIndex: keyFor(r),
        format: S.proj.settings.format
      })
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (d) {
          var e = new Error(d.error || ('Ошибка ' + res.status));
          e.code = d.code || (res.status === 401 ? 'auth' : '');
          throw e;
        });
      }
      return res.blob().then(function (blob) { return setAudio(b, blob, 'tts', signature); });
    }).then(function () {
      delete S.busy[b.id];
      repaintHead(b);
    }, function (e) {
      delete S.busy[b.id];
      S.errors[b.id] = e.message === 'Failed to fetch' ? 'Нет связи с сервером' : e.message;
      repaintHead(b);
      throw e;
    });
  }

  // ── редактор: ввод ─────────────────────────────────────
  var doc = $('doc');

  doc.addEventListener('input', function (e) {
    var wrap = e.target.closest('[data-id]');
    if (!wrap) return;
    var b = blockById(wrap.dataset.id);
    if (!b) return;
    if (e.target.classList.contains('ed-tr')) { b.tr = e.target.textContent.replace(/\s+/g, ' ').trim(); saveSoon(); return; }
    if (e.target.classList.contains('ed-text')) {
      b.html = b.type === 'heading' ? esc(e.target.textContent) : T.sanitize(e.target.innerHTML);
      if (S.errors[b.id]) delete S.errors[b.id];
      repaintHeadSoon(b);
      touch();
    }
  });
  var repaintHeadSoon = (function () {
    var pend = {}, t = null;
    return function (b) {
      pend[b.id] = b;
      clearTimeout(t);
      t = setTimeout(function () { for (var k in pend) repaintHead(pend[k]); pend = {}; }, 350);
    };
  })();

  doc.addEventListener('focusin', function (e) {
    var wrap = e.target.closest('[data-id]');
    if (wrap) S.focusId = wrap.dataset.id;
  });

  doc.addEventListener('click', function (e) {
    var act = e.target.closest('[data-act]');
    if (S.mode === 'read') {
      var ln = e.target.closest('.oz-line');
      if (ln && !ln.classList.contains('no-audio')) player.playId(ln.dataset.id, S.proj.settings.tapMode !== 'from');
      return;
    }
    if (!act) return;
    var wrap = act.closest('[data-id]');
    var b = wrap && blockById(wrap.dataset.id);
    switch (act.dataset.act) {
      case 'play': if (b) player.playId(b.id, true); break;
      case 'speak': if (b) generate([b.id]); break;
      case 'menu': if (b) openBlockMenu(b); break;
      case 'first': addBlock('line'); break;
      case 'import': openImport(); break;
    }
  });

  doc.addEventListener('keydown', function (e) {
    if (S.mode === 'read') {
      if (e.key === 'Enter' && e.target.classList.contains('oz-line')) player.playId(e.target.dataset.id, S.proj.settings.tapMode !== 'from');
      return;
    }
    var ed = e.target.closest('.ed-text');
    if (e.target.classList.contains('ed-tr') && e.key === 'Enter') {
      e.preventDefault();
      var nx = e.target.closest('[data-id]').nextElementSibling;
      if (nx) focusBlock(nx.dataset.id, 0); else addBlock('line');
      return;
    }
    if (!ed) return;
    var wrap = ed.closest('[data-id]'), b = blockById(wrap.dataset.id);
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      splitBlock(b, ed);
    } else if (e.key === 'Backspace' && caretOffset(ed) === 0 && window.getSelection().isCollapsed) {
      var i = blockIndex(b.id), prev = S.proj.blocks[i - 1];
      if (!prev) return;
      e.preventDefault();
      mergeInto(prev, b);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') {
      e.preventDefault(); fmt('mark');
    }
  });

  // Вставка: многострочный текст → отдельные реплики, иначе — простой текст без чужого оформления
  doc.addEventListener('paste', function (e) {
    if (e.target.closest && e.target.closest('.ed-tr')) {
      e.preventDefault();
      document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\s+/g, ' '));
      return;
    }
    var ed = e.target.closest('.ed-text');
    if (!ed) return;
    var cd = e.clipboardData;
    var text = cd && cd.getData('text/plain');
    if (text == null) return;
    e.preventDefault();
    var lines = text.replace(/\r\n?/g, '\n').split('\n').filter(function (s) { return s.trim(); });
    if (lines.length > 1) {
      var b = blockById(ed.closest('[data-id]').dataset.id);
      var blocks = parseText(text, importOpts());
      var i = blockIndex(b.id);
      var replace = !T.plain(b.html);
      S.proj.blocks.splice(replace ? i : i + 1, replace ? 1 : 0, ...blocks);
      renderAll(); saveSoon();
      toast('Вставлено реплик: ' + blocks.length);
    } else if (ed.closest('.ed-h')) {
      document.execCommand('insertText', false, text.replace(/\s+/g, ' '));
    } else {
      document.execCommand('insertText', false, text);
    }
  });

  // позиция курсора в символах от начала поля
  function caretOffset(el) {
    var sel = window.getSelection();
    if (!sel.rangeCount) return -1;
    var r = sel.getRangeAt(0).cloneRange();
    r.selectNodeContents(el);
    r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
    return r.toString().length;
  }
  function placeCaret(el, offset) {
    el.focus();
    var sel = window.getSelection(), r = document.createRange();
    if (offset == null || offset < 0) { r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); return; }
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), n, left = offset;
    while ((n = walker.nextNode())) {
      if (left <= n.nodeValue.length) { r.setStart(n, left); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); return; }
      left -= n.nodeValue.length;
    }
    r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
  }
  function focusBlock(id, offset) {
    var el = document.querySelector('#doc [data-id="' + id + '"] .ed-text');
    if (el) { placeCaret(el, offset); el.scrollIntoView({ block: 'nearest' }); }
  }

  // В диалоге после Enter следующая реплика — у собеседника
  function nextRoleAfter(b) {
    var bs = S.proj.blocks, i = blockIndex(b.id);
    for (var k = i - 1; k >= 0; k--) {
      if (!isLine(bs[k])) break;
      var rk = roleById(bs[k].roleId);
      if (bs[k].roleId !== b.roleId && !rk.narrator) return bs[k].roleId;
    }
    var others = S.proj.roles.filter(function (r) { return r.id !== b.roleId && !r.narrator; });
    if (others.length && (roleById(b.roleId).narrator || others.length === 1)) return others[0].id;
    return b.roleId;
  }

  function splitBlock(b, ed) {
    var sel = window.getSelection();
    if (!sel.rangeCount) return;
    var r = sel.getRangeAt(0);
    r.deleteContents();
    var tail = document.createRange();
    tail.setStart(r.startContainer, r.startOffset);
    tail.setEnd(ed, ed.childNodes.length);
    var frag = tail.extractContents();
    var box = document.createElement('div');
    box.appendChild(frag);
    var trimL = function (x) { return x.replace(/^(\s|&nbsp;|<br>)+/, ''); };
    var trimR = function (x) { return x.replace(/(\s|&nbsp;|<br>)+$/, ''); };
    var tailHtml = trimL(b.type === 'heading' ? esc(box.textContent) : T.sanitize(box.innerHTML));
    b.html = trimR(b.type === 'heading' ? esc(ed.textContent) : T.sanitize(ed.innerHTML));
    var nb = { id: uid(), type: 'line', roleId: b.type === 'heading' ? lastLineRole(b) : nextRoleAfter(b), html: tailHtml, tr: '', mood: '' };
    // перенос в самом начале непустой реплики — вставить пустую перед ней
    S.proj.blocks.splice(blockIndex(b.id) + 1, 0, nb);
    renderDoc();
    focusBlock(nb.id, 0);
    touch();
    renderCast();
  }
  function lastLineRole(b) {
    var bs = S.proj.blocks, i = blockIndex(b.id);
    for (var k = i - 1; k >= 0; k--) if (isLine(bs[k])) return bs[k].roleId;
    var talk = S.proj.roles.filter(function (r) { return !r.narrator; })[0];
    return (talk || S.proj.roles[0]).id;
  }
  function mergeInto(prev, b) {
    var len = T.plain(prev.html).length;
    if (prev.type === 'heading' && !T.plain(b.html)) { removeBlock(b, true); focusBlock(prev.id, -1); return; }
    if (prev.type === 'heading') { focusBlock(prev.id, -1); return; }
    var ph = prev.html.replace(/(\s|&nbsp;)+$/, ''), bh = b.html.replace(/^(\s|&nbsp;)+/, '');
    len = T.plain(ph).length;
    var sep = ph && bh ? ' ' : '';
    prev.html = T.sanitize(ph + sep + bh);
    if (b.tr) prev.tr = (prev.tr ? prev.tr + ' ' : '') + b.tr;
    if (b.audio) dropAudio(b.audio.key);
    S.proj.blocks.splice(blockIndex(b.id), 1);
    renderDoc();
    focusBlock(prev.id, len + sep.length);
    touch();
  }

  function addBlock(type, afterId) {
    var bs = S.proj.blocks;
    var after = afterId || S.focusId;
    var i = after ? blockIndex(after) : -1;
    if (i < 0) i = bs.length - 1;
    var ref = bs[i];
    var roleId;
    if (type === 'line') {
      roleId = ref ? (isLine(ref) ? nextRoleAfter(ref) : lastLineRole(ref)) :
        (S.proj.roles.filter(function (r) { return !r.narrator; })[0] || S.proj.roles[0]).id;
    }
    var nb = { id: uid(), type: type, roleId: roleId || S.proj.roles[0].id, html: '', tr: '', mood: '' };
    bs.splice(i + 1, 0, nb);
    if (S.mode !== 'edit') setMode('edit');
    renderDoc(); renderCast();
    focusBlock(nb.id, 0);
    touch();
    return nb;
  }

  function removeBlock(b, silent) {
    var i = blockIndex(b.id);
    if (i < 0) return;
    if (player.current() && player.current().id === b.id) player.stop();
    S.proj.blocks.splice(i, 1);
    if (!silent) {
      if (S.undo && S.undo.block.audio) dropAudio(S.undo.block.audio.key);
      S.undo = { block: b, index: i };
      toast('Реплика удалена', {
        action: 'Вернуть', onAction: function () {
          S.proj.blocks.splice(Math.min(S.undo.index, S.proj.blocks.length), 0, S.undo.block);
          S.undo = null; renderAll(); saveSoon();
        }
      });
    } else if (b.audio) dropAudio(b.audio.key);
    renderAll();
    saveSoon();
  }

  // ── форматирование ─────────────────────────────────────
  try { document.execCommand('styleWithCSS', false, false); } catch (e) {}
  $('fmt').addEventListener('mousedown', function (e) { if (e.target.closest('button')) e.preventDefault(); });
  $('fmt').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-cmd]');
    if (btn) fmt(btn.dataset.cmd);
  });

  function activeEditor() {
    var sel = window.getSelection();
    var n = sel.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
    var el = n && (n.nodeType === 1 ? n : n.parentElement);
    return el && el.closest ? el.closest('#doc .ed-text') : null;
  }

  function fmt(cmd) {
    if (cmd === 'line' || cmd === 'heading') { addBlock(cmd); return; }
    if (cmd === 'import') { openImport(); return; }
    var ed = activeEditor();
    if (!ed) { toast('Сначала выделите текст в реплике'); return; }
    if (ed.closest('.ed-h')) return;          // заголовок без оформления
    var sel = window.getSelection();
    if (cmd === 'bold' || cmd === 'italic' || cmd === 'underline') document.execCommand(cmd);
    else if (cmd === 'clear') {
      if (sel.isCollapsed) { ed.textContent = ed.textContent; ed.dispatchEvent(new Event('input', { bubbles: true })); }
      else document.execCommand('insertText', false, sel.toString());
    } else if (cmd === 'mark') {
      var node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
      var m = node && node.closest('mark');
      if (m && ed.contains(m)) {                  // уже выделено — снять маркер
        var p = m.parentNode;
        while (m.firstChild) p.insertBefore(m.firstChild, m);
        p.removeChild(m);
        ed.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (!sel.isCollapsed) {
        document.execCommand('insertHTML', false, '<mark>' + esc(sel.toString()) + '</mark>');
      }
    }
  }

  // ── режим ──────────────────────────────────────────────
  function setMode(m) {
    S.mode = m;
    document.body.classList.toggle('mode-edit', m === 'edit');
    document.body.classList.toggle('mode-read', m === 'read');
    document.querySelectorAll('.mode button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.mode === m)); });
    renderDoc();
    player.refresh();
  }
  document.querySelector('.mode').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });

  $('title').addEventListener('input', function () {
    S.proj.title = this.value.trim() || 'Без названия';
    document.title = S.proj.title + ' — ОЗВУЧКА';
    saveSoon();
    renderProjectsSoon();
  });
  var renderProjectsSoon = debounce(function () { renderProjects($('sideList')); }, 500);

  // ── окна ───────────────────────────────────────────────
  function sheet(title, body, o) {
    o = o || {};
    var d = h('dialog', { class: 'sheet' + (o.wide ? ' wide' : '') });
    var head = h('div', { class: 'sh-head' }, '<h2>' + esc(title) + '</h2>');
    (o.tools || []).forEach(function (t) { head.appendChild(t); });
    var x = h('button', { class: 'ib', type: 'button', 'aria-label': 'Закрыть', onclick: function () { d.close(); } }, ICON.close);
    head.appendChild(x);
    var bd = h('div', { class: 'sh-body' });
    if (typeof body === 'string') bd.innerHTML = body; else if (body) bd.appendChild(body);
    d.appendChild(head); d.appendChild(bd);
    document.body.appendChild(d);
    d.addEventListener('close', function () { if (o.onClose) o.onClose(); d.remove(); });
    d.addEventListener('click', function (e) { if (e.target === d) d.close(); });   // тап по фону
    d.showModal();
    return { el: d, body: bd, close: function () { d.close(); } };
  }

  var toastT = null;
  function toast(msg, o) {
    o = o || {};
    var t = $('toast');
    t.className = 'toast' + (o.err ? ' err' : '');
    t.innerHTML = '<span>' + esc(msg) + '</span>';
    if (o.action) {
      var b = h('button', { type: 'button' }, esc(o.action));
      b.onclick = function () { t.hidden = true; o.onAction(); };
      t.appendChild(b);
    }
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.hidden = true; }, o.action ? 6000 : (o.err ? 5000 : 2600));
  }

  // ── меню реплики ───────────────────────────────────────
  function openBlockMenu(b) {
    var box = h('div');
    var s;
    var isL = isLine(b);
    var r = roleById(b.roleId);

    if (isL) {
      box.appendChild(h('h3', null, 'Кто говорит'));
      var roles = h('div', { class: 'chips' });
      S.proj.roles.forEach(function (x) {
        roles.appendChild(h('button', { type: 'button', class: x.id === b.roleId ? 'on' : '', onclick: function () {
          b.roleId = x.id; s.close(); renderAll(); touch();
        } }, '<span class="d" style="background:' + x.color + '"></span>' + esc(x.name)));
      });
      roles.appendChild(h('button', { type: 'button', onclick: function () { s.close(); addRole(function (nr) { b.roleId = nr.id; renderAll(); touch(); }); } }, '+ новая роль'));
      box.appendChild(roles);

      if (r.model === 'eleven_v3') {
        box.appendChild(h('h3', null, 'Настроение этой реплики'));
        var moods = h('div', { class: 'chips' });
        var cur = b.mood || '';
        [['', r.mood ? 'Как у роли' : 'Обычно']].concat(MOODS).forEach(function (m) {
          moods.appendChild(h('button', { type: 'button', class: cur === m[0] ? 'on' : '', onclick: function () {
            b.mood = m[0]; s.close(); repaintHead(b); touch();
          } }, esc(m[1])));
        });
        box.appendChild(moods);
        box.appendChild(h('p', { class: 'note' }, 'Теги можно писать и прямо в тексте: <b>[laughs]</b>, <b>[pause]</b>. Читатель их не увидит.'));
      }

      box.appendChild(h('h3', null, 'Звук'));
      var st = status(b);
      var row = h('div', { class: 'row' });
      if (b.audio) row.appendChild(h('button', { class: 'btn', type: 'button', onclick: function () { s.close(); player.playId(b.id, true); } }, 'Слушать'));
      row.appendChild(h('button', { class: 'btn onair', type: 'button', onclick: function () { s.close(); generate([b.id]); } }, st === 'ok' ? 'Озвучить заново' : 'Озвучить'));
      row.appendChild(h('button', { class: 'btn', type: 'button', onclick: function () { s.close(); pickAudioFor(b); } }, 'Свой файл…'));
      box.appendChild(row);
      if (S.errors[b.id]) box.appendChild(h('p', { class: 'note', style: 'color:var(--onair)' }, esc(S.errors[b.id])));
      else box.appendChild(h('p', { class: 'note' }, esc(STATUS_TEXT[st] || '') + (b.audio && b.audio.dur ? ' · ' + T.fmtTime(b.audio.dur) : '')));
      if (b.audio) box.appendChild(h('button', { class: 'btn ghost danger sm', type: 'button', onclick: function () {
        dropAudio(b.audio.key); b.audio = null; s.close(); renderAll(); touch();
      } }, 'Удалить звук'));
    }

    box.appendChild(h('h3', null, 'Реплика'));
    var list = h('div', { class: 'list' });
    function item(label, fn) { list.appendChild(h('button', { class: 'li', type: 'button', onclick: function () { s.close(); fn(); } }, '<span class="li-t"><b>' + label + '</b></span>')); }
    item('Вставить реплику ниже', function () { addBlock('line', b.id); });
    item(isL ? 'Сделать заголовком' : 'Сделать репликой', function () {
      if (isL) { b.type = 'heading'; b.html = esc(T.plain(b.html)); }
      else { b.type = 'line'; b.roleId = lastLineRole(b); }
      renderAll(); touch();
    });
    var i = blockIndex(b.id);
    if (i > 0) item('Переместить выше', function () { move(b, -1); });
    if (i < S.proj.blocks.length - 1) item('Переместить ниже', function () { move(b, 1); });
    if (isL && T.plain(b.html).length > 80) item('Разбить по предложениям', function () { splitSentences(b); });
    item('<span style="color:var(--onair)">Удалить</span>', function () { removeBlock(b); });
    box.appendChild(list);

    s = sheet(isL ? (r.name + ': «' + T.plain(b.html).slice(0, 28) + (T.plain(b.html).length > 28 ? '…' : '') + '»') : 'Заголовок', box);
  }

  function move(b, d) {
    var bs = S.proj.blocks, i = blockIndex(b.id), j = i + d;
    if (j < 0 || j >= bs.length) return;
    bs.splice(i, 1); bs.splice(j, 0, b);
    renderAll(); touch();
    var el = document.querySelector('#doc [data-id="' + b.id + '"]');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function splitSentences(b) {
    var parts = sentences(T.plain(b.html));
    if (parts.length < 2) { toast('Здесь одно предложение'); return; }
    var i = blockIndex(b.id);
    var nbs = parts.map(function (t, k) { return { id: uid(), type: 'line', roleId: b.roleId, html: esc(t), tr: k === 0 ? b.tr : '', mood: b.mood }; });
    if (b.audio) dropAudio(b.audio.key);
    S.proj.blocks.splice(i, 1, ...nbs);
    renderAll(); touch();
  }

  var fileAudioFor = null;
  function pickAudioFor(b) { fileAudioFor = b; $('fileAudio').value = ''; $('fileAudio').click(); }
  $('fileAudio').addEventListener('change', function () {
    var f = this.files[0], b = fileAudioFor;
    if (!f || !b) return;
    setAudio(b, f, 'file', 'file').then(function () { delete S.errors[b.id]; renderAll(); toast('Звук привязан к реплике'); });
  });

  // ── роли ───────────────────────────────────────────────
  function addRole(cb) {
    var used = S.proj.roles.map(function (r) { return r.color; });
    var free = COLORS.filter(function (c) { return used.indexOf(c) < 0; });
    var n = S.proj.roles.filter(function (r) { return !r.narrator; }).length + 1;
    var r = newRole('Роль ' + n, 0, { color: free[0] || COLORS[S.proj.roles.length % COLORS.length] });
    S.proj.roles.push(r);
    renderCast(); touch();
    openRole(r.id, { isNew: true, onClose: function () {
      // роль создали и закрыли, не выбрав голос и не дав ей реплик — не оставляем мусор
      var inUse = S.proj.blocks.some(function (b) { return b.roleId === r.id; });
      if (!r.voiceId && !inUse && typeof cb !== 'function' && S.proj.roles.indexOf(r) >= 0 && S.proj.roles.length > 1) {
        S.proj.roles = S.proj.roles.filter(function (x) { return x !== r; });
        renderCast(); touch();
        return;
      }
      if (typeof cb === 'function') cb(r);
    } });
  }

  function openRole(id, o) {
    o = o || {};
    var r = roleById(id);
    var box = h('div');
    var s;
    function changed() { renderCast(); renderDoc(); touch(); player.refresh(); }

    box.appendChild(h('h3', null, 'Имя'));
    var name = h('input', { class: 'field', type: 'text', value: r.name, maxlength: 30, autocomplete: 'off' });
    name.addEventListener('input', function () { r.name = name.value.trim() || 'Без имени'; changed(); s.el.querySelector('h2').textContent = r.name; });
    box.appendChild(name);
    if (o.isNew) setTimeout(function () { name.select(); }, 60);

    var nar = h('label', { class: 'chk' }, '<input type="checkbox"' + (r.narrator ? ' checked' : '') + '><span>Рассказчик<small>Имя не показывается, текст курсивом</small></span>');
    nar.querySelector('input').addEventListener('change', function () { r.narrator = this.checked; changed(); });
    box.appendChild(nar);

    box.appendChild(h('h3', null, 'Цвет'));
    var sw = h('div', { class: 'swatches' });
    COLORS.forEach(function (c) {
      sw.appendChild(h('button', { type: 'button', class: c === r.color ? 'on' : '', style: 'background:' + c, 'aria-label': c, onclick: function () {
        r.color = c; sw.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x.style.background === this.style.background); }, this); changed();
      } }));
    });
    box.appendChild(sw);

    box.appendChild(h('h3', null, 'Голос'));
    var vrow = h('div', { class: 'row' });
    var vbtn = h('button', { class: 'btn', type: 'button', style: 'flex:1 1 60%;justify-content:space-between' });
    function paintVoice() { vbtn.innerHTML = '<span>' + (r.voiceId ? esc(r.voiceName || r.voiceId) : '<span style="color:var(--onair)">Выбрать голос</span>') + '</span><span class="muted">›</span>'; }
    paintVoice();
    vbtn.onclick = function () { openVoices(r, function () { paintVoice(); changed(); }); };
    vrow.appendChild(vbtn);
    if (r.preview) vrow.appendChild(h('button', { class: 'btn', type: 'button', onclick: function () { previewPlay(r.preview, this); } }, '▶ Проба'));
    box.appendChild(vrow);

    box.appendChild(h('h3', null, 'Модель'));
    var cards = h('div', { class: 'cards' });
    MODELS.forEach(function (m) {
      cards.appendChild(h('button', { type: 'button', class: 'card' + (r.model === m.id ? ' on' : ''), onclick: function () {
        r.model = m.id; changed(); paintTune();
        cards.querySelectorAll('.card').forEach(function (c, k) { c.classList.toggle('on', MODELS[k].id === m.id); });
      } }, '<b>' + m.name + '</b><small>' + m.note + '</small>'));
    });
    box.appendChild(cards);

    var tune = h('div');
    box.appendChild(tune);
    function slider(label, key, min, max, stepv, fmtv, hint) {
      var w = h('div', { class: 'sl' });
      w.innerHTML = '<label>' + label + '</label><output></output><input type="range" min="' + min + '" max="' + max + '" step="' + stepv + '" value="' + r[key] + '">' + (hint ? '<small>' + hint + '</small>' : '');
      var inp = w.querySelector('input'), out = w.querySelector('output');
      out.textContent = fmtv(r[key]);
      inp.addEventListener('input', function () { r[key] = +inp.value; out.textContent = fmtv(r[key]); });
      inp.addEventListener('change', changed);
      return w;
    }
    function paintTune() {
      tune.innerHTML = '';
      var v3 = r.model === 'eleven_v3';
      tune.appendChild(h('h3', null, 'Интонация'));
      if (v3) {
        var seg = h('div', { class: 'seg' });
        [[0, 'Творчески'], [0.5, 'Естественно'], [1, 'Стабильно']].forEach(function (x) {
          var on = (r.stability < 0.25 ? 0 : r.stability > 0.75 ? 1 : 0.5) === x[0];
          seg.appendChild(h('button', { type: 'button', class: on ? 'on' : '', onclick: function () { r.stability = x[0]; paintTune(); changed(); } }, x[1]));
        });
        tune.appendChild(seg);
        tune.appendChild(h('h3', null, 'Настроение по умолчанию'));
        var ch = h('div', { class: 'chips' });
        [['', 'Нет']].concat(MOODS).forEach(function (m) {
          ch.appendChild(h('button', { type: 'button', class: (r.mood || '') === m[0] ? 'on' : '', onclick: function () { r.mood = m[0]; paintTune(); changed(); } }, esc(m[1])));
        });
        tune.appendChild(ch);
      } else {
        var pr = h('div', { class: 'seg' });
        Object.keys(PRESETS).forEach(function (k) {
          var p = PRESETS[k];
          var on = p.stability === r.stability && p.similarity === r.similarity && p.style === r.style && p.speed === r.speed;
          pr.appendChild(h('button', { type: 'button', class: on ? 'on' : '', onclick: function () {
            r.stability = p.stability; r.similarity = p.similarity; r.style = p.style; r.speed = p.speed; paintTune(); changed();
          } }, p.label));
        });
        tune.appendChild(pr);
        tune.appendChild(slider('Стабильность', 'stability', 0, 1, 0.05, function (v) { return v.toFixed(2); }, 'Меньше — живее и разнообразнее, больше — ровнее'));
        tune.appendChild(slider('Сходство с голосом', 'similarity', 0, 1, 0.05, function (v) { return v.toFixed(2); }));
        tune.appendChild(slider('Выразительность', 'style', 0, 1, 0.05, function (v) { return v.toFixed(2); }, 'Усиливает манеру голоса, но делает речь менее предсказуемой'));
      }
      tune.appendChild(slider('Скорость', 'speed', 0.7, 1.2, 0.01, function (v) { return v.toFixed(2) + '×'; }, 'Для учёбы удобно 0,85–0,9'));
    }
    paintTune();

    if (S.proj.roles.length > 1) {
      box.appendChild(h('div', { class: 'mt' }));
      box.appendChild(h('button', { class: 'btn danger block', type: 'button', onclick: function () { if (deleteRole(r)) s.close(); } }, ICON.trash.replace('<svg', '<svg width="18" height="18" fill="currentColor"') + 'Удалить роль'));
    }

    s = sheet(r.name, box, {
      onClose: function () { stopPreview(); if (o.onClose) o.onClose(); },
      tools: S.proj.roles.length > 1 ? [h('button', { class: 'ib', type: 'button', title: 'Удалить роль', 'aria-label': 'Удалить роль', style: 'color:var(--onair)', onclick: function () { if (deleteRole(r)) s.close(); } }, ICON.trash)] : null
    });
  }

  // ── голоса ─────────────────────────────────────────────
  var pv = new Audio(), pvBtn = null;
  function previewPlay(url, btn) {
    if (pvBtn === btn && !pv.paused) { stopPreview(); return; }
    stopPreview();
    player.toggle(false);
    pv.src = url; pv.play().catch(function () {});
    pvBtn = btn; if (btn) btn.classList.add('on');
    pv.onended = stopPreview;
  }
  function stopPreview() { pv.pause(); if (pvBtn) pvBtn.classList.remove('on'); pvBtn = null; }

  function api(path, o) {
    o = o || {};
    var headers = { Authorization: 'Bearer ' + S.token };
    if (o.body) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: o.method || 'GET', headers: headers, body: o.body ? JSON.stringify(Object.assign({ token: S.token }, o.body)) : undefined, cache: 'no-store' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (r.status === 401) { S.token = ''; lsSet('ozv.token', ''); paintQuota(); var e = new Error('Сессия истекла — войдите снова'); e.code = 'auth'; throw e; }
          if (!r.ok) throw new Error(d.error || ('Ошибка ' + r.status));
          return d;
        });
      });
  }

  function isGermanVoice(v) {
    var l = v.labels || {};
    if ((v.langs || []).indexOf('de') >= 0) return true;
    return /german|deutsch|hochdeutsch|bayer|bavar|österr|austria|schweiz|swiss/i.test([v.name, l.accent, l.language, l.description, l.descriptive, v.description].join(' '));
  }

  // ── создание голоса по описанию (Voice Design) ──────────
  var DESIGN_WHO = { female: ['woman', 'Женщина'], male: ['man', 'Мужчина'] };
  var DESIGN_AGE = { young: ['young adult, around 25 years old', 'Молодой'], mid: ['middle-aged, around 40 years old', 'Средний'], old: ['older, around 65 years old', 'Пожилой'] };
  var DESIGN_MOOD = {
    warm: ['warm and friendly tone', 'Тёплый'],
    calm: ['calm, relaxed and unhurried delivery', 'Спокойный'],
    lively: ['lively, upbeat and energetic delivery', 'Бодрый'],
    narrator: ['clear, engaging storytelling narrator voice', 'Рассказчик'],
    news: ['precise, neutral news-anchor delivery', 'Диктор'],
    teacher: ['patient language teacher who speaks slowly and very clearly', 'Учитель']
  };
  var DESIGN_TEXT = 'Hallo! Schön, dass du da bist. Heute lernen wir zusammen ein paar neue Wörter. ' +
    'Hör gut zu und sprich einfach nach – Schritt für Schritt, ganz ohne Stress.';

  function designPanel(role, choose) {
    var st = lsGet('ozv.design', { who: 'female', age: 'young', mood: 'warm', model: 'eleven_multilingual_ttv_v2' });
    var box = h('div');
    var dirty = false;
    var urls = [];
    box.appendChild(h('p', { class: 'note', style: 'margin:0 0 4px' },
      'Свой голос по описанию. Это голос вашего аккаунта, а не из библиотеки, поэтому озвучивает и на бесплатном плане. ' +
      'Каждый такой голос занимает место в аккаунте — на бесплатном их немного.'));

    function seg(map, key, label) {
      box.appendChild(h('h3', null, label));
      var el = h('div', { class: 'seg' });
      Object.keys(map).forEach(function (k) {
        el.appendChild(h('button', { type: 'button', class: st[key] === k ? 'on' : '', onclick: function () {
          st[key] = k; lsSet('ozv.design', st);
          el.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b === this); }, this);
          if (!dirty) desc.value = buildDesc();
          if (key === 'who' && !nameTouched) name.value = defaultName();
        } }, map[k][1]));
      });
      box.appendChild(el);
    }
    seg(DESIGN_WHO, 'who', 'Кто');
    seg(DESIGN_AGE, 'age', 'Возраст');

    box.appendChild(h('h3', null, 'Характер'));
    var moods = h('div', { class: 'chips' });
    Object.keys(DESIGN_MOOD).forEach(function (k) {
      moods.appendChild(h('button', { type: 'button', class: st.mood === k ? 'on' : '', onclick: function () {
        st.mood = k; lsSet('ozv.design', st);
        moods.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b === this); }, this);
        if (!dirty) desc.value = buildDesc();
      } }, DESIGN_MOOD[k][1]));
    });
    box.appendChild(moods);

    function buildDesc() {
      return 'A ' + DESIGN_WHO[st.who][0] + ', ' + DESIGN_AGE[st.age][0] +
        ', native German speaker with a clear standard German (Hochdeutsch) accent. ' +
        DESIGN_MOOD[st.mood][0].charAt(0).toUpperCase() + DESIGN_MOOD[st.mood][0].slice(1) +
        '. Natural, studio-quality recording without background noise.';
    }
    box.appendChild(h('h3', null, 'Описание для ElevenLabs'));
    var desc = h('textarea', { class: 'field', style: 'min-height:96px;font:400 14px/1.45 var(--ui)', maxlength: 1000 });
    desc.value = buildDesc();
    desc.addEventListener('input', function () { dirty = true; });
    box.appendChild(desc);
    box.appendChild(h('p', { class: 'note' }, 'По-английски модель понимает описание точнее. Можно дописать своё: «slightly husky», «Bavarian accent», «speaks fast»…'));

    box.appendChild(h('h3', null, 'Текст для пробы'));
    var txt = h('textarea', { class: 'field', style: 'min-height:90px', maxlength: 1000 });
    txt.value = DESIGN_TEXT;
    box.appendChild(txt);

    box.appendChild(h('h3', null, 'Модель'));
    var mseg = h('div', { class: 'seg' });
    [['eleven_multilingual_ttv_v2', 'Ровный (для v2)'], ['eleven_ttv_v3', 'Выразительный (для v3)']].forEach(function (m) {
      mseg.appendChild(h('button', { type: 'button', class: st.model === m[0] ? 'on' : '', onclick: function () {
        st.model = m[0]; lsSet('ozv.design', st);
        mseg.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b === this); }, this);
      } }, m[1]));
    });
    box.appendChild(mseg);

    var go = h('button', { class: 'btn onair block mt', type: 'button' }, 'Создать 3 варианта');
    box.appendChild(go);
    var out = h('div', { class: 'list mt' });
    box.appendChild(out);

    var nameTouched = false;
    function defaultName() { return (st.who === 'male' ? 'Jonas' : 'Lena') + ' Deutsch'; }
    var name = h('input', { class: 'field', type: 'text', maxlength: 40, autocomplete: 'off' });
    name.value = defaultName();
    name.addEventListener('input', function () { nameTouched = true; });

    var last = null;
    go.onclick = function () {
      var d = desc.value.trim(), t = txt.value.trim();
      if (d.length < 20) { toast('Описание — минимум 20 символов', { err: true }); desc.focus(); return; }
      if (t.length < 100) { toast('Текст для пробы — минимум 100 символов (сейчас ' + t.length + ')', { err: true }); txt.focus(); return; }
      go.disabled = true; go.innerHTML = '<span class="spin"></span> Создаю варианты… до 30 секунд';
      urls.forEach(function (u) { URL.revokeObjectURL(u); }); urls = [];
      out.innerHTML = '';
      var seed = Math.floor(Math.random() * 2147483647);
      var keyIndex = S.quota ? S.quota.best : 0;
      api('/api/design', { method: 'POST', body: { action: 'preview', description: d, text: t, model: st.model, keyIndex: keyIndex, seed: seed } })
        .then(function (res) {
          last = { res: res, description: d, text: t, model: st.model, seed: seed, keyIndex: res.keyIndex };
          paintPreviews(res.previews || []);
          loadQuota();
        })
        .catch(function (e) { out.innerHTML = ''; out.appendChild(h('p', { class: 'note', style: 'color:var(--onair)' }, esc(e.message))); })
        .then(function () { go.disabled = false; go.textContent = 'Ещё 3 варианта'; });
    };

    function paintPreviews(list) {
      out.innerHTML = '';
      if (!list.length) { out.appendChild(h('p', { class: 'note' }, 'ElevenLabs не вернул вариантов — измените описание.')); return; }
      out.appendChild(h('h3', null, 'Имя голоса'));
      out.appendChild(name);
      var nKeys = S.quota && S.quota.accounts ? S.quota.accounts.length : 1;
      if (nKeys > 1) {
        var ev = h('label', { class: 'chk' }, '<input type="checkbox" checked><span>Сохранить во все аккаунты (' + nKeys + ')' +
          '<small>В остальных голос создаётся заново с тем же зерном — ElevenLabs обещает тот же голос. Тратит немного символов в каждом аккаунте.</small></span>');
        out.appendChild(ev);
        everywhere = ev.querySelector('input');
      }
      out.appendChild(h('h3', null, 'Послушайте и выберите'));
      list.forEach(function (p, i) {
        var bin = atob(p.audio || ''), u8 = new Uint8Array(bin.length);
        for (var k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
        var url = URL.createObjectURL(new Blob([u8], { type: 'audio/mpeg' }));
        urls.push(url);
        var row = h('div', { class: 'voice-row' });
        var pb = h('button', { class: 'pv', type: 'button', 'aria-label': 'Прослушать' }, ICON.play);
        pb.onclick = function () { previewPlay(url, pb); };
        row.appendChild(pb);
        row.appendChild(h('div', { class: 'li-t' }, '<b>Вариант ' + (i + 1) + '</b><small>' + (p.dur ? T.fmtTime(p.dur) : '') + '</small>'));
        var sv = h('button', { class: 'btn sm primary', type: 'button' }, 'Сохранить');
        sv.onclick = function () { save(p, i, sv); };
        row.appendChild(sv);
        out.appendChild(row);
      });
    }
    var everywhere = null;

    function save(p, i, btn) {
      if (!last) return;
      var nm = name.value.trim() || defaultName();
      out.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
      btn.innerHTML = '<span class="spin"></span>';
      stopPreview();
      api('/api/design', { method: 'POST', body: {
        action: 'save', keyIndex: last.keyIndex, generatedVoiceId: p.id, index: i, name: nm,
        description: last.description, text: last.text, model: last.model, seed: last.seed,
        everywhere: !!(everywhere && everywhere.checked)
      } }).then(function (res) {
        S.voices = null;
        var ids = res.ids || {};
        var firstId = ids[last.keyIndex] || ids[Object.keys(ids)[0]];
        var bad = (res.results || []).filter(function (r) { return !r.ok; });
        if (bad.length) toast('Не сохранилось в акк. ' + bad.map(function (r) { return (r.keyIndex + 1) + ' (' + r.error + ')'; }).join('; '), { err: true });
        else toast('Голос «' + nm + '» сохранён' + (Object.keys(ids).length > 1 ? ' в ' + Object.keys(ids).length + ' аккаунта' : ''));
        choose({ id: firstId, name: nm, preview: '', ids: ids, labels: { language: 'de' } });
        loadQuota();
      }).catch(function (e) {
        toast(e.message, { err: true });
        out.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
        btn.textContent = 'Сохранить';
      });
    }
    return box;
  }

  function openVoices(role, done) {
    if (!S.token) { openLogin(function () { openVoices(role, done); }); return; }
    var box = h('div');
    var s;
    var tab = 'mine';
    var seg = h('div', { class: 'seg' }, '<button type="button" class="on" data-t="mine">Мои голоса</button><button type="button" data-t="lib">Библиотека</button><button type="button" data-t="make">Создать</button>');
    box.appendChild(seg);
    var filters = h('div', { class: 'row mt', hidden: true });
    filters.innerHTML =
      '<input class="field" type="search" placeholder="Поиск: warm, narration, young…" style="flex:1 1 100%">' +
      '<select class="field" style="flex:1"><option value="de">Немецкий</option><option value="ru">Русский</option><option value="uk">Украинский</option><option value="en">Английский</option><option value="">Любой язык</option></select>' +
      '<select class="field" style="flex:1"><option value="">Любой пол</option><option value="female">Женский</option><option value="male">Мужской</option></select>';
    box.appendChild(filters);
    var list = h('div', { class: 'list mt' });
    box.appendChild(list);
    var more = h('button', { class: 'btn block mt', type: 'button', hidden: true }, 'Показать ещё');
    box.appendChild(more);
    var page = 0;

    function choose(v) {
      role.voiceId = v.id; role.voiceName = v.name.split(' - ')[0].trim(); role.preview = v.preview || '';
      // id голоса по аккаунтам: у созданных голосов в каждом аккаунте свой id
      var ids = v.ids || null;
      if (!ids && v.accounts) { ids = {}; v.accounts.forEach(function (i) { ids[i] = v.id; }); }
      role.voiceMap = ids;
      role.voiceAccounts = ids ? Object.keys(ids).map(Number) : null;
      stopPreview(); s.close(); done();
    }
    function row(v, lib) {
      var lab = v.labels || {};
      var about = lib ? [v.gender, v.accent, v.useCase, v.descriptive].filter(Boolean).join(' · ')
        : [lab.gender, lab.age, lab.accent, lab.descriptive || lab.description, lab.use_case].filter(Boolean).join(' · ');
      var el = h('div', { class: 'voice-row' + (v.id === role.voiceId ? ' on' : '') });
      var nKeys = S.quota && S.quota.accounts ? S.quota.accounts.length : 1;
      var where = !lib && v.accounts && nKeys > 1 && v.accounts.length < nKeys ? ' · только в акк. ' + v.accounts.map(function (i) { return i + 1; }).join(', ') : '';
      el.innerHTML = '<div class="li-t"><b>' + esc(v.name.split(' - ')[0]) + '</b><small>' + esc((about || (v.category === 'premade' ? 'стандартный' : v.category || '')) + where) + '</small></div>';
      if (v.preview) {
        var p = h('button', { class: 'pv', type: 'button', 'aria-label': 'Прослушать' }, ICON.play);
        p.onclick = function () { previewPlay(v.preview, p); };
        el.insertBefore(p, el.firstChild);
      }
      var pick = h('button', { class: 'btn sm' + (v.id === role.voiceId ? ' primary' : ''), type: 'button' }, lib && !v.added ? 'Добавить' : 'Выбрать');
      pick.onclick = function () {
        if (!lib || v.added) { choose(v); return; }
        pick.disabled = true; pick.innerHTML = '<span class="spin"></span>';
        api('/api/voices', { method: 'POST', body: { action: 'add', voiceId: v.id, ownerId: v.ownerId, name: v.name } }).then(function (d) {
          if (!d.ok) throw new Error('Не добавился');
          var okRes = (d.results || []).filter(function (x) { return x.ok; });
          var id = okRes.filter(function (x) { return x.id; }).map(function (x) { return x.id; })[0] || v.id;
          S.voices = null;               // список своих голосов изменился
          var addIds = {};
          okRes.forEach(function (x) { addIds[x.keyIndex] = x.id || id; });
          choose({ id: id, name: v.name, preview: v.preview, ids: addIds });
          toast('Голос добавлен в аккаунт' + (d.total > 1 ? 'ы (' + d.added + ' из ' + d.total + ')' : ''));
        }).catch(function (e) { pick.disabled = false; pick.textContent = 'Добавить'; toast(e.message, { err: true }); });
      };
      el.appendChild(pick);
      return el;
    }
    function loadMine() {
      more.hidden = true;
      if (S.voices) return paintMine();
      list.innerHTML = '<p class="center muted"><span class="spin"></span> Загружаю голоса…</p>';
      api('/api/voices?action=mine&keyIndex=all').then(function (d) { S.voices = d.voices || []; paintMine(); })
        .catch(function (e) { list.innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; if (e.code === 'auth') { s.close(); openLogin(function () { openVoices(role, done); }); } });
    }
    function paintMine() {
      list.innerHTML = '';
      var de = S.voices.filter(isGermanVoice);
      var own = S.voices.filter(function (v) { return v.category !== 'premade' && !isGermanVoice(v); });
      var std = S.voices.filter(function (v) { return v.category === 'premade' && !isGermanVoice(v); });
      var allFree = S.quota && (S.quota.accounts || []).every(function (a) { return a.error || /free/i.test(a.tier || ''); });
      list.appendChild(h('h3', null, 'Немецкие'));
      if (de.length) de.forEach(function (v) { list.appendChild(row(v)); });
      else list.appendChild(h('p', { class: 'note', style: 'margin:0 0 6px' }, 'В аккаунтах пока нет немецких голосов. Найдите их во вкладке «Библиотека» — язык там уже стоит «Немецкий».'));
      if (allFree && (de.some(function (v) { return v.category !== 'premade'; }) || own.length)) {
        list.appendChild(h('p', { class: 'note', style: 'color:var(--warn)' }, 'Голоса из библиотеки на бесплатном плане ElevenLabs через API не озвучивают (ошибка 402). Стандартные работают везде и тоже говорят по-немецки.'));
      }
      if (own.length) { list.appendChild(h('h3', null, 'Другие добавленные')); own.forEach(function (v) { list.appendChild(row(v)); }); }
      if (std.length) {
        list.appendChild(h('h3', null, 'Стандартные'));
        list.appendChild(h('p', { class: 'note', style: 'margin:0 0 6px' }, 'Говорят на всех языках, по-немецки тоже — «american» в описании означает только акцент в английском.'));
        std.forEach(function (v) { list.appendChild(row(v)); });
      }
    }
    function loadLib(reset) {
      if (reset) { page = 0; list.innerHTML = ''; }
      var inp = filters.querySelectorAll('input,select');
      var q = new URLSearchParams({ action: 'library', page: String(page), keyIndex: String(S.quota ? S.quota.best : 0) });
      if (inp[0].value.trim()) q.set('search', inp[0].value.trim());
      if (inp[1].value) q.set('language', inp[1].value);
      if (inp[2].value) q.set('gender', inp[2].value);
      var wait = h('p', { class: 'center muted' }, '<span class="spin"></span>');
      list.appendChild(wait);
      api('/api/voices?' + q.toString()).then(function (d) {
        wait.remove();
        (d.voices || []).forEach(function (v) { list.appendChild(row(v, true)); });
        if (!list.children.length) list.innerHTML = '<p class="muted">Ничего не нашлось</p>';
        more.hidden = !d.hasMore;
      }).catch(function (e) { wait.remove(); list.appendChild(h('p', { class: 'muted' }, esc(e.message))); });
    }
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      tab = b.dataset.t;
      seg.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
      filters.hidden = tab !== 'lib';
      more.hidden = true;
      if (tab === 'mine') loadMine();
      else if (tab === 'make') { list.innerHTML = ''; list.appendChild(designPanel(role, choose)); }
      else loadLib(true);
    });
    var searchSoon = debounce(function () { loadLib(true); }, 500);
    filters.addEventListener('input', function (e) { if (e.target.tagName === 'INPUT') searchSoon(); });
    filters.addEventListener('change', function (e) { if (e.target.tagName === 'SELECT') loadLib(true); });
    more.onclick = function () { page++; loadLib(false); };
    s = sheet('Голос для «' + role.name + '»', box, { onClose: stopPreview });
    loadMine();
  }

  // ── вход и лимиты ──────────────────────────────────────
  function openLogin(then) {
    var box = h('div');
    box.innerHTML = '<p class="note" style="margin:0 0 12px">Озвучка идёт через ваши ключи ElevenLabs на сервере. Пароль — переменная <b>EDITOR_PASSWORD</b> в Vercel.</p>';
    var inp = h('input', { class: 'field', type: 'password', autocomplete: 'current-password', placeholder: 'Пароль' });
    var btn = h('button', { class: 'btn primary block mt', type: 'button' }, 'Войти');
    var msg = h('p', { class: 'note' });
    box.appendChild(inp); box.appendChild(btn); box.appendChild(msg);
    var s = sheet('Вход', box);
    setTimeout(function () { inp.focus(); }, 80);
    function go() {
      btn.disabled = true; msg.textContent = '';
      fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: inp.value }) })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (d) {
          btn.disabled = false;
          if (!d.ok) { msg.textContent = d.error || 'Не получилось'; msg.style.color = 'var(--onair)'; return; }
          S.token = d.token; lsSet('ozv.token', { t: d.token, exp: Date.now() + 11.5 * 3600e3 });
          s.close();
          loadQuota().then(function () { if (then) then(); });
        })
        .catch(function () { btn.disabled = false; msg.textContent = 'Нет связи с сервером'; msg.style.color = 'var(--onair)'; });
    }
    btn.onclick = go;
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
  }

  function loadQuota() {
    if (!S.token) { paintQuota(); return Promise.resolve(); }
    return api('/api/quota').then(function (d) { S.quota = d; paintQuota(); }).catch(function () { paintQuota(); });
  }
  function paintQuota() {
    var b = $('btnQuota');
    if (!S.token) { b.innerHTML = 'Войти'; b.classList.remove('low'); return; }
    if (!S.quota) { b.innerHTML = '<span class="spin"></span>'; return; }
    var need = S.proj ? needsWork().chars : 0;
    b.innerHTML = nf(S.quota.left) + ' <span class="q-word">симв.</span>';
    b.classList.toggle('low', S.quota.left < Math.max(need, 500));
    b.title = 'Осталось символов ElevenLabs: ' + nf(S.quota.left) + ' из ' + nf(S.quota.limit);
  }
  $('btnQuota').addEventListener('click', function () { if (!S.token) openLogin(); else openSettings(true); });

  // ── проекты ────────────────────────────────────────────
  function renderProjects(host) {
    if (!host) return;
    host.innerHTML = '';
    S.projects.slice().sort(function (a, b) { return b.updated - a.updated; }).forEach(function (p) {
      var on = S.proj && p.id === S.proj.id;
      var d = new Date(p.updated);
      host.appendChild(h('button', { class: 'li' + (on ? ' on' : ''), type: 'button', onclick: function () { openProject(p.id); var dlg = host.closest('dialog'); if (dlg) dlg.close(); } },
        '<span class="ic">' + ICON.doc + '</span><span class="li-t"><b>' + esc(p.title) + '</b><small>' +
        (p.lines || 0) + ' ' + plural(p.lines || 0, 'реплика', 'реплики', 'реплик') + ' · ' + d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + '</small></span>'));
    });
  }

  function openProjects() {
    var box = h('div');
    var row = h('div', { class: 'row' });
    row.appendChild(h('button', { class: 'btn primary', type: 'button', onclick: function () { s.close(); createProject(); } }, 'Новый проект'));
    row.appendChild(h('button', { class: 'btn', type: 'button', onclick: function () { s.close(); openImport(true); } }, 'Из текста или файла'));
    box.appendChild(row);
    var list = h('div', { class: 'proj-list' });
    box.appendChild(list);
    renderProjects(list);
    box.appendChild(h('h3', null, 'Текущий проект'));
    var cur = h('div', { class: 'row' });
    cur.appendChild(h('button', { class: 'btn', type: 'button', onclick: function () { s.close(); duplicateProject(); } }, ICON.copy.replace('<svg', '<svg width="18" height="18" fill="currentColor"') + 'Копия'));
    cur.appendChild(h('button', { class: 'btn danger', type: 'button', onclick: function () { s.close(); deleteProject(); } }, ICON.trash.replace('<svg', '<svg width="18" height="18" fill="currentColor"') + 'Удалить'));
    box.appendChild(cur);
    var s = sheet('Проекты', box);
  }

  function openProject(id) {
    player.stop();
    return idb.get('projects', id).then(function (p) {
      if (!p) return;
      migrate(p);
      S.proj = p; S.busy = {}; S.errors = {}; S.focusId = null;
      prefs.lastId = p.id; savePrefs();
      renderAll();
      window.scrollTo(0, 0);
    });
  }
  function migrate(p) {
    p.settings = Object.assign({ gap: 450, repeat: 0, format: 'mp3_44100_64', hideTags: true, tapMode: 'one', showTr: true }, p.settings || {});
    if (!p.roles || !p.roles.length) p.roles = [newRole('Рассказчик', 6, { narrator: true })];
    p.blocks = p.blocks || [];
  }
  function addProject(p) {
    migrate(p);
    S.projects.push({ id: p.id, title: p.title, updated: p.updated, lines: countLines(p) });
    return idb.put('projects', p).then(function () { return openProject(p.id); });
  }
  function createProject() {
    var p = newProject('Новый диалог');
    // роли и голоса текущего проекта — удобно для серии уроков
    if (S.proj) p.roles = JSON.parse(JSON.stringify(S.proj.roles));
    addProject(p).then(function () { $('title').select(); });
  }
  function duplicateProject() {
    var p = JSON.parse(JSON.stringify(S.proj));
    p.id = uid(); p.title = S.proj.title + ' (копия)'; p.created = p.updated = Date.now();
    // звук копируем, чтобы удаление одного проекта не ломало другой
    var jobs = p.blocks.filter(function (b) { return b.audio; }).map(function (b) {
      var nk = b.id + ':' + uid();
      return idb.get('audio', b.audio.key).then(function (blob) { if (blob) { b.audio.key = nk; return idb.put('audio', blob, nk); } b.audio = null; });
    });
    Promise.all(jobs).then(function () { return addProject(p); }).then(function () { toast('Копия создана'); });
  }
  function deleteProject() {
    if (!confirm('Удалить «' + S.proj.title + '» вместе со звуком?')) return;
    var p = S.proj;
    player.stop();
    p.blocks.forEach(function (b) { if (b.audio) dropAudio(b.audio.key); });
    idb.del('projects', p.id).then(function () {
      S.projects = S.projects.filter(function (x) { return x.id !== p.id; });
      if (!S.projects.length) return addProject(newProject('Новый диалог'));
      var next = S.projects.slice().sort(function (a, b) { return b.updated - a.updated; })[0];
      return openProject(next.id);
    }).then(function () { toast('Проект удалён'); });
  }
  $('btnProjects').addEventListener('click', openProjects);
  $('sideNew').addEventListener('click', createProject);

  // ── импорт ─────────────────────────────────────────────
  function importOpts() {
    return lsGet('ozv.import', { names: true, dashes: true, tr: true, split: 'lines' });
  }
  // «Имя: текст» → роль; «— текст» → два собеседника по очереди; «# …» → заголовок; «текст // перевод»
  function sentences(t) {
    var out = String(t).match(/[^.!?…]+(?:[.!?…]+["»“”')\]]*|$)/g) || [t];
    return out.map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function roleByName(name) {
    var n = name.trim().toLowerCase();
    var r = S.proj.roles.filter(function (x) { return x.name.toLowerCase() === n; })[0];
    if (r) return r;
    var used = S.proj.roles.map(function (x) { return x.color; });
    var free = COLORS.filter(function (c) { return used.indexOf(c) < 0; });
    r = newRole(name.trim(), S.proj.roles.length, { color: free[0] || COLORS[S.proj.roles.length % COLORS.length] });
    S.proj.roles.push(r);
    return r;
  }
  function parseText(text, o) {
    var out = [], dash = 0;
    var narrator = S.proj.roles.filter(function (r) { return r.narrator; })[0] || S.proj.roles[0];
    var NAME = /^\s*([\p{L}][\p{L}\p{N} .'’\-]{0,23}?)\s*:\s+(\S.*)$/u;
    String(text).replace(/\r\n?/g, '\n').split(/\n/).forEach(function (raw) {
      var s = raw.trim();
      if (!s) return;
      if (/^#{1,3}\s+/.test(s)) { out.push({ id: uid(), type: 'heading', roleId: narrator.id, html: esc(s.replace(/^#+\s+/, '')), tr: '', mood: '' }); return; }
      var tr = '';
      if (o.tr) { var k = s.indexOf(' // '); if (k > 0) { tr = s.slice(k + 4).trim(); s = s.slice(0, k).trim(); } }
      var role = narrator, m;
      if (o.names && (m = s.match(NAME)) && !/^(https?|www)$/i.test(m[1])) { role = roleByName(m[1]); s = m[2]; }
      else if (o.dashes && /^[—–-]\s*\S/.test(s)) { role = roleByName(dash++ % 2 ? 'Собеседник 2' : 'Собеседник 1'); s = s.replace(/^[—–-]\s*/, ''); }
      var parts = o.split === 'sentences' ? sentences(s) : [s];
      parts.forEach(function (t, i) { out.push({ id: uid(), type: 'line', roleId: role.id, html: esc(t), tr: i === 0 ? tr : '', mood: '' }); });
    });
    return out;
  }

  function openImport(asNew) {
    var o = importOpts();
    var box = h('div');
    var ta = h('textarea', { class: 'field', placeholder: 'Anna: Guten Tag! // Добрый день!\nMax: Hallo, wie geht\'s?\n\n# Заголовок\nПросто текст — читает рассказчик.' });
    box.appendChild(ta);
    var frow = h('div', { class: 'row mt' });
    var fbtn = h('button', { class: 'btn', type: 'button' }, 'Открыть файл… <small class="muted">.txt .docx .html</small>');
    frow.appendChild(fbtn);
    box.appendChild(frow);

    box.appendChild(h('h3', null, 'Как разобрать'));
    function chk(key, label, hint) {
      var l = h('label', { class: 'chk' }, '<input type="checkbox"' + (o[key] ? ' checked' : '') + '><span>' + label + (hint ? '<small>' + hint + '</small>' : '') + '</span>');
      l.querySelector('input').addEventListener('change', function () { o[key] = this.checked; lsSet('ozv.import', o); preview(); });
      box.appendChild(l);
    }
    chk('names', '«Имя: текст» — реплика этой роли', 'Роли создаются сами');
    chk('dashes', '«— текст» — два собеседника по очереди');
    chk('tr', '«текст // перевод» — строка перевода');
    var seg = h('div', { class: 'seg' }, '<button type="button" data-v="lines">Строка = реплика</button><button type="button" data-v="sentences">Предложение = реплика</button>');
    function paintSeg() { seg.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.v === o.split); }); }
    paintSeg();
    seg.onclick = function (e) { var b = e.target.closest('button'); if (!b) return; o.split = b.dataset.v; lsSet('ozv.import', o); paintSeg(); preview(); };
    box.appendChild(seg);
    box.appendChild(h('p', { class: 'note' }, 'Предложения удобны для монолога: нажатием можно переслушать любую фразу.'));

    var info = h('p', { class: 'note', style: 'min-height:1.4em' });
    box.appendChild(info);
    var where = asNew || !S.proj.blocks.length ? 'new' : 'append';
    var wseg = h('div', { class: 'seg mt' }, '<button type="button" data-v="append">В конец</button><button type="button" data-v="replace">Заменить текст</button><button type="button" data-v="new">Новый проект</button>');
    function paintW() { wseg.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.v === where); }); }
    paintW();
    wseg.onclick = function (e) { var b = e.target.closest('button'); if (b) { where = b.dataset.v; paintW(); } };
    box.appendChild(wseg);
    var go = h('button', { class: 'btn primary block mt', type: 'button' }, 'Разобрать');
    box.appendChild(go);

    function preview() {
      var lines = ta.value.split('\n').filter(function (s) { return s.trim(); });
      if (!lines.length) { info.textContent = ''; return; }
      var names = {};
      if (o.names) lines.forEach(function (s) { var m = s.match(/^\s*([\p{L}][\p{L}\p{N} .'’\-]{0,23}?)\s*:\s+\S/u); if (m) names[m[1].trim()] = 1; });
      var n = Object.keys(names);
      info.textContent = lines.length + ' ' + plural(lines.length, 'строка', 'строки', 'строк') + (n.length ? ' · роли: ' + n.slice(0, 6).join(', ') + (n.length > 6 ? '…' : '') : '');
    }
    ta.addEventListener('input', debounce(preview, 250));

    var s = sheet('Импорт текста', box, { wide: true });

    fbtn.onclick = function () {
      var inp = $('fileImport');
      inp.value = '';
      inp.onchange = function () {
        var f = inp.files[0];
        if (!f) return;
        readImportFile(f).then(function (res) {
          if (res.project) { s.close(); return; }
          ta.value = res.text; preview();
          if (where === 'append' && !S.proj.blocks.length) { where = 'new'; paintW(); }
        }).catch(function (e) { toast(e.message, { err: true }); });
      };
      inp.click();
    };

    go.onclick = function () {
      var text = ta.value;
      if (!text.trim()) { ta.focus(); return; }
      var target = S.proj;
      var finish = function () {
        var blocks = parseText(text, o);
        if (where === 'replace') {
          S.proj.blocks.forEach(function (b) { if (b.audio) dropAudio(b.audio.key); });
          S.proj.blocks = blocks;
        } else S.proj.blocks = S.proj.blocks.concat(blocks);
        // первая строка-заголовок у нового проекта становится названием
        if (where === 'new' && blocks[0] && blocks[0].type === 'heading') { S.proj.title = T.plain(blocks[0].html); S.proj.blocks.shift(); }
        s.close(); setMode('edit'); renderAll(); saveNow();
        toast('Готово: ' + blocks.filter(isLine).length + ' ' + plural(blocks.filter(isLine).length, 'реплика', 'реплики', 'реплик'));
      };
      if (where === 'new') {
        var p = newProject('Новый диалог');
        if (target) p.roles = JSON.parse(JSON.stringify(target.roles));
        addProject(p).then(finish);
      } else finish();
    };
  }

  // .txt / .docx → текст; .html из ОЗВУЧКИ → целый проект со звуком
  function readImportFile(f) {
    var name = f.name.toLowerCase();
    if (/\.docx$/.test(name)) {
      if (!window.mammoth) return Promise.reject(new Error('Модуль Word ещё загружается — попробуйте через пару секунд'));
      return f.arrayBuffer().then(function (buf) { return window.mammoth.extractRawText({ arrayBuffer: buf }); })
        .then(function (r) { return { text: r.value.replace(/\n{3,}/g, '\n\n') }; });
    }
    return f.text().then(function (t) {
      t = t.replace(/^\uFEFF/, '');
      if (/\.html?$/.test(name) || /^\s*<!doctype/i.test(t)) {
        var m = t.match(/<script type="application\/json" id="oz-data">([\s\S]*?)<\/script>/);
        if (m) return importPage(JSON.parse(m[1])).then(function () { return { project: true }; });
        var d = new DOMParser().parseFromString(t, 'text/html');
        return { text: (d.body.innerText || d.body.textContent || '').trim() };
      }
      return { text: t };
    });
  }

  // Скачанная страница содержит проект целиком — её можно открыть обратно и доработать
  function importPage(D) {
    var p = newProject(D.title || 'Импорт');
    p.roles = (D.roles || []).map(function (r, i) { return Object.assign(newRole(r.name, i), r); });
    if (!p.roles.length) p.roles = [newRole('Рассказчик', 6, { narrator: true })];
    p.settings = Object.assign(p.settings, D.settings || {});
    p.blocks = (D.blocks || []).map(function (b) { return { id: b.id || uid(), type: b.type || 'line', roleId: b.roleId, html: T.sanitize(b.html), tr: b.tr || '', mood: b.mood || '' }; });
    var jobs = p.blocks.map(function (b) {
      var a = D.audio && D.audio[b.id];
      if (!a || !a.d) return null;
      return fetch(a.d).then(function (r) { return r.blob(); }).then(function (blob) {
        var key = b.id + ':' + uid();
        b.audio = { key: key, sig: a.sig || 'file', dur: a.dur || 0, src: a.sig ? 'tts' : 'file' };
        return idb.put('audio', blob, key);
      });
    }).filter(Boolean);
    return Promise.all(jobs).then(function () { return addProject(p); }).then(function () { toast('Проект открыт со звуком: ' + jobs.length); });
  }
  $('btnImport').addEventListener('click', function () { openImport(); });

  // ── экспорт ────────────────────────────────────────────
  function slug(s) {
    return String(s || 'ozvuchka').toLowerCase()
      .replace(/[äöüß]/g, function (c) { return { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' }[c]; })
      .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 50) || 'ozvuchka';
  }
  function download(name, blob) {
    var u = URL.createObjectURL(blob);
    var a = h('a', { href: u, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 60000);   // Android обрывает скачивание при мгновенном revoke
  }
  function blobToDataUrl(blob) {
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; r.readAsDataURL(blob); });
  }
  function fetchText(u) { return fetch(u, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(u + ': ' + r.status); return r.text(); }); }

  function buildPage() {
    var p = S.proj;
    var withAudio = p.blocks.filter(function (b) { return isLine(b) && b.audio; });
    return Promise.all([fetchText('/reader.css'), fetchText('/reader.js')].concat(withAudio.map(function (b) {
      return idb.get('audio', b.audio.key).then(function (blob) { return blob ? blobToDataUrl(blob) : null; });
    }))).then(function (res) {
      var css = res[0], js = res[1], audio = {};
      withAudio.forEach(function (b, i) { if (res[i + 2]) audio[b.id] = { d: res[i + 2], dur: b.audio.dur, sig: b.audio.src === 'tts' ? b.audio.sig : '' }; });
      var data = {
        v: 1, app: 'ozvuchka', title: p.title,
        settings: { gap: p.settings.gap, repeat: p.settings.repeat, hideTags: p.settings.hideTags, tapMode: p.settings.tapMode },
        roles: p.roles.map(function (r) { var c = Object.assign({}, r); return c; }),
        blocks: p.blocks.map(function (b) { return { id: b.id, type: b.type, roleId: b.roleId, html: b.html, tr: b.tr, mood: b.mood }; }),
        audio: audio
      };
      var json = JSON.stringify(data).replace(/</g, '\\u003c');
      var boot = "(function(){var D=JSON.parse(document.getElementById('oz-data').textContent);" +
        "var H=document.documentElement;if(matchMedia('(prefers-color-scheme: dark)').matches)H.classList.add('dark');" +
        "var app=document.getElementById('app');OzRender.doc(app,D,function(b){return!!D.audio[b.id]});" +
        "var roles={};D.roles.forEach(function(r){roles[r.id]=r});var urls={};" +
        "function src(id){if(urls[id])return urls[id];var s=D.audio[id].d,b=atob(s.split(',')[1]),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return urls[id]=URL.createObjectURL(new Blob([u],{type:'audio/mpeg'}))}" +
        "var items=D.blocks.filter(function(b){return b.type!=='heading'&&D.audio[b.id]}).map(function(b){var r=roles[b.roleId]||{};return{id:b.id,dur:D.audio[b.id].dur,name:r.narrator?'':r.name,color:r.color,text:OzText.plain(OzText.hideTags(b.html))}});" +
        "var bar;var P=new OzPlayer({items:function(){return items},src:src,el:function(id){return app.querySelector('[data-id=\"'+id+'\"]')},gap:function(it){return OzGap(D.settings,it&&it.dur)},title:function(){return D.title},onChange:function(){bar&&bar.paint()},onTick:function(){bar&&bar.tick()}});" +
        "bar=OzBar(document.body,P,{translation:D.blocks.some(function(b){return b.tr})});P.refresh();" +
        "var one=D.settings.tapMode!=='from';app.addEventListener('click',function(e){var l=e.target.closest('.oz-line');if(l&&!l.classList.contains('no-audio'))P.playId(l.dataset.id,one)});" +
        "app.addEventListener('keydown',function(e){if(e.key==='Enter'&&e.target.classList.contains('oz-line'))P.playId(e.target.dataset.id,one)});" +
        "document.getElementById('theme').onclick=function(){H.classList.toggle('dark')};})();";
      var html = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n' +
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
        '<title>' + esc(p.title) + '</title>\n' +
        '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,600;1,7..72,400&family=Onest:wght@400;600&display=swap">\n' +
        '<style>\n' + css + '\n</style>\n</head>\n<body class="oz-export">\n<main id="app"></main>\n' +
        '<div class="oz-export-foot">Нажмите на реплику, чтобы услышать её · <button id="theme" type="button">светлая / тёмная</button></div>\n' +
        '<script type="application/json" id="oz-data">' + json + '</script>\n' +
        '<script>\n' + js + '\n</script>\n<script>' + boot + '</script>\n</body>\n</html>\n';
      return new Blob([html], { type: 'text/html;charset=utf-8' });
    });
  }

  // ── MP3 целиком: реплики + настоящая тишина между ними ──
  // Склеиваем на уровне MP3-кадров: у каждого клипа убираем ID3 и служебный кадр Xing/Info
  // (иначе плеер считает длину файла по первому клипу), а паузу собираем из «пустых» кадров
  // с тем же заголовком, что у соседнего звука. Пустой кадр Layer III (нулевая побочная
  // информация, main_data_begin = 0) любой декодер играет как тишину — перекодировать ничего не нужно.
  var MP3 = (function () {
    var BR = {                                   // кбит/с по индексу
      1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
      2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    };
    var SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

    function header(u, i) {
      if (i + 4 > u.length || u[i] !== 0xFF || (u[i + 1] & 0xE0) !== 0xE0) return null;
      var ver = (u[i + 1] >> 3) & 3, layer = (u[i + 1] >> 1) & 3;
      var bri = u[i + 2] >> 4, sri = (u[i + 2] >> 2) & 3, pad = (u[i + 2] >> 1) & 1;
      if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) return null;   // только Layer III
      var mpeg1 = ver === 3;
      var br = BR[mpeg1 ? 1 : 2][bri] * 1000, sr = SR[ver][sri];
      var mono = (u[i + 3] >> 6) === 3;
      return {
        len: Math.floor((mpeg1 ? 144 : 72) * br / sr) + pad,
        spf: mpeg1 ? 1152 : 576, sr: sr,
        side: mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17),
        crc: !(u[i + 1] & 1)
      };
    }

    // → { frames: [Uint8Array…], first: байты заголовка, h } или null, если это не MP3
    function parse(buf) {
      var u = new Uint8Array(buf), i = 0, frames = [], first = null, fh = null;
      if (u[0] === 0x49 && u[1] === 0x44 && u[2] === 0x33) {              // ID3v2
        i = 10 + ((u[6] & 127) << 21 | (u[7] & 127) << 14 | (u[8] & 127) << 7 | (u[9] & 127));
        if (u[5] & 0x10) i += 10;
      }
      var miss = 0;
      while (i < u.length) {
        var hd = header(u, i);
        if (!hd || hd.len < 21 || i + hd.len > u.length) {
          if (!frames.length && miss < 8192) { i++; miss++; continue; }        // мусор перед первым кадром
          break;                                                              // ID3v1 «TAG» или хвост
        }
        var f = u.subarray(i, i + hd.len);
        var off = 4 + (hd.crc ? 2 : 0) + hd.side;
        var tag = String.fromCharCode(f[off], f[off + 1], f[off + 2], f[off + 3]);
        var vbri = String.fromCharCode(f[36], f[37], f[38], f[39]);
        if (!frames.length && (tag === 'Xing' || tag === 'Info' || vbri === 'VBRI')) { i += hd.len; continue; }
        if (!first) { first = f.slice(0, 4); fh = hd; }
        frames.push(f);
        i += hd.len;
      }
      return frames.length > 2 ? { frames: frames, first: first, h: fh } : null;
    }

    // пустой кадр с тем же форматом: без CRC, без добавочного байта, всё остальное — нули
    function silentFrame(first, hd) {
      var hb = new Uint8Array(first);
      hb[1] |= 1;                    // protection_bit = 1 → без CRC
      hb[2] &= ~2;                   // padding = 0
      var len = hd.len - (((first[2] >> 1) & 1));
      var f = new Uint8Array(len);
      f.set(hb, 0);
      return f;
    }
    function silence(first, hd, ms) {
      var n = Math.round(ms / 1000 * hd.sr / hd.spf);
      var f = silentFrame(first, hd), out = [];
      for (var k = 0; k < n; k++) out.push(f);
      return out;
    }
    // Служебный кадр Xing в начале: число кадров и байт — плеер покажет верную длину,
    // даже если у клипов разный битрейт
    function xing(first, hd, frames, bytes) {
      var f = silentFrame(first, hd);
      var off = 4 + hd.side;
      var put = function (o, v) { f[o] = v >>> 24 & 255; f[o + 1] = v >>> 16 & 255; f[o + 2] = v >>> 8 & 255; f[o + 3] = v & 255; };
      f[off] = 88; f[off + 1] = 105; f[off + 2] = 110; f[off + 3] = 103;    // 'Xing'
      put(off + 4, 3);                                                       // есть: кадры + байты
      put(off + 8, frames);
      put(off + 12, bytes + f.length);
      return f;
    }
    function sameFormat(a, b) { return a.h.sr === b.h.sr && a.h.side === b.h.side; }
    return { parse: parse, silence: silence, xing: xing, sameFormat: sameFormat };
  })();

  // Запасной путь для «своих» файлов не в MP3 (m4a, wav…): WAV через Web Audio
  function buildWav(blobs, gaps) {
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = new AC({ sampleRate: 44100 });
    return Promise.all(blobs.map(function (b) { return b.arrayBuffer().then(function (ab) { return ctx.decodeAudioData(ab); }); }))
      .then(function (bufs) {
        var sr = 44100, total = 0;
        bufs.forEach(function (b, i) { total += b.length + (i < bufs.length - 1 ? Math.round(gaps[i] / 1000 * sr) : 0); });
        var pcm = new Int16Array(total), pos = 0;
        bufs.forEach(function (b, i) {
          var chs = [];
          for (var c = 0; c < b.numberOfChannels; c++) chs.push(b.getChannelData(c));
          for (var k = 0; k < b.length; k++) {
            var v = 0;
            for (c = 0; c < chs.length; c++) v += chs[c][k];
            v = Math.max(-1, Math.min(1, v / chs.length));
            pcm[pos++] = v < 0 ? v * 0x8000 : v * 0x7FFF;
          }
          if (i < bufs.length - 1) pos += Math.round(gaps[i] / 1000 * sr);
        });
        if (ctx.close) ctx.close();
        var head = new DataView(new ArrayBuffer(44));
        var w = function (o, str) { for (var k = 0; k < 4; k++) head.setUint8(o + k, str.charCodeAt(k)); };
        w(0, 'RIFF'); head.setUint32(4, 36 + pcm.byteLength, true); w(8, 'WAVE');
        w(12, 'fmt '); head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 1, true);
        head.setUint32(24, sr, true); head.setUint32(28, sr * 2, true); head.setUint16(32, 2, true); head.setUint16(34, 16, true);
        w(36, 'data'); head.setUint32(40, pcm.byteLength, true);
        return { blob: new Blob([head.buffer, pcm.buffer], { type: 'audio/wav' }), ext: 'wav' };
      });
  }

  function buildMp3() {
    var bs = S.proj.blocks.filter(function (b) { return isLine(b) && b.audio; });
    var gaps = bs.map(function (b) { return window.OzGap(S.proj.settings, b.audio.dur); });
    return Promise.all(bs.map(function (b) { return idb.get('audio', b.audio.key); })).then(function (blobs) {
      var ok = [], okGaps = [];
      blobs.forEach(function (b, i) { if (b) { ok.push(b); okGaps.push(gaps[i]); } });
      return Promise.all(ok.map(function (b) { return b.arrayBuffer(); })).then(function (bufs) {
        var parsed = bufs.map(MP3.parse);
        // не-MP3 или разная частота/каналы — такой поток не каждый плеер выдержит, собираем WAV
        if (parsed.some(function (x) { return !x || !MP3.sameFormat(x, parsed[0]); })) return buildWav(ok, okGaps);
        var parts = [];
        parsed.forEach(function (x, i) {
          parts = parts.concat(x.frames);
          if (i < parsed.length - 1) {
            // тишина в формате следующего клипа — на стыке не меняется частота
            var nx = parsed[i + 1];
            parts = parts.concat(MP3.silence(nx.first, nx.h, okGaps[i]));
          }
        });
        var bytes = 0;
        parts.forEach(function (f) { bytes += f.length; });
        parts.unshift(MP3.xing(parsed[0].first, parsed[0].h, parts.length, bytes));
        return { blob: new Blob(parts, { type: 'audio/mpeg' }), ext: 'mp3' };
      });
    });
  }

  function buildTxt() {
    var out = S.proj.blocks.map(function (b) {
      if (b.type === 'heading') return '# ' + T.plain(b.html);
      var r = roleById(b.roleId);
      return (r.narrator ? '' : r.name + ': ') + T.plain(b.html).replace(/\n/g, ' ') + (b.tr ? ' // ' + b.tr : '');
    });
    return new Blob(['# ' + S.proj.title + '\n\n' + out.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
  }

  function openExport() {
    var p = S.proj;
    var lines = p.blocks.filter(isLine);
    var withA = lines.filter(function (b) { return b.audio; });
    var bytes = 0;
    var box = h('div');
    var miss = lines.length - withA.length;
    var stale = lines.filter(function (b) { return status(b) === 'stale'; }).length;
    if (miss || stale) {
      var w = h('div', { class: 'row', style: 'margin-bottom:6px' });
      w.innerHTML = '<p class="note" style="margin:0;flex:1 1 100%">' +
        (miss ? 'Без звука: ' + miss + ' ' + plural(miss, 'реплика', 'реплики', 'реплик') + '. ' : '') +
        (stale ? 'Устарело: ' + stale + ' — в файл попадёт прежний звук.' : '') + '</p>';
      var g = h('button', { class: 'btn onair sm', type: 'button', onclick: function () { s.close(); $('gen').click(); } }, 'Сначала озвучить');
      if (needsWork().list.length) w.appendChild(g);
      box.appendChild(w);
    }
    var list = h('div', { class: 'list' });
    function item(title, sub, fn) {
      var b = h('button', { class: 'li', type: 'button' }, '<span class="ic">' + ICON.doc + '</span><span class="li-t"><b>' + title + '</b><small>' + sub + '</small></span>');
      b.onclick = function () {
        b.disabled = true; var old = b.innerHTML; b.querySelector('.ic').innerHTML = '<span class="spin"></span>';
        fn().then(function () { b.disabled = false; b.innerHTML = old; }, function (e) { b.disabled = false; b.innerHTML = old; toast(e.message, { err: true }); });
      };
      list.appendChild(b);
      return b;
    }
    var sizeEl = h('span');
    item('Страница со звуком (.html)', 'Работает без интернета: текст, плеер, нажатие на реплику. Её же можно открыть здесь снова для правки.', function () {
      return buildPage().then(function (blob) { deliver(slug(p.title) + '.html', blob, 'text/html'); });
    });
    item('Весь звук одним MP3', 'Все реплики подряд с паузами из настроек — для прослушивания в дороге', function () {
      if (!withA.length) return Promise.reject(new Error('Нет озвученных реплик'));
      return buildMp3().then(function (r) {
        if (r.ext === 'wav') toast('Среди звуков есть не-MP3 — собрал WAV: он больше, но паузы на месте');
        deliver(slug(p.title) + '.' + r.ext, r.blob, r.ext === 'wav' ? 'audio/wav' : 'audio/mpeg');
      });
    });
    item('Текст (.txt)', 'В формате «Имя: текст // перевод» — импортируется обратно', function () {
      return Promise.resolve(deliver(slug(p.title) + '.txt', buildTxt(), 'text/plain'));
    });
    box.appendChild(list);
    Promise.all(withA.map(function (b) { return idb.get('audio', b.audio.key); })).then(function (bl) {
      bl.forEach(function (x) { if (x) bytes += x.size; });
      sizeEl.textContent = withA.length ? 'Звук: ' + withA.length + ' ' + plural(withA.length, 'реплика', 'реплики', 'реплик') + ', ~' + (bytes * 1.37 / 1048576).toFixed(1) + ' МБ в странице' : '';
    });
    box.appendChild(h('p', { class: 'note' })).appendChild(sizeEl);
    var s = sheet('Скачать', box);
  }

  // На телефоне — «Поделиться» (сразу в Telegram, Drive…), иначе обычное скачивание
  function deliver(name, blob, type) {
    var file;
    try { file = new File([blob], name, { type: type }); } catch (e) {}
    if (file && navigator.canShare && navigator.canShare({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
      var box = h('div', { class: 'row' });
      var s;
      box.appendChild(h('button', { class: 'btn primary', type: 'button', onclick: function () {
        navigator.share({ files: [file], title: S.proj.title }).catch(function () {}); s.close();
      } }, 'Поделиться'));
      box.appendChild(h('button', { class: 'btn', type: 'button', onclick: function () { download(name, blob); s.close(); } }, 'Сохранить в загрузки'));
      s = sheet(name, box);
      return;
    }
    download(name, blob);
  }
  $('btnExport').addEventListener('click', openExport);

  // ── настройки и меню ───────────────────────────────────
  function applyTheme() {
    var dark = prefs.theme === 'dark' || (prefs.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  // ── проверка ключей ElevenLabs ─────────────────────────
  function openKeyCheck() {
    if (!S.token) { openLogin(openKeyCheck); return; }
    var box = h('div');
    box.appendChild(h('p', { class: 'note', style: 'margin:0 0 10px' },
      'Каждый ключ из Vercel проверяется по отдельности: доступ к аккаунту, голоса и пробная озвучка слова «Ja.» (около 3 символов). ' +
      'Номер — порядок ключа в ELEVENLABS_API_KEYS, в конце — последние 4 символа ключа.'));
    var tts = h('label', { class: 'chk' }, '<input type="checkbox" checked><span>Проверять озвучку<small>Без неё символы не тратятся, но нерабочую озвучку не видно</small></span>');
    box.appendChild(tts);
    var go = h('button', { class: 'btn primary block', type: 'button' }, 'Проверить');
    box.appendChild(go);
    var out = h('div', { class: 'mt' });
    box.appendChild(out);
    sheet('Проверка ключей', box, { wide: true });

    function line(label, c, okText) {
      if (!c) return '';
      if (c.ok) return '<div class="kc-l ok">✓ ' + label + (okText ? ' <span class="muted">— ' + okText + '</span>' : '') + '</div>';
      return '<div class="kc-l bad">✗ ' + label + ': ' + esc(c.error || 'ошибка') + '</div>' + (c.hint ? '<div class="kc-hint">' + esc(c.hint) + '</div>' : '');
    }
    function run() {
      go.disabled = true; go.innerHTML = '<span class="spin"></span> Проверяю…';
      out.innerHTML = '';
      api('/api/check', { method: 'POST', body: { tts: tts.querySelector('input').checked } }).then(function (d) {
        var good = 0;
        (d.keys || []).forEach(function (k) {
          var dead = k.user && !k.user.ok && k.voices && !k.voices.ok && (!k.tts || !k.tts.ok);
          var works = k.tts ? k.tts.ok : (k.voices && k.voices.ok);
          if (works) good++;
          var card = h('div', { class: 'kc' + (works ? ' ok' : dead ? ' dead' : ' warn') });
          card.innerHTML =
            '<div class="kc-h"><b>Ключ ' + (k.index + 1) + '</b> <span class="muted">…' + esc(k.tail) + '</span>' +
            '<span class="kc-st">' + (works ? 'работает' : dead ? 'не работает' : 'с ограничениями') + '</span></div>' +
            line('Аккаунт', k.user, k.user && k.user.ok ? k.user.tier + ', осталось ' + nf(k.user.left) + ' из ' + nf(k.user.limit) : '') +
            line('Голоса', k.voices, k.voices && k.voices.ok ? k.voices.count + (k.voices.premade ? ', есть стандартные' : ', стандартных нет') : '') +
            line('Озвучка', k.tts, '');
          out.appendChild(card);
        });
        out.insertBefore(h('p', { class: 'note', style: 'margin:0 0 10px;color:var(--ink)' },
          'Рабочих ключей: <b>' + good + ' из ' + (d.keys || []).length + '</b>. Нерабочий ключ удалите из ELEVENLABS_API_KEYS — ' +
          'но только в конце списка или вместе с пересозданием голосов, чтобы не сбились номера аккаунтов.'), out.firstChild);
        loadQuota();
      }).catch(function (e) {
        out.innerHTML = '<p class="note" style="color:var(--onair)">' + esc(e.message) + '</p>';
      }).then(function () { go.disabled = false; go.textContent = 'Проверить снова'; });
    }
    go.onclick = run;
  }

  function openSettings(scrollToAcc) {
    var p = S.proj, st = p.settings;
    var box = h('div');
    function segOf(opts, cur, set) {
      var seg = h('div', { class: 'seg' });
      opts.forEach(function (o) {
        seg.appendChild(h('button', { type: 'button', class: o[0] === cur ? 'on' : '', onclick: function () {
          set(o[0]); seg.querySelectorAll('button').forEach(function (b) { b.classList.remove('on'); }); this.classList.add('on');
        } }, o[1]));
      });
      return seg;
    }
    box.appendChild(h('h3', null, 'Тема'));
    box.appendChild(segOf([['auto', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']], prefs.theme, function (v) { prefs.theme = v; savePrefs(); applyTheme(); }));

    box.appendChild(h('h3', null, 'Нажатие на реплику при чтении'));
    box.appendChild(segOf([['one', 'Только она'], ['from', 'С неё и дальше']], st.tapMode, function (v) { st.tapMode = v; touch(); }));

    var gap = h('div', { class: 'sl' }, '<label>Пауза между репликами</label><output></output><input type="range" min="0" max="2000" step="50">');
    var gi = gap.querySelector('input'), go = gap.querySelector('output');
    gi.value = st.gap; go.textContent = (st.gap / 1000).toFixed(2).replace('.', ',') + ' с';
    gi.oninput = function () { st.gap = +gi.value; go.textContent = (st.gap / 1000).toFixed(2).replace('.', ',') + ' с'; touch(); };
    box.appendChild(gap);

    box.appendChild(h('h3', null, 'Время на повтор после реплики'));
    box.appendChild(segOf([[0, 'Нет'], [1, '1×'], [1.5, '1,5×'], [2, '2×']], +st.repeat || 0, function (v) { st.repeat = v; touch(); }));
    box.appendChild(h('p', { class: 'note' }, 'Тишина длиной в реплику (×1, ×1,5, ×2) — чтобы успеть повторить вслух. Работает в плеере, в скачанной странице и в MP3.'));

    box.appendChild(h('h3', null, 'Качество новой озвучки'));
    box.appendChild(segOf([['mp3_44100_64', '64 кбит/с — легче'], ['mp3_44100_128', '128 кбит/с — чище']], st.format, function (v) { st.format = v; renderDoc(); touch(); }));
    box.appendChild(h('p', { class: 'note' }, 'Смена качества помечает озвученное как устаревшее — переозвучивать не обязательно.'));

    var ht = h('label', { class: 'chk' }, '<input type="checkbox"' + (st.hideTags ? ' checked' : '') + '><span>Скрывать [теги] v3 при чтении</span>');
    ht.querySelector('input').onchange = function () { st.hideTags = this.checked; touch(); if (S.mode === 'read') renderDoc(); };
    box.appendChild(ht);
    var tr = h('label', { class: 'chk' }, '<input type="checkbox"' + (st.showTr ? ' checked' : '') + '><span>Строка перевода под каждой репликой<small>Если выключено — видна только у заполненных</small></span>');
    tr.querySelector('input').onchange = function () { st.showTr = this.checked; document.body.classList.toggle('no-tr-field', !st.showTr); touch(); };
    box.appendChild(tr);

    var accH = h('h3', null, 'ElevenLabs');
    box.appendChild(accH);
    var acc = h('div', { class: 'acc' });
    box.appendChild(acc);
    if (!S.token) {
      acc.appendChild(h('button', { class: 'btn primary', type: 'button', onclick: function () { s.close(); openLogin(); } }, 'Войти'));
    } else {
      var paintAcc = function () {
        acc.innerHTML = '';
        if (!S.quota) { acc.innerHTML = '<p class="muted"><span class="spin"></span></p>'; return; }
        (S.quota.accounts || []).forEach(function (a) {
          var row = h('div', { class: 'acc-row' + (a.error ? ' bad' : '') });
          row.innerHTML = a.error
            ? 'Аккаунт ' + (a.index + 1) + ': ' + esc(a.noPermission ? 'у ключа нет права «User → Read», озвучка работает' : a.error)
            : 'Аккаунт ' + (a.index + 1) + ' · ' + esc(a.tier) + ' — осталось <b>' + nf(a.left) + '</b> из ' + nf(a.limit) +
              (a.resetUnix ? ' · обновится ' + new Date(a.resetUnix * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '') +
              '<div class="bar"><i style="width:' + (a.limit ? Math.round(a.left / a.limit * 100) : 0) + '%"></i></div>';
          acc.appendChild(row);
        });
        var need = needsWork().chars;
        if (need) acc.appendChild(h('p', { class: 'note' }, 'Для этого проекта нужно ещё ' + nf(need) + ' симв.'));
        var accBtns = h('div', { class: 'row' });
        accBtns.appendChild(h('button', { class: 'btn sm primary', type: 'button', onclick: function () { openKeyCheck(); } }, 'Проверить ключи'));
        accBtns.appendChild(h('button', { class: 'btn sm', type: 'button', onclick: function () { S.token = ''; S.quota = null; S.voices = null; lsSet('ozv.token', ''); paintQuota(); s.close(); toast('Вы вышли'); } }, 'Выйти'));
        acc.appendChild(accBtns);
      };
      paintAcc();
      loadQuota().then(paintAcc);
    }
    var s = sheet('Настройки', box);
    if (scrollToAcc) setTimeout(function () { accH.scrollIntoView({ block: 'start' }); }, 60);
  }

  $('btnMore').addEventListener('click', function () {
    var box = h('div', { class: 'list' });
    var s;
    function item(label, sub, fn) {
      box.appendChild(h('button', { class: 'li', type: 'button', onclick: function () { s.close(); fn(); } },
        '<span class="li-t"><b>' + label + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</span>'));
    }
    item('Проекты', S.projects.length + ' ' + plural(S.projects.length, 'проект', 'проекта', 'проектов'), openProjects);
    item('Импорт текста', 'Вставить диалог, .txt, .docx или открыть скачанную страницу', function () { openImport(); });
    item('Скачать', 'Страница со звуком, MP3 или текст', openExport);
    item('Настройки', 'Тема, пауза, качество, аккаунты ElevenLabs', function () { openSettings(); });
    item('Как это работает', null, openHelp);
    s = sheet('Меню', box);
  });

  function openHelp() {
    sheet('Как это работает', '<div class="note" style="font-size:14.5px;color:var(--ink);line-height:1.55">' +
      '<p><b>1. Текст.</b> Пишите прямо на листе: Enter — новая реплика у собеседника, Shift+Enter — перенос строки. Или вставьте готовый диалог: строки «Anna: Hallo! // Привет!» сами разойдутся по ролям и переводам.</p>' +
      '<p><b>2. Роли.</b> Нажмите на роль вверху и выберите голос из своего аккаунта или из библиотеки ElevenLabs. Цвет роли — это цвет её реплик.</p>' +
      '<p><b>3. Озвучка.</b> Красная кнопка внизу озвучивает всё, что ещё не озвучено. Точка у реплики: пустая — нет звука, жёлтая — текст или голос изменились, зелёная — готово.</p>' +
      '<p><b>4. Чтение.</b> В режиме «Чтение» нажатие на реплику проигрывает её, плеер внизу играет весь текст. Скорость 0,5–1,25×, повтор одной реплики, перевод можно скрыть.</p>' +
      '<p><b>5. Скачать.</b> Страница .html содержит и текст, и звук — работает без интернета, её можно отправить в Telegram. Открыв её здесь через «Импорт», вы получите проект обратно.</p>' +
      '<p class="muted">Всё хранится в этом браузере. Ключи ElevenLabs — только на сервере Vercel.</p></div>');
  }

  // ── старт ──────────────────────────────────────────────
  function boot() {
    applyTheme();
    var tk = lsGet('ozv.token', null);
    if (tk && tk.t && tk.exp > Date.now()) S.token = tk.t;
    if (prefs.tr === false) document.body.classList.add('oz-hide-tr');
    var trb = document.querySelector('.oz-trb');
    if (trb) { trb.classList.toggle('on', prefs.tr !== false); trb.setAttribute('aria-pressed', String(prefs.tr !== false)); }

    idb.all('projects').then(function (all) {
      S.projects = all.map(function (p) { return { id: p.id, title: p.title, updated: p.updated, lines: countLines(p) }; });
      if (!all.length) return addProject(demoProject());
      var last = all.filter(function (p) { return p.id === prefs.lastId; })[0] ||
        all.slice().sort(function (a, b) { return b.updated - a.updated; })[0];
      return openProject(last.id);
    }).then(function () {
      document.body.classList.toggle('no-tr-field', !S.proj.settings.showTr);
      loadQuota();
    }).catch(function (e) {
      document.getElementById('doc').innerHTML = '<div class="oz-sheet"><p>Хранилище браузера недоступно: ' + esc(e.message) +
        '</p><p class="muted">Приватный режим или запрет сайта на хранение данных. Откройте страницу в обычной вкладке.</p></div>';
    });

    // перед уходом — дописать отложенное сохранение
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') saveNow(); });
    window.addEventListener('pagehide', function () { saveNow(); });
  }
  boot();
})();
