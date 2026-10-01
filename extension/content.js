// Injected into every web page opened in the Stream Frame profile:
//  - an auto-hiding Home button that returns to the start page,
//  - the controller mapper (keyboard events + Gamepad API) that drives the player,
//  - the Home confirmation overlay and a small on-screen display for feedback,
//  - the "open this link?" prompt for links sent from a phone while a video plays.
// UI lives in a closed shadow root promoted to the top layer, so site CSS cannot
// restyle it and it stays visible above element fullscreen.
(function () {
  'use strict';
  const SF = globalThis.StreamFrame;
  if (!SF || window.top !== window) return;

  const HOME_BUTTON_IDLE_MS = 3000;
  const CONFIRM_REPRESS_MS = 3000;
  const HOLD_MS = 700;
  const LINK_PROMPT_MS = 30000;
  // Buttons that accept a link prompt; anything else declines it.
  const LINK_YES = new Set(['btn:0', 'key:Enter', 'key:NumpadEnter', 'key:Space']);

  let controls = SF.normalizeControls(null);
  let pressMap = new Map(); // binding id -> action
  let holdMap = new Map(); // base binding id -> action (for ":hold" bindings)

  function rebuildMaps() {
    pressMap = new Map();
    holdMap = new Map();
    for (const a of SF.ACTIONS) {
      for (const b of controls.bindings[a.id] || []) {
        if (SF.isHold(b)) holdMap.set(SF.baseBinding(b), a.id);
        else pressMap.set(b, a.id);
      }
    }
  }
  rebuildMaps();

  SF.loadSettings()
    .then((s) => {
      controls = s.controls;
      rebuildMaps();
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.controls) {
      controls = SF.normalizeControls(changes.controls.newValue);
      rebuildMaps();
    }
  });

  // ---------- overlay UI ----------

  let host, root, homeBtn, osdEl, confirmEl, confirmTitle, confirmHint, confirmBar;
  let homeBtnTimer = 0;
  let osdTimer = 0;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, 'Segoe UI', Roboto, 'DejaVu Sans', sans-serif; }
    .home {
      position: fixed; left: 28px; bottom: 28px; width: 64px; height: 64px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.35); background: rgba(16,16,20,.78); color: #fff;
      display: grid; place-items: center; cursor: pointer; pointer-events: auto;
      opacity: 0; transform: scale(.9); transition: opacity .35s, transform .35s;
      box-shadow: 0 6px 24px rgba(0,0,0,.5);
    }
    .home.visible { opacity: 1; transform: none; }
    .home:not(.visible) { pointer-events: none; }
    .home:hover, .home:focus-visible { background: rgba(40,40,52,.92); outline: 3px solid #66c0f4; outline-offset: 3px; }
    .home svg { width: 30px; height: 30px; }
    .osd {
      position: fixed; top: 48px; left: 50%; transform: translateX(-50%);
      padding: 14px 28px; border-radius: 14px; background: rgba(16,16,20,.82); color: #fff;
      font-size: 28px; font-weight: 600; letter-spacing: .01em; opacity: 0; transition: opacity .25s;
      pointer-events: none; white-space: nowrap;
    }
    .osd.visible { opacity: 1; }
    .confirm-wrap {
      position: fixed; inset: 0; display: none; place-items: center; background: rgba(0,0,0,.55);
      pointer-events: auto;
    }
    .confirm-wrap.open { display: grid; }
    .confirm {
      min-width: 440px; padding: 32px 36px 28px; border-radius: 20px; background: #1b1d24; color: #fff;
      box-shadow: 0 20px 60px rgba(0,0,0,.6); text-align: center;
    }
    .confirm h2 { margin: 0 0 8px; font-size: 28px; font-weight: 700; }
    .confirm p { margin: 0 0 22px; font-size: 17px; color: #b8bcc8; }
    .confirm .bar { height: 4px; border-radius: 2px; background: #66c0f4; margin: 0 0 22px; transform-origin: left; }
    .confirm .bar.run { animation: shrink ${CONFIRM_REPRESS_MS}ms linear forwards; }
    @keyframes shrink { to { transform: scaleX(0); } }
    .confirm .row { display: flex; gap: 16px; justify-content: center; }
    .confirm button {
      min-width: 140px; padding: 16px 24px; border-radius: 12px; border: 0; font-size: 20px; font-weight: 600;
      cursor: pointer; color: #fff; background: #3a3f4c;
    }
    .confirm button.yes { background: #1a9fff; }
    .confirm button:hover, .confirm button:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
  `;

  const HOUSE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h5v-6h4v6h5V9.5"/></svg>';

  function buildUi() {
    if (host) return;
    host = document.createElement('stream-frame-overlay');
    // Neutralise UA popover styles and any site CSS aimed at unknown elements.
    host.style.cssText =
      'all:initial !important; position:fixed !important; inset:0 !important; width:100vw !important;' +
      'height:100vh !important; margin:0 !important; padding:0 !important; border:0 !important;' +
      'background:transparent !important; overflow:visible !important; pointer-events:none !important;' +
      'z-index:2147483647 !important; display:block !important;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>${CSS}</style>
      <button class="home" type="button" title="Stream Frame home" aria-label="Stream Frame home">${HOUSE_SVG}</button>
      <div class="osd" role="status" aria-live="polite"></div>
      <div class="confirm-wrap" role="dialog" aria-modal="true" aria-labelledby="sf-confirm-title">
        <div class="confirm">
          <h2 id="sf-confirm-title"></h2>
          <p class="hint"></p>
          <div class="bar"></div>
          <div class="row">
            <button class="yes" type="button">Yes</button>
            <button class="no" type="button">No</button>
          </div>
        </div>
      </div>`;
    homeBtn = root.querySelector('.home');
    osdEl = root.querySelector('.osd');
    confirmEl = root.querySelector('.confirm-wrap');
    confirmTitle = root.querySelector('h2');
    confirmHint = root.querySelector('.hint');
    confirmBar = root.querySelector('.bar');
    homeBtn.addEventListener('click', () => goHome());
    root.querySelector('.yes').addEventListener('click', () => confirmYes());
    root.querySelector('.no').addEventListener('click', () => closeConfirm());
    confirmEl.addEventListener('click', (e) => {
      if (e.target === confirmEl) closeConfirm();
    });
    attach();
    showHomeButton();
  }

  function attach() {
    if (!host.isConnected) document.documentElement.appendChild(host);
    raise();
  }

  // Put the overlay in the top layer (above element fullscreen). Re-showing moves it
  // to the top of the stack after the page enters fullscreen.
  function raise() {
    if (!host.showPopover) return;
    if (!host.hasAttribute('popover')) host.setAttribute('popover', 'manual');
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch (_) {
      /* not connected yet, or the site blocks it; z-index fallback applies */
    }
  }

  function ensureUi() {
    if (!document.documentElement) return false;
    buildUi();
    if (!host.isConnected) attach();
    return true;
  }

  function showHomeButton() {
    if (!ensureUi()) return;
    homeBtn.classList.add('visible');
    clearTimeout(homeBtnTimer);
    homeBtnTimer = setTimeout(() => homeBtn.classList.remove('visible'), HOME_BUTTON_IDLE_MS);
  }

  function showOsd(text) {
    if (!text || !ensureUi()) return;
    osdEl.textContent = text;
    osdEl.classList.add('visible');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => osdEl.classList.remove('visible'), 1200);
  }

  // ---------- Home + confirmation ----------

  // The open confirmation, if any:
  //   { kind: 'home', binding, since }  Home pressed: pressing it again confirms.
  //   { kind: 'link', respond, timer }  a link from a phone: A/Enter opens it.
  let confirm = null;

  function goHome() {
    location.href = SF.homeUrl();
  }

  function showConfirm(title, hint, durationMs) {
    confirmTitle.textContent = title;
    confirmHint.textContent = hint;
    confirmBar.style.animationDuration = durationMs + 'ms';
    confirmBar.classList.remove('run');
    void confirmBar.offsetWidth; // restart the animation
    confirmBar.classList.add('run');
    confirmEl.classList.add('open');
    raise();
  }

  function openConfirm(binding) {
    if (!ensureUi()) return goHome();
    if (confirm && confirm.kind === 'link') closeConfirm();
    confirm = { kind: 'home', binding: SF.baseBinding(binding), since: performance.now() };
    showConfirm(
      'Return to Stream Frame home?',
      `Press ${SF.bindingName(confirm.binding)} again to confirm, any other button to cancel.`,
      CONFIRM_REPRESS_MS
    );
  }

  // respond(answer) receives 'yes', 'no' or 'expired'.
  function openLinkPrompt(serviceName, respond) {
    if (!ensureUi()) return respond('yes');
    closeConfirm(); // a newer link replaces an unanswered one
    confirm = { kind: 'link', respond, timer: setTimeout(() => closeConfirm('expired'), LINK_PROMPT_MS) };
    showConfirm(
      `Open this ${serviceName} link?`,
      `Sent from your phone. Press ${SF.bindingName('btn:0')} or Enter to open it, any other button to keep watching.`,
      LINK_PROMPT_MS
    );
  }

  function closeConfirm(answer = 'no') {
    if (!confirm) return;
    const c = confirm;
    confirm = null;
    confirmEl.classList.remove('open');
    if (c.kind === 'link') {
      clearTimeout(c.timer);
      c.respond(answer);
    }
  }

  function confirmYes() {
    if (confirm && confirm.kind === 'link') closeConfirm('yes');
    else goHome();
  }

  const confirmOpen = () => confirm !== null;

  function confirmInput(binding) {
    const base = SF.baseBinding(binding);
    if (confirm.kind === 'link') {
      closeConfirm(LINK_YES.has(base) ? 'yes' : 'no');
    } else if (base === confirm.binding) {
      if (performance.now() - confirm.since <= CONFIRM_REPRESS_MS) goHome();
      else openConfirm(binding); // late re-press restarts the window
    } else {
      closeConfirm();
    }
  }

  // Links from a phone (background.js): ask first only if a video is playing.
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!msg || msg.type !== 'sf-link') return false;
    const v = SF.pickVideo();
    if (!v || v.paused || v.ended) {
      respond('no-video');
      return false;
    }
    openLinkPrompt(msg.serviceName || 'streaming', respond);
    chrome.runtime.sendMessage({ type: 'sf-link-prompting', id: msg.id }).catch(() => {});
    return true;
  });

  // ---------- dispatch ----------

  function trigger(action, binding) {
    if (action === 'home') {
      if (controls.homeConfirm) openConfirm(binding);
      else goHome();
      return true;
    }
    const r = SF.runMediaAction(action, controls);
    if (r.osd) showOsd(r.osd);
    return r.handled;
  }

  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && typeof e.data.__streamFrameOsd === 'string') showOsd(e.data.__streamFrameOsd);
  });

  // ---------- keyboard ----------

  const swallowedKeys = new Set();
  const holdTimers = new Map();

  function swallow(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    swallowedKeys.add(e.code);
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted) return; // ignore our own synthetic shortcut keys
      const binding = SF.bindingFromKeyEvent(e);
      if (confirmOpen()) {
        if (!e.repeat) confirmInput(binding);
        swallow(e);
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (SF.isTypingTarget(e.composedPath()[0])) return;

      const holdAction = holdMap.get(binding);
      if (holdAction && !e.repeat && !holdTimers.has(e.code)) {
        holdTimers.set(
          e.code,
          setTimeout(() => {
            holdTimers.delete(e.code);
            trigger(holdAction, binding + ':hold');
          }, HOLD_MS)
        );
      }

      const action = pressMap.get(binding);
      if (!action) return;
      if (e.repeat && !SF.REPEATABLE.has(action)) {
        swallow(e);
        return;
      }
      if (trigger(action, binding)) swallow(e);
    },
    true
  );

  window.addEventListener(
    'keyup',
    (e) => {
      if (!e.isTrusted) return;
      const t = holdTimers.get(e.code);
      if (t) {
        clearTimeout(t);
        holdTimers.delete(e.code);
      }
      if (swallowedKeys.delete(e.code)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );

  // ---------- gamepad ----------

  const padHoldTimers = new Map();
  const scroller = new SF.StickScroller();
  // Stick directions mapped to an action do not scroll.
  const mapped = (binding) => pressMap.has(binding) || holdMap.has(binding);

  new SF.GamepadWatcher({
    onPress(binding, { repeat, pad }) {
      if (confirmOpen()) {
        if (!repeat) confirmInput(binding);
        return;
      }
      if (SF.isTypingTarget()) return;
      const key = pad.index + '|' + binding;
      const holdAction = holdMap.get(binding);
      if (holdAction && !repeat && !padHoldTimers.has(key)) {
        padHoldTimers.set(
          key,
          setTimeout(() => {
            padHoldTimers.delete(key);
            trigger(holdAction, binding + ':hold');
          }, HOLD_MS)
        );
      }
      const action = pressMap.get(binding);
      if (!action) return;
      if (repeat && !SF.REPEATABLE.has(action)) return;
      trigger(action, binding);
    },
    onRelease(binding, pad) {
      const key = pad.index + '|' + binding;
      clearTimeout(padHoldTimers.get(key));
      padHoldTimers.delete(key);
    },
    onFrame(pads) {
      if (!confirmOpen()) scroller.frame(pads, controls.scrollStick, SF.SCROLL_SPEEDS[controls.scrollSpeed], mapped);
    },
  });

  // ---------- Home button visibility ----------

  window.addEventListener('pointermove', showHomeButton, { capture: true, passive: true });
  document.addEventListener('fullscreenchange', () => host && raise(), true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showHomeButton, { once: true });
  else showHomeButton();
})();
