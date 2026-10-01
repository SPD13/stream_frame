// Input plumbing shared by the start page and the content script: binding ids from
// keyboard events, human-readable binding names, a Gamepad API poller with edge
// detection, stick thresholds and auto-repeat, and thumbstick scrolling.
(function (g) {
  'use strict';
  const SF = (g.StreamFrame = g.StreamFrame || {});

  // Standard Gamepad mapping (https://w3c.github.io/gamepad/#remapping), labelled
  // the way Steam Input's Xbox-style layout presents the Frame controllers.
  const BUTTON_NAMES = [
    'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu',
    'Left stick click', 'Right stick click', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Steam',
  ];
  const AXIS_NAMES = {
    '0:-': 'Left stick left', '0:+': 'Left stick right', '1:-': 'Left stick up', '1:+': 'Left stick down',
    '2:-': 'Right stick left', '2:+': 'Right stick right', '3:-': 'Right stick up', '3:+': 'Right stick down',
  };

  SF.bindingFromKeyEvent = function (e) {
    return 'key:' + (e.code || e.key);
  };

  SF.isHold = (id) => id.endsWith(':hold');
  SF.baseBinding = (id) => (SF.isHold(id) ? id.slice(0, -5) : id);

  SF.bindingName = function (id) {
    const hold = SF.isHold(id);
    const base = SF.baseBinding(id);
    const [type, a, b] = base.split(':');
    let name = base;
    if (type === 'btn') name = BUTTON_NAMES[+a] || 'Button ' + a;
    else if (type === 'axis') name = AXIS_NAMES[a + ':' + b] || `Axis ${a} ${b}`;
    else if (type === 'key') name = keyName(base.slice(4));
    return hold ? name + ' (hold)' : name;
  };

  SF.bindingKind = (id) => (id.startsWith('key:') ? 'keyboard' : 'gamepad');

  function keyName(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (code === ' ') return 'Space';
    const m = code.match(/^Arrow(\w+)$/);
    if (m) return 'Arrow ' + m[1].toLowerCase();
    return code.replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  const AXIS_ON = 0.6;
  const AXIS_OFF = 0.35;
  const REPEAT_DELAY = 400;
  const REPEAT_RATE = 160;

  // Polls navigator.getGamepads() while at least one pad is connected and reports
  // button/axis edges as binding ids. Chrome only exposes a pad after the page has
  // focus and the pad produced input, so connection is detected lazily.
  SF.GamepadWatcher = class {
    constructor({ onPress, onRelease, onFrame } = {}) {
      this.onPress = onPress || (() => {});
      this.onRelease = onRelease || (() => {});
      this.onFrame = onFrame || null;
      this.state = new Map(); // "<padIndex>|<bindingId>" -> { since, lastRepeat }
      this.running = false;
      this._tick = this._tick.bind(this);
      g.addEventListener('gamepadconnected', () => this.start());
      g.addEventListener('gamepaddisconnected', () => {
        if (!this._pads().length) this.state.clear();
      });
      this.start();
    }

    _pads() {
      try {
        return Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter(Boolean);
      } catch (_) {
        return []; // blocked by a Permissions-Policy on this site
      }
    }

    start() {
      if (this.running) return;
      if (!this._pads().length) return;
      this.running = true;
      requestAnimationFrame(this._tick);
    }

    _tick(now) {
      const pads = this._pads();
      if (!pads.length) {
        this.running = false;
        this.state.clear();
        return;
      }
      const seen = new Set();
      for (const pad of pads) {
        pad.buttons.forEach((btn, i) => {
          if (btn.pressed) this._down(pad, 'btn:' + i, now, seen);
        });
        pad.axes.forEach((v, i) => {
          for (const dir of ['-', '+']) {
            const key = pad.index + '|axis:' + i + ':' + dir;
            const signed = dir === '-' ? -v : v;
            const active = this.state.has(key) ? signed > AXIS_OFF : signed > AXIS_ON;
            if (active) this._down(pad, 'axis:' + i + ':' + dir, now, seen);
          }
        });
      }
      for (const [key, s] of this.state) {
        if (!seen.has(key)) {
          this.state.delete(key);
          this.onRelease(s.binding, s.pad);
        }
      }
      if (this.onFrame) this.onFrame(pads);
      requestAnimationFrame(this._tick);
    }

    _down(pad, binding, now, seen) {
      const key = pad.index + '|' + binding;
      seen.add(key);
      const s = this.state.get(key);
      if (!s) {
        this.state.set(key, { since: now, lastRepeat: now, binding, pad });
        this.onPress(binding, { repeat: false, pad });
      } else if (now - s.since > REPEAT_DELAY && now - s.lastRepeat > REPEAT_RATE) {
        s.lastRepeat = now;
        this.onPress(binding, { repeat: true, pad });
      }
    }
  };

  // ---------- thumbstick scrolling ----------

  const SCROLL_DEADZONE = 0.2;
  const SCROLL_AXES = { left: { x: 0, y: 1 }, right: { x: 2, y: 3 } }; // standard mapping

  // Where the user is looking: the last pointer position, else the focused element,
  // else the middle of the viewport.
  let lastPointer = null;
  g.addEventListener('pointermove', (e) => (lastPointer = { x: e.clientX, y: e.clientY }), { capture: true, passive: true });

  function deepElementAt(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function startElement() {
    if (lastPointer) {
      const el = deepElementAt(lastPointer.x, lastPointer.y);
      if (el) return el;
    }
    const f = document.activeElement;
    if (f && f !== document.body) return f;
    return deepElementAt(innerWidth / 2, innerHeight / 2);
  }

  function canScroll(el, axis, delta) {
    const cs = getComputedStyle(el);
    const overflow = axis === 'x' ? cs.overflowX : cs.overflowY;
    if (!/(auto|scroll|overlay)/.test(overflow)) return false;
    const [pos, size, view] =
      axis === 'x' ? [el.scrollLeft, el.scrollWidth, el.clientWidth] : [el.scrollTop, el.scrollHeight, el.clientHeight];
    return delta < 0 ? pos > 0 : pos + view < size - 1;
  }

  // The nearest ancestor that can still scroll that way (crossing shadow roots), else the page.
  function scrollTarget(axis, delta) {
    for (let el = startElement(); el; el = el.parentElement || (el.getRootNode && el.getRootNode().host) || null) {
      if (el === document.body || el === document.documentElement) break;
      if (canScroll(el, axis, delta)) return el;
    }
    return document.scrollingElement || document.documentElement;
  }

  // Deflection past the deadzone, rescaled to 0..1 and squared for fine control near the centre.
  function stickValue(pads, axis) {
    let v = 0;
    for (const pad of pads) {
      const a = pad.axes[axis] || 0;
      if (Math.abs(a) > Math.abs(v)) v = a;
    }
    const m = (Math.abs(v) - SCROLL_DEADZONE) / (1 - SCROLL_DEADZONE);
    return m <= 0 ? 0 : Math.sign(v) * m * m;
  }

  // Call from GamepadWatcher's onFrame. stick: 'left', 'right' or 'off'; speed: pixels per
  // second at full deflection; skip(bindingId) returns true for directions mapped to an action.
  SF.StickScroller = class {
    constructor() {
      this.last = 0;
      this.carry = { x: 0, y: 0 };
    }

    frame(pads, stick, speed, skip = () => false) {
      const now = performance.now();
      const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0;
      this.last = now;
      const axes = SCROLL_AXES[stick];
      if (!axes || !speed || !dt) return;
      for (const axis of ['x', 'y']) {
        const i = axes[axis];
        let v = stickValue(pads, i);
        if (v && skip(`axis:${i}:${v < 0 ? '-' : '+'}`)) v = 0;
        this.carry[axis] += v * speed * dt;
        const step = Math.trunc(this.carry[axis]);
        if (!step) continue;
        this.carry[axis] -= step;
        scrollTarget(axis, step).scrollBy(axis === 'x' ? { left: step, behavior: 'instant' } : { top: step, behavior: 'instant' });
      }
    }
  };

  // True when the event target (or focused element) takes text input, so mapped
  // keys must not be hijacked.
  SF.isTypingTarget = function (el) {
    el = el || document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'image', 'color', 'file'].includes(t);
    }
    return el.getAttribute && el.getAttribute('role') === 'textbox';
  };
})(globalThis);
