/* reader.js — общий движок для приложения и для скачанной страницы.
 *   OzText   — очистка разметки, простой текст, скрытие [тегов] v3
 *   OzRender — отрисовка «листа» для чтения
 *   OzPlayer — последовательное воспроизведение реплик, подсветка, скорость, повтор
 *   OzBar    — нижний плеер
 * Без зависимостей. Встраивается в экспорт как есть.
 */
(function (root) {
  'use strict';

  // ── текст ────────────────────────────────────────────────
  var ALLOWED = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', MARK: 'mark', S: 's', STRIKE: 's', BR: 'br', SUB: 'sub', SUP: 'sup' };
  var BLOCKY = { DIV: 1, P: 1, LI: 1, H1: 1, H2: 1, H3: 1, H4: 1 };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Разрешены только b/i/u/mark/s/br/sub/sup — без атрибутов.
  // Всё прочее (span со стилями из буфера обмена, div и т.п.) разворачивается в текст.
  function sanitize(html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    var out = '';
    (function walk(node) {
      for (var n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) { out += esc(n.nodeValue); continue; }
        if (n.nodeType !== 1) continue;
        var tag = ALLOWED[n.tagName];
        if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') continue;
        if (tag === 'br') { out += '<br>'; continue; }
        // «жирный» из Word/Docs часто приходит как span style=font-weight:700
        if (!tag && n.tagName === 'SPAN' && n.style) {
          var fw = n.style.fontWeight;
          if (fw === 'bold' || +fw >= 600) tag = 'b';
          else if (n.style.fontStyle === 'italic') tag = 'i';
        }
        if (BLOCKY[n.tagName] && out && !/<br>$/.test(out)) out += '<br>';
        if (tag) { out += '<' + tag + '>'; walk(n); out += '</' + tag + '>'; }
        else walk(n);
      }
    })(tpl.content);
    return out
      .replace(/(<br>)+$/, '')
      .replace(/<(b|i|u|mark|s|sub|sup)><\/\1>/g, '');
  }

  function plain(html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = String(html || '').replace(/<br\s*\/?>/gi, '\n');
    return (tpl.content.textContent || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  }

  // [laughs], [whispers] — теги интонации v3: в модель уходят, читателю не видны
  var TAG_RE = /\[[a-zA-Z][a-zA-Z \-']{0,30}\]\s*/g;
  function hideTags(html) {
    return String(html || '').replace(/(^|>)([^<]*)/g, function (m, a, t) { return a + t.replace(TAG_RE, ''); });
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ── отрисовка листа ─────────────────────────────────────
  // doc: { title, roles:[{id,name,color,narrator}], blocks:[{id,type,roleId,html,tr}], settings:{hideTags} }
  // hasAudio(block) → true/false
  function render(rootEl, doc, hasAudio) {
    var roles = {};
    (doc.roles || []).forEach(function (r) { roles[r.id] = r; });
    var hide = !doc.settings || doc.settings.hideTags !== false;
    var html = '<article class="oz-sheet">';
    if (doc.title) html += '<h1 class="oz-title">' + esc(doc.title) + '</h1>';
    var prevRole = null;
    (doc.blocks || []).forEach(function (b) {
      if (b.type === 'heading') {
        html += '<h2 class="oz-h" data-id="' + esc(b.id) + '">' + esc(plain(b.html)) + '</h2>';
        prevRole = null;
        return;
      }
      var r = roles[b.roleId] || { name: '', color: '#888' };
      var body = hide ? hideTags(b.html) : b.html;
      var cls = 'oz-line' + (r.narrator ? ' is-narrator' : '') + (prevRole === b.roleId ? ' same-who' : '') +
        (hasAudio(b) ? '' : ' no-audio');
      html += '<div class="' + cls + '" data-id="' + esc(b.id) + '" style="--c:' + esc(r.color) + '"' +
        (hasAudio(b) ? ' tabindex="0" role="button"' : '') + '>' +
        (r.narrator ? '' : '<span class="oz-who">' + esc(r.name) + '</span>') +
        '<div class="oz-text">' + body + '</div>' +
        (b.tr ? '<span class="oz-tr">' + esc(b.tr) + '</span>' : '') +
        '</div>';
      prevRole = b.roleId;
    });
    html += '</article>';
    rootEl.innerHTML = html;
  }

  // ── плеер ───────────────────────────────────────────────
  /* o = {
   *   items: () => [{ id, dur, name, color }]   — только реплики со звуком, по порядку
   *   src:   (id) => Promise<url> | url
   *   el:    (id) => HTMLElement | null         — что подсвечивать
   *   gap:   () => мс паузы между репликами
   *   title: () => заголовок для экрана блокировки
   *   onChange: () => {}                        — обновить кнопки/время
   * } */
  function Player(o) {
    var self = this;
    this.o = o;
    this.a = new Audio();
    this.a.preload = 'auto';
    this.idx = -1;
    this.list = [];
    this.playing = false;
    this.one = false;          // играть только одну реплику
    this.loop = false;         // повторять текущую
    this.rate = 1;
    this._gapT = null;
    this._raf = 0;
    this._token = 0;

    var a = this.a;
    a.addEventListener('ended', function () { self._ended(); });
    a.addEventListener('loadedmetadata', function () {
      var it = self.list[self.idx];
      if (it && isFinite(a.duration) && a.duration > 0 && Math.abs((it.dur || 0) - a.duration) > .05) {
        it.dur = a.duration;
        if (o.onDuration) o.onDuration(it.id, a.duration);
      }
      self._emit();
    });
    a.addEventListener('pause', function () { if (!a.ended && !self._switching) { self.playing = false; self._stopRaf(); self._emit(); } });
    a.addEventListener('play', function () { self._switching = false; self.playing = true; self._startRaf(); self._emit(); });
    a.addEventListener('error', function () {
      if (!a.src) return;
      self._switching = false;
      self.playing = false; self._stopRaf(); self._emit();
      if (o.onError) o.onError(self.list[self.idx]);
    });

    if ('mediaSession' in navigator) {
      var ms = navigator.mediaSession;
      try {
        ms.setActionHandler('play', function () { self.toggle(true); });
        ms.setActionHandler('pause', function () { self.toggle(false); });
        ms.setActionHandler('nexttrack', function () { self.step(1); });
        ms.setActionHandler('previoustrack', function () { self.step(-1); });
      } catch (e) {}
    }
  }

  Player.prototype = {
    refresh: function () {
      var curId = this.list[this.idx] && this.list[this.idx].id;
      this.list = this.o.items() || [];
      this.idx = -1;
      for (var i = 0; i < this.list.length; i++) if (this.list[i].id === curId) this.idx = i;
      this._emit();
    },
    indexOf: function (id) {
      for (var i = 0; i < this.list.length; i++) if (this.list[i].id === id) return i;
      return -1;
    },
    current: function () { return this.list[this.idx] || null; },

    // Главная точка входа: сыграть реплику i. one=true — только её.
    playAt: function (i, one) {
      var self = this;
      if (i < 0 || i >= this.list.length) { this.stop(); return; }
      clearTimeout(this._gapT);
      this.one = !!one;
      this._mark(false);
      this.idx = i;
      var it = this.list[i];
      var my = ++this._token;
      this._switching = true;
      Promise.resolve(this.o.src(it.id)).then(function (url) {
        if (my !== self._token) return;
        if (!url) { self._switching = false; self.step(1); return; }
        self.a.src = url;
        self.a.playbackRate = self.rate;
        try { self.a.preservesPitch = true; } catch (e) {}
        self._mark(true);
        self._meta(it);
        var p = self.a.play();
        if (p && p.catch) p.catch(function () { self._switching = false; self.playing = false; self._emit(); });
      });
    },
    playId: function (id, one) {
      this.refresh();
      var i = this.indexOf(id);
      if (i < 0) return;
      // повторное нажатие на звучащую реплику — пауза/продолжить
      if (i === this.idx && this.a.src && !this.a.ended) { this.toggle(); return; }
      this.playAt(i, one);
    },
    toggle: function (force) {
      var want = force == null ? !this.playing : force;
      if (want) {
        if (this.idx < 0 || !this.a.src) { this.refresh(); this.playAt(Math.max(0, this.idx), false); return; }
        if (this.a.ended) { this.playAt(this.idx, this.one); return; }
        this.one = false;         // «Играть» в плеере — дальше по тексту
        var p = this.a.play();
        if (p && p.catch) p.catch(function () {});
      } else {
        clearTimeout(this._gapT);
        this.a.pause();
        this.playing = false;
        this._emit();
      }
    },
    step: function (d) {
      if (!this.list.length) return;
      // «назад» в первые 2 секунды — предыдущая реплика, иначе — начало текущей
      if (d < 0 && this.a.currentTime > 2 && this.idx >= 0) { this.a.currentTime = 0; return; }
      var n = this.idx + d;
      if (n < 0) n = 0;
      if (n >= this.list.length) { this.stop(); return; }
      this.playAt(n, false);
    },
    stop: function () {
      clearTimeout(this._gapT);
      this._switching = false;
      this._token++;
      this.a.pause();
      this._mark(false);
      this.playing = false;
      this._stopRaf();
      this._emit();
    },
    setRate: function (r) {
      this.rate = r;
      this.a.playbackRate = r;
      this._emit();
    },
    total: function () {
      var t = 0;
      this.list.forEach(function (it) { t += it.dur || 0; });
      return t;
    },
    elapsed: function () {
      var t = 0;
      for (var i = 0; i < this.idx; i++) t += this.list[i].dur || 0;
      return t + (this.idx >= 0 ? this.a.currentTime || 0 : 0);
    },
    // перемотка по всей записи: доля 0..1 → реплика + позиция
    seekFrac: function (f) {
      this.refresh();
      var target = f * this.total(), acc = 0;
      for (var i = 0; i < this.list.length; i++) {
        var d = this.list[i].dur || 0;
        if (acc + d >= target || i === this.list.length - 1) {
          var off = Math.max(0, target - acc), self = this;
          if (i === this.idx && this.a.src) { this.a.currentTime = off; if (!this.playing) this.toggle(true); }
          else {
            this.playAt(i, false);
            var once = function () { self.a.removeEventListener('loadedmetadata', once); try { self.a.currentTime = off; } catch (e) {} };
            this.a.addEventListener('loadedmetadata', once);
          }
          return;
        }
        acc += d;
      }
    },

    _ended: function () {
      var self = this;
      this._stopRaf();
      this._paint(1);
      if (this.loop) { this.a.currentTime = 0; this.a.play(); return; }
      if (this.one || this.idx >= this.list.length - 1) {
        this.playing = false;
        this._mark(false);
        if (this.idx >= this.list.length - 1 && !this.one) this.idx = -1;
        this._emit();
        return;
      }
      var gap = Math.max(0, +(this.o.gap && this.o.gap()) || 0) / this.rate;
      this.playing = true;
      this._gapT = setTimeout(function () { self.playAt(self.idx + 1, false); }, gap);
    },
    _mark: function (on) {
      var it = this.list[this.idx];
      var el = it && this.o.el(it.id);
      if (!el) return;
      el.classList.toggle('is-playing', on);
      el.style.setProperty('--p', '0');
      if (on && root.OzPlayerAutoScroll !== false) {
        var r = el.getBoundingClientRect();
        var barH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar-h')) || 110;
        if (r.top < 70 || r.bottom > innerHeight - barH - 20) {
          var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
          el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
        }
      }
    },
    _paint: function (p) {
      var it = this.list[this.idx];
      var el = it && this.o.el(it.id);
      if (el) el.style.setProperty('--p', p.toFixed(4));
    },
    _startRaf: function () {
      var self = this;
      this._stopRaf();
      (function loop() {
        var d = self.a.duration;
        if (d && isFinite(d)) self._paint(self.a.currentTime / d);
        if (self.o.onTick) self.o.onTick();
        self._raf = requestAnimationFrame(loop);
      })();
    },
    _stopRaf: function () { cancelAnimationFrame(this._raf); this._raf = 0; },
    _meta: function (it) {
      if (!('mediaSession' in navigator) || !root.MediaMetadata) return;
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: it.text ? it.text.slice(0, 80) : (it.name || ''),
          artist: it.name || '',
          album: (this.o.title && this.o.title()) || 'ОЗВУЧКА'
        });
      } catch (e) {}
    },
    _emit: function () { if (this.o.onChange) this.o.onChange(); }
  };

  // ── нижний плеер ────────────────────────────────────────
  var I = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="2.6" height="14" rx="1"/><path d="M19 6.2v11.6a1 1 0 0 1-1.52.85L9.4 13.7a1 1 0 0 1 0-1.7l8.08-4.95A1 1 0 0 1 19 6.2z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><rect x="16.4" y="5" width="2.6" height="14" rx="1"/><path d="M5 6.2v11.6a1 1 0 0 0 1.52.85l8.08-4.95a1 1 0 0 0 0-1.7L6.52 7.05A1 1 0 0 0 5 6.2z"/></svg>',
    loop: '<svg viewBox="0 0 24 24"><path d="M7 7h9.2l-1.6-1.6L16 4l4 4-4 4-1.4-1.4L16.2 9H7a3 3 0 0 0-3 3v1H2v-1a5 5 0 0 1 5-5zm10 10H7.8l1.6 1.6L8 20l-4-4 4-4 1.4 1.4L7.8 15H17a3 3 0 0 0 3-3v-1h2v1a5 5 0 0 1-5 5z"/><text x="12" y="14.6" font-size="7" text-anchor="middle" font-family="sans-serif" font-weight="700">1</text></svg>',
    tr: '<svg viewBox="0 0 24 24"><path d="M4 5h9v2H9.9c-.4 2-1.3 3.8-2.5 5.3 1 .9 2.1 1.6 3.3 2.1l-.8 1.9c-1.4-.6-2.7-1.4-3.9-2.5-1.1 1-2.4 1.9-3.8 2.5l-.8-1.9c1.2-.5 2.3-1.2 3.2-2A12 12 0 0 1 2.9 9h2.2c.4 1.1 1 2.1 1.7 3 .8-1.1 1.4-2.4 1.7-5H4V5zm12.1 5h2.2l3.9 10h-2.2l-.9-2.4h-3.8l-.9 2.4h-2.2l3.9-10zm-.1 5.8h2.4L17.2 12.5 16 15.8z"/></svg>'
  };
  var RATES = [1, 1.25, 0.75, 0.5];

  function Bar(host, player, opts) {
    opts = opts || {};
    var el = document.createElement('div');
    el.className = 'oz-bar';
    el.innerHTML =
      '<div class="oz-bar-in">' +
        '<div class="oz-now" aria-live="polite"></div>' +
        '<div class="oz-prog"><span class="oz-t1">0:00</span>' +
          '<div class="oz-track" role="slider" aria-label="Позиция" tabindex="0"><div class="oz-fill"></div><div class="oz-ticks"></div></div>' +
          '<span class="oz-t2">0:00</span></div>' +
        '<div class="oz-left">' +
          '<button class="oz-b txt oz-rate" type="button" title="Скорость">1×</button>' +
          '<button class="oz-b oz-loop" type="button" title="Повторять реплику" aria-pressed="false">' + I.loop + '</button>' +
        '</div>' +
        '<div class="oz-mid">' +
          '<button class="oz-b oz-prev" type="button" title="Назад">' + I.prev + '</button>' +
          '<button class="oz-b big oz-play" type="button" title="Играть">' + I.play + '</button>' +
          '<button class="oz-b oz-next" type="button" title="Дальше">' + I.next + '</button>' +
        '</div>' +
        '<div class="oz-right">' +
          (opts.translation ? '<button class="oz-b oz-trb on" type="button" title="Перевод" aria-pressed="true">' + I.tr + '</button>' : '') +
          (opts.extra || '') +
        '</div>' +
      '</div>';
    host.appendChild(el);

    var q = function (s) { return el.querySelector(s); };
    var bPlay = q('.oz-play'), fill = q('.oz-fill'), t1 = q('.oz-t1'), t2 = q('.oz-t2'),
        now = q('.oz-now'), track = q('.oz-track'), ticks = q('.oz-ticks'), bRate = q('.oz-rate'), bLoop = q('.oz-loop');

    bPlay.onclick = function () { player.toggle(); };
    q('.oz-prev').onclick = function () { player.step(-1); };
    q('.oz-next').onclick = function () { player.step(1); };
    bRate.onclick = function () {
      var i = RATES.indexOf(player.rate);
      player.setRate(RATES[(i + 1) % RATES.length]);
      if (opts.onRate) opts.onRate(player.rate);
    };
    bLoop.onclick = function () { player.loop = !player.loop; paint(); };
    var trb = q('.oz-trb');
    if (trb) trb.onclick = function () {
      var hidden = document.body.classList.toggle('oz-hide-tr');
      trb.classList.toggle('on', !hidden);
      trb.setAttribute('aria-pressed', String(!hidden));
      if (opts.onTr) opts.onTr(!hidden);
    };

    function seekAt(x) {
      var r = track.getBoundingClientRect();
      player.seekFrac(Math.min(1, Math.max(0, (x - r.left) / r.width)));
    }
    track.addEventListener('pointerdown', function (e) { seekAt(e.clientX); });
    track.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') player.step(1);
      if (e.key === 'ArrowLeft') player.step(-1);
    });

    var lastTicks = '';
    function paintTicks() {
      var tot = player.total(), acc = 0, key = player.list.length + ':' + Math.round(tot);
      if (key === lastTicks) return;
      lastTicks = key;
      var h = '';
      if (tot > 0 && player.list.length < 120) {
        for (var i = 0; i < player.list.length - 1; i++) {
          acc += player.list[i].dur || 0;
          h += '<i style="left:' + (acc / tot * 100).toFixed(2) + '%"></i>';
        }
      }
      ticks.innerHTML = h;
    }

    function tick() {
      var tot = player.total(), el2 = player.elapsed();
      fill.style.width = (tot ? Math.min(100, el2 / tot * 100) : 0) + '%';
      t1.textContent = fmtTime(el2);
      t2.textContent = fmtTime(tot);
    }

    function paint() {
      bPlay.innerHTML = player.playing ? I.pause : I.play;
      bPlay.title = player.playing ? 'Пауза' : 'Играть';
      bRate.textContent = String(player.rate).replace('.', ',') + '×';
      bRate.classList.toggle('on', player.rate !== 1);
      bLoop.classList.toggle('on', player.loop);
      bLoop.setAttribute('aria-pressed', String(player.loop));
      var it = player.current();
      if (it) {
        el.style.setProperty('--nowc', it.color || 'inherit');
        now.innerHTML = '<b>' + esc(it.name || '') + '</b>' + (it.name ? ' · ' : '') + esc((it.text || '').slice(0, 120));
      } else {
        now.textContent = player.list.length ? (opts.idle || 'Нажмите на реплику или ▶') : (opts.empty || 'Озвученных реплик пока нет');
      }
      paintTicks();
      tick();
    }

    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName))) return;
      if (e.code === 'Space' && !(t && t.tagName === 'BUTTON')) { e.preventDefault(); player.toggle(); }
    });

    return { el: el, paint: paint, tick: tick };
  }

  root.OzText = { esc: esc, sanitize: sanitize, plain: plain, hideTags: hideTags, fmtTime: fmtTime };
  root.OzRender = { doc: render };
  root.OzPlayer = Player;
  root.OzBar = Bar;
})(window);
