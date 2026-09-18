/* install.js — предложение установки PWA + регистрация service worker.
   Основа — install.js из Fahrzeit, адаптировано для ОЗВУЧКИ:
   язык по устройству (ru / uk / de / en), иконка приложения, тёмная тема через html.dark,
   баннер прячется на время игры (window.ozvInstall.hide()).

   Подключается перед console.js:  <script src="install.js"></script>
   Баннер показывается только там, где у <body> стоит data-install="banner".

   Отладка через console.js:
     localStorage.removeItem('ozv.installDismissed')  — вернуть баннер
     localStorage.setItem('ozv.installDebug','1')     — показывать всегда
*/
(function () {
  'use strict';

  var log = function () {
    try { console.log.apply(console, ['[pwa]'].concat([].slice.call(arguments))); } catch (e) {}
  };

  // ── service worker ────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(function () { log('service worker готов'); })
        .catch(function (e) { log('service worker не встал:', e.message); });
    });
  }

  // Заглушка, чтобы страница могла звать hide() даже если баннера нет
  window.ozvInstall = { hide: function () {} };

  if (document.body.dataset.install !== 'banner') {
    log('баннер на этой странице выключен');
    return;
  }

  // ── тексты ────────────────────────────────────────────────
  var I18N = {
    ru: {
      title: 'Установить ОЗВУЧКУ', close: 'Закрыть', ok: 'Понятно', how: 'Как?', install: 'Установить',
      subDefault: 'Добавить на главный экран', subPrompt: 'На весь экран, без адресной строки',
      subIos: 'Через кнопку «Поделиться» в Safari', subManual: 'Через меню браузера',
      iosTitle: 'Установка на iPhone', androidTitle: 'Установка на Android',
      ios: ['Нажмите внизу Safari <b>Поделиться</b> <span style="font-size:1.15em">&#x2934;</span>',
            'Выберите <b>На экран «Домой»</b>',
            'Нажмите вверху справа <b>Добавить</b>'],
      android: ['Откройте меню браузера <b>⋮</b> вверху справа',
                'Выберите <b>Установить приложение</b> или <b>Добавить на главный экран</b>',
                'Подтвердите — <b>Установить</b>']
    },
    uk: {
      title: 'Встановити ОЗВУЧКУ', close: 'Закрити', ok: 'Зрозуміло', how: 'Як?', install: 'Встановити',
      subDefault: 'Додати на головний екран', subPrompt: 'На весь екран, без адресного рядка',
      subIos: 'Через кнопку «Поділитися» в Safari', subManual: 'Через меню браузера',
      iosTitle: 'Встановлення на iPhone', androidTitle: 'Встановлення на Android',
      ios: ['Натисніть внизу Safari <b>Поділитися</b> <span style="font-size:1.15em">&#x2934;</span>',
            'Оберіть <b>На початковий екран</b>',
            'Натисніть угорі праворуч <b>Додати</b>'],
      android: ['Відкрийте меню браузера <b>⋮</b> угорі праворуч',
                'Оберіть <b>Встановити застосунок</b> або <b>Додати на головний екран</b>',
                'Підтвердіть — <b>Встановити</b>']
    },
    de: {
      title: 'ОЗВУЧКА installieren', close: 'Schließen', ok: 'Verstanden', how: 'Wie?', install: 'Installieren',
      subDefault: 'Zum Startbildschirm hinzufügen', subPrompt: 'Vollbild, ohne Adressleiste',
      subIos: 'Über den Teilen-Button in Safari', subManual: 'Über das Browser-Menü',
      iosTitle: 'Installation auf dem iPhone', androidTitle: 'Installation auf Android',
      ios: ['Tippe unten in Safari auf <b>Teilen</b> <span style="font-size:1.15em">&#x2934;</span>',
            'Wähle <b>Zum Home-Bildschirm</b>',
            'Tippe oben rechts auf <b>Hinzufügen</b>'],
      android: ['Öffne das Browser-Menü <b>⋮</b> oben rechts',
                'Wähle <b>App installieren</b> oder <b>Zum Startbildschirm zufügen</b>',
                'Bestätige mit <b>Installieren</b>']
    },
    en: {
      title: 'Install ОЗВУЧКА', close: 'Close', ok: 'Got it', how: 'How?', install: 'Install',
      subDefault: 'Add to home screen', subPrompt: 'Full screen, no address bar',
      subIos: 'Via the Share button in Safari', subManual: 'Via the browser menu',
      iosTitle: 'Install on iPhone', androidTitle: 'Install on Android',
      ios: ['Tap <b>Share</b> <span style="font-size:1.15em">&#x2934;</span> at the bottom of Safari',
            'Choose <b>Add to Home Screen</b>',
            'Tap <b>Add</b> in the top right'],
      android: ['Open the browser menu <b>⋮</b> in the top right',
                'Choose <b>Install app</b> or <b>Add to Home screen</b>',
                'Confirm with <b>Install</b>']
    }
  };
  var T = I18N.en;
  var langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
  for (var i = 0; i < langs.length; i++) {
    var code = String(langs[i]).slice(0, 2).toLowerCase();
    if (I18N[code]) { T = I18N[code]; break; }
  }

  var DEBUG = false;
  try { DEBUG = localStorage.getItem('ozv.installDebug') === '1'; } catch (e) {}

  // Уже установлено — ничего не показываем
  var standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches
    || window.navigator.standalone === true;
  if (standalone && !DEBUG) { log('уже запущено как приложение'); return; }

  // Закрыл крестиком — не надоедаем неделю
  var DISMISS_KEY = 'ozv.installDismissed';
  var WEEK = 7 * 24 * 60 * 60 * 1000;
  if (!DEBUG) {
    try {
      var d = localStorage.getItem(DISMISS_KEY);
      if (d && Date.now() - parseInt(d, 10) < WEEK) {
        var left = Math.ceil((WEEK - (Date.now() - parseInt(d, 10))) / 86400000);
        log('баннер скрыт, ты закрыл его: осталось дней ' + left +
            '. Сброс: localStorage.removeItem("' + DISMISS_KEY + '")');
        return;
      }
    } catch (e) {}
  }

  // ── стили ─────────────────────────────────────────────────
  var DARK = 'html.dark ';
  var css = document.createElement('style');
  css.textContent = [
    '.uz-install{',
    '  position:fixed;left:12px;right:12px;z-index:500;',
    '  top:calc(env(safe-area-inset-top,0px) + 62px);',
    '  display:none;align-items:center;gap:12px;box-sizing:border-box;',
    '  max-width:500px;margin:0 auto;',
    '  background:rgba(255,255,255,.92);color:#1a1a1a;',
    '  -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);',
    '  border:1px solid rgba(0,0,0,.08);border-radius:18px;padding:12px 14px;',
    '  box-shadow:0 10px 34px rgba(0,0,0,.28);',
    '  font-family:Tahoma,sans-serif;',
    '  transform:translateY(160%);transition:transform .42s cubic-bezier(.32,1,.23,1);',
    '}',
    DARK + '.uz-install{background:rgba(30,30,30,.94);color:#e1e1e1;border-color:rgba(255,255,255,.12);}',
    '.uz-install.show{display:flex;transform:translateY(0);}',
    '.uz-ic{flex:none;width:38px;height:38px;border-radius:10px;overflow:hidden;}',
    '.uz-ic img{width:100%;height:100%;display:block;}',
    '.uz-tx{flex:1;min-width:0;}',
    '.uz-t{font-size:14.5px;font-weight:600;line-height:1.25;}',
    '.uz-s{font-size:11.5px;opacity:.6;margin-top:2px;line-height:1.3;}',
    '.uz-btn{flex:none;width:auto;height:auto;margin:0;padding:9px 15px;border:0;border-radius:12px;',
    '  background:#2ecc71;color:#fff;font-family:inherit;font-size:13px;',
    '  font-weight:600;cursor:pointer;display:block;}',
    '.uz-x{flex:none;width:26px;height:26px;margin:0;padding:0;border:0;background:none;',
    '  color:inherit;opacity:.45;font-size:15px;cursor:pointer;display:grid;place-items:center;}',
    '.uz-ov{position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.62);',
    '  display:flex;align-items:flex-end;justify-content:center;padding:14px;',
    '  box-sizing:border-box;font-family:Tahoma,sans-serif;}',
    '.uz-sheet{background:#fff;color:#1a1a1a;border-radius:22px;padding:22px;',
    '  width:100%;max-width:480px;box-sizing:border-box;',
    '  margin-bottom:env(safe-area-inset-bottom,0px);}',
    DARK + '.uz-sheet{background:#1e1e1e;color:#e1e1e1;}',
    '.uz-sheet h3{font-size:17px;font-weight:600;text-align:center;margin:0 0 18px;}',
    '.uz-step{display:flex;align-items:center;gap:12px;margin-bottom:13px;font-size:14px;line-height:1.35;opacity:.85;}',
    '.uz-n{width:32px;height:32px;flex:none;border-radius:10px;background:#2ecc71;',
    '  color:#fff;display:grid;place-items:center;font-weight:700;font-size:14px;}',
    '.uz-ok{width:100%;margin-top:8px;padding:13px;border:0;border-radius:14px;',
    '  background:#2ecc71;color:#fff;font-family:inherit;font-size:15px;',
    '  font-weight:600;cursor:pointer;display:block;}'
  ].join('\n');
  document.head.appendChild(css);

  // ── баннер ────────────────────────────────────────────────
  var bar = document.createElement('div');
  bar.className = 'uz-install';
  bar.innerHTML =
    '<div class="uz-ic"><img src="/icons/icon-192.png" alt=""></div>' +
    '<div class="uz-tx">' +
      '<div class="uz-t"></div>' +
      '<div class="uz-s" id="uz-sub"></div>' +
    '</div>' +
    '<button class="uz-btn" id="uz-go" type="button"></button>' +
    '<button class="uz-x" id="uz-x" type="button">✕</button>';
  document.body.appendChild(bar);

  var $ = function (id) { return document.getElementById(id); };
  bar.querySelector('.uz-t').textContent = T.title;
  $('uz-sub').textContent = T.subDefault;
  $('uz-go').textContent = T.install;
  $('uz-x').setAttribute('aria-label', T.close);

  var blocked = false;   // во время игры баннер не показываем
  var pending = false;   // хотели показать, пока шла игра
  var show = function () {
    if (blocked) { pending = true; return; }
    requestAnimationFrame(function () { bar.classList.add('show'); });
  };
  var hide = function () { bar.classList.remove('show'); };

  window.ozvInstall = {
    hide: function () {
      blocked = true;
      if (bar.classList.contains('show')) { pending = true; hide(); }
    },
    resume: function () {
      blocked = false;
      if (pending) { pending = false; show(); }
    }
  };

  $('uz-x').onclick = function () {
    hide();
    pending = false;
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) {}
    log('баннер закрыт на неделю');
  };

  // ── платформа ─────────────────────────────────────────────
  var ua = navigator.userAgent;
  var isIOS = /iphone|ipad|ipod/i.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (isIOS) {
    // На iPhone установка возможна только из Safari
    var isSafari = /safari/i.test(ua) && !/crios|fxios|edgios|opios|chrome/i.test(ua);
    if (!isSafari && !DEBUG) {
      log('iOS, но не Safari — установить нельзя, баннер не показываем');
      return;
    }
    $('uz-sub').textContent = T.subIos;
    $('uz-go').textContent = T.how;
    $('uz-go').onclick = function () { guide('ios'); };
    setTimeout(show, 2000);
    log('iOS Safari — показываем инструкцию');
    return;
  }

  // ── Android / desktop Chrome ──────────────────────────────
  var deferred = null;
  var fired = false;

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    fired = true;
    deferred = e;
    log('предложение установки получено');
    $('uz-sub').textContent = T.subPrompt;
    $('uz-go').textContent = T.install;
    $('uz-go').onclick = function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.then(function (r) {
        log('выбор пользователя:', r && r.outcome);
        deferred = null;
        hide();
      });
    };
    setTimeout(show, 1500);
  });

  // Firefox, Samsung Internet и прочие не присылают beforeinstallprompt —
  // им показываем ручную инструкцию, а не молчим.
  setTimeout(function () {
    if (fired) return;
    log('браузер не прислал beforeinstallprompt — показываем ручную инструкцию');
    $('uz-sub').textContent = T.subManual;
    $('uz-go').textContent = T.how;
    $('uz-go').onclick = function () { guide('android'); };
    show();
  }, 5000);

  window.addEventListener('appinstalled', function () {
    hide();
    pending = false;
    try { localStorage.removeItem(DISMISS_KEY); } catch (e) {}
    log('установлено');
  });

  // ── инструкция ────────────────────────────────────────────
  function guide(platform) {
    var steps = platform === 'ios' ? T.ios : T.android;
    var title = platform === 'ios' ? T.iosTitle : T.androidTitle;

    var ov = document.createElement('div');
    ov.className = 'uz-ov';
    ov.innerHTML =
      '<div class="uz-sheet">' +
        '<h3>' + title + '</h3>' +
        steps.map(function (t, i) {
          return '<div class="uz-step"><div class="uz-n">' + (i + 1) + '</div><div>' + t + '</div></div>';
        }).join('') +
        '<button class="uz-ok" type="button">' + T.ok + '</button>' +
      '</div>';
    document.body.appendChild(ov);
    ov.querySelector('.uz-ok').onclick = function () { ov.remove(); };
    ov.onclick = function (e) { if (e.target === ov) ov.remove(); };
  }
})();
