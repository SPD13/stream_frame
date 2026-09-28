// Stream Frame start page: tile grid, Configuration (Tiles, Controls and Server tabs),
// gamepad/keyboard navigation, the send-from-phone address and the Widevine self-check.
(async function () {
  'use strict';
  const SF = globalThis.StreamFrame;
  const $ = (sel, root = document) => root.querySelector(sel);

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) node.append(c);
    return node;
  }

  const defaults = await fetch('services.json').then((r) => r.json());
  let { tiles: tileCfg, controls, server } = await SF.loadSettings();

  const grid = $('#grid');
  const dialog = $('#config');

  // ============================================================
  // Tile model
  // ============================================================

  function allTiles() {
    const list = [
      ...defaults.map((d) => ({ ...d, builtin: true })),
      ...tileCfg.custom.map((c) => ({ ...c, builtin: false })),
    ];
    const byId = new Map(list.map((t) => [t.id, t]));
    const order = tileCfg.order.filter((id) => byId.has(id));
    for (const t of list) if (!order.includes(t.id)) order.push(t.id);
    return order.map((id) => {
      const t = byId.get(id);
      const hidden = t.hiddenByDefault ? !tileCfg.shown.includes(id) : tileCfg.hidden.includes(id);
      return { ...t, hidden };
    });
  }

  function commitTiles() {
    tileCfg.order = allTiles().map((t) => t.id);
    SF.saveTiles(tileCfg);
    renderGrid();
    if (dialog.open) renderTileList();
  }

  function hashColor(name) {
    let x = 0;
    for (const ch of name) x = (x * 31 + ch.codePointAt(0)) >>> 0;
    return `hsl(${x % 360} 45% 32%)`;
  }

  function monogram(name) {
    const words = name.trim().split(/\s+/).filter(Boolean);
    const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
    return letters.toUpperCase();
  }

  // Fills a logo box. Built-in services use their bundled tile image; custom tiles use
  // the logo URL the user gave, else the site's touch icon or favicon. Either way a
  // monogram on the tile colour is the last resort.
  function renderLogo(box, t) {
    box.textContent = '';
    box.style.setProperty('--brand', t.color || hashColor(t.name));
    const sources = [];
    if (t.logo) sources.push({ src: t.logo, cls: t.logoFit === 'cover' ? 'cover' : '' });
    if (!t.builtin) {
      try {
        const origin = new URL(t.url).origin;
        sources.push({ src: origin + '/apple-touch-icon.png', cls: 'icon' }, { src: origin + '/favicon.ico', cls: 'icon' });
      } catch (_) {
        /* invalid URL: monogram */
      }
    }
    const tryNext = (i) => {
      if (i >= sources.length) return showMonogram();
      const img = new Image();
      img.alt = '';
      img.className = sources[i].cls;
      img.referrerPolicy = 'no-referrer';
      img.onload = () => {
        if (img.naturalWidth < 16) return tryNext(i + 1);
        if (sources[i].cls !== 'icon') return box.replaceChildren(img);
        // Site icons are 16–96 px: show on a light plate (readable on any tile colour),
        // upscaled at most 4x so a 16 px favicon does not turn to mush.
        img.style.setProperty('--icon-size', Math.min(img.naturalWidth * 4, 80) + 'px');
        box.replaceChildren(h('span', { class: 'icon-plate' }, img));
      };
      img.onerror = () => tryNext(i + 1);
      img.src = sources[i].src;
    };
    const showMonogram = () =>
      box.replaceChildren(h('span', { class: 'monogram', 'aria-hidden': 'true', text: monogram(t.name) }));
    // Custom tiles show the monogram while site icons load (or time out on an unreachable host).
    if (!t.builtin) showMonogram();
    tryNext(0);
  }

  // ============================================================
  // Grid
  // ============================================================

  function renderGrid() {
    grid.textContent = '';
    const visible = allTiles().filter((t) => !t.hidden);
    for (const t of visible) {
      const box = h('div', { class: 'logo-box' });
      renderLogo(box, t);
      grid.append(
        h('a', { class: 'tile', href: t.url, role: 'listitem', draggable: 'false', 'aria-label': t.name }, box, h('span', { class: 'name', text: t.name }))
      );
    }
    $('#empty').hidden = visible.length > 0;
  }

  // ============================================================
  // Configuration dialog + tabs
  // ============================================================

  const tabs = { tiles: $('#tab-tiles'), controls: $('#tab-controls'), server: $('#tab-server') };
  const panels = { tiles: $('#panel-tiles'), controls: $('#panel-controls'), server: $('#panel-server') };
  const tabNames = Object.keys(tabs);

  function selectTab(name, focus) {
    for (const k of Object.keys(tabs)) {
      const on = k === name;
      tabs[k].setAttribute('aria-selected', on);
      tabs[k].tabIndex = on ? 0 : -1;
      panels[k].hidden = !on;
    }
    if (name !== 'controls') cancelCapture();
    if (focus) tabs[name].focus();
  }
  for (const k of tabNames) tabs[k].addEventListener('click', () => selectTab(k));
  $('.tabs').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const cur = tabNames.findIndex((k) => tabs[k].getAttribute('aria-selected') === 'true');
      const step = e.key === 'ArrowRight' ? 1 : -1;
      selectTab(tabNames[(cur + step + tabNames.length) % tabNames.length], true);
      e.preventDefault();
    }
  });

  function openConfig() {
    renderTileList();
    renderBindings();
    renderOptions();
    renderServer();
    resetForm();
    dialog.showModal();
  }

  function closeConfig() {
    cancelCapture();
    dialog.close();
  }

  $('#gear').addEventListener('click', openConfig);
  $('#config-close').addEventListener('click', closeConfig);
  dialog.addEventListener('cancel', (e) => {
    // Escape while capturing is captured as a binding, not a close.
    if (capturing) e.preventDefault();
    else cancelCapture();
  });
  dialog.addEventListener('close', () => $('#gear').focus());

  // Two-step confirmation for destructive buttons, without a browser dialog.
  function armed(btn, action) {
    if (btn.classList.contains('armed')) {
      clearTimeout(btn._armTimer);
      btn.classList.remove('armed');
      btn.textContent = btn._label;
      action();
      return;
    }
    btn._label = btn.textContent;
    btn.classList.add('armed');
    btn.textContent = 'Click again to confirm';
    btn._armTimer = setTimeout(() => {
      btn.classList.remove('armed');
      btn.textContent = btn._label;
    }, 4000);
  }

  // ============================================================
  // Tiles tab
  // ============================================================

  const tileList = $('#tile-list');
  let dragId = null;

  function moveTile(id, toIndex) {
    const order = allTiles().map((t) => t.id);
    const from = order.indexOf(id);
    if (from < 0) return;
    order.splice(from, 1);
    order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, id);
    tileCfg.order = order;
    commitTiles();
  }

  function renderTileList(focusSel) {
    tileList.textContent = '';
    const list = allTiles();
    list.forEach((t, i) => {
      const thumb = h('div', { class: 'thumb' });
      renderLogo(thumb, t);
      const shown = h('input', { type: 'checkbox', 'aria-label': `Show ${t.name}` });
      shown.checked = !t.hidden;
      shown.addEventListener('change', () => {
        tileCfg.hidden = tileCfg.hidden.filter((x) => x !== t.id);
        tileCfg.shown = tileCfg.shown.filter((x) => x !== t.id);
        if (t.hiddenByDefault && shown.checked) tileCfg.shown.push(t.id);
        if (!t.hiddenByDefault && !shown.checked) tileCfg.hidden.push(t.id);
        commitTiles();
        $(`[data-id="${CSS.escape(t.id)}"] input[type=checkbox]`, tileList)?.focus();
      });
      const row = h(
        'li',
        { class: 'tile-row' + (t.hidden ? ' is-hidden' : ''), draggable: 'true', 'data-id': t.id },
        h('span', { class: 'grip', 'aria-hidden': 'true', text: '⠿' }),
        thumb,
        h(
          'div',
          { class: 'meta' },
          h('div', { class: 'n' }, t.name, t.builtin ? null : h('span', { class: 'badge', text: 'Custom' })),
          h('div', { class: 'u', text: t.url })
        ),
        h('label', { class: 'toggle' }, shown, 'Shown'),
        h('button', {
          type: 'button', class: 'move up', 'aria-label': `Move ${t.name} up`, title: 'Move up', disabled: i === 0, text: '▲',
          onclick: () => {
            moveTile(t.id, i - 1);
            refocusMove(t.id, 'up');
          },
        }),
        h('button', {
          type: 'button', class: 'move down', 'aria-label': `Move ${t.name} down`, title: 'Move down', disabled: i === list.length - 1, text: '▼',
          onclick: () => {
            moveTile(t.id, i + 1);
            refocusMove(t.id, 'down');
          },
        }),
        t.builtin ? null : h('button', { type: 'button', text: 'Edit', onclick: () => editTile(t) }),
        t.builtin
          ? null
          : h('button', {
              type: 'button', class: 'danger', text: 'Remove',
              onclick: (e) => armed(e.currentTarget, () => removeTile(t.id)),
            })
      );
      addDragHandlers(row, t.id);
      tileList.append(row);
    });
    if (focusSel) $(focusSel, tileList)?.focus();
  }

  function refocusMove(id, dir) {
    const row = $(`[data-id="${CSS.escape(id)}"]`, tileList);
    if (!row) return;
    const btn = $(`.move.${dir}`, row);
    (btn && !btn.disabled ? btn : $(`.move.${dir === 'up' ? 'down' : 'up'}`, row))?.focus();
  }

  function addDragHandlers(row, id) {
    row.addEventListener('dragstart', (e) => {
      dragId = id;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    });
    row.addEventListener('dragend', () => {
      dragId = null;
      tileList.querySelectorAll('.tile-row').forEach((r) => r.classList.remove('dragging', 'drop-before', 'drop-after'));
    });
    row.addEventListener('dragover', (e) => {
      if (!dragId || dragId === id) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      row.classList.toggle('drop-after', after);
      row.classList.toggle('drop-before', !after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragId || dragId === id) return;
      const order = allTiles().map((t) => t.id).filter((x) => x !== dragId);
      let idx = order.indexOf(id);
      if (row.classList.contains('drop-after')) idx += 1;
      moveTile(dragId, idx);
    });
  }

  function removeTile(id) {
    tileCfg.custom = tileCfg.custom.filter((c) => c.id !== id);
    tileCfg.hidden = tileCfg.hidden.filter((x) => x !== id);
    tileCfg.order = tileCfg.order.filter((x) => x !== id);
    if (editingId === id) resetForm();
    commitTiles();
  }

  $('#reset-tiles').addEventListener('click', (e) =>
    armed(e.currentTarget, () => {
      tileCfg = SF.normalizeTiles(null);
      resetForm();
      commitTiles();
    })
  );

  // ---------- add / edit form ----------

  const form = $('#tile-form');
  const fName = $('#f-name');
  const fUrl = $('#f-url');
  const fLogo = $('#f-logo');
  const fColor = $('#f-color');
  const fError = $('#f-error');
  let editingId = null;
  let colorTouched = false;

  fColor.addEventListener('input', () => (colorTouched = true));
  fName.addEventListener('input', () => {
    if (!colorTouched) fColor.value = hslToHex(hashColor(fName.value.trim() || '?'));
  });

  function hslToHex(hsl) {
    const [hh, s, l] = hsl.match(/[\d.]+/g).map(Number);
    const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
    const f = (n) => {
      const k = (n + hh / 30) % 12;
      const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  function resetForm() {
    editingId = null;
    colorTouched = false;
    form.reset();
    fColor.value = '#2a2f3a';
    fError.textContent = '';
    $('#tile-form-title').textContent = 'Add a tile';
    $('#f-submit').textContent = 'Add tile';
    $('#f-cancel').hidden = true;
  }

  function editTile(t) {
    editingId = t.id;
    fName.value = t.name;
    fUrl.value = t.url;
    fLogo.value = t.logo || '';
    colorTouched = !!t.color;
    fColor.value = t.color || hslToHex(hashColor(t.name));
    fError.textContent = '';
    $('#tile-form-title').textContent = `Edit “${t.name}”`;
    $('#f-submit').textContent = 'Save changes';
    $('#f-cancel').hidden = false;
    fName.focus();
    form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  $('#f-cancel').addEventListener('click', resetForm);

  function parseHttpUrl(raw) {
    let v = raw.trim();
    if (!v) return null;
    // "host:port" is not a scheme; only "scheme://" counts as one.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = 'https://' + v;
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
    } catch (_) {
      return undefined;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = fName.value.replace(/\s+/g, ' ').trim();
    const url = parseHttpUrl(fUrl.value);
    const logo = parseHttpUrl(fLogo.value);
    const fail = (msg, field) => {
      fError.textContent = msg;
      field.focus();
    };
    if (!name) return fail('Enter a name.', fName);
    const clash = allTiles().find((t) => t.id !== editingId && t.name.toLowerCase() === name.toLowerCase());
    if (clash) return fail(`There is already a tile called “${clash.name}”.`, fName);
    if (!url) return fail('Enter a homepage URL starting with http:// or https://.', fUrl);
    if (logo === undefined) return fail('The logo URL must start with http:// or https://.', fLogo);

    const data = { name, url, logo: logo || null, color: colorTouched ? fColor.value : null };
    if (editingId) {
      const c = tileCfg.custom.find((x) => x.id === editingId);
      if (c) Object.assign(c, data);
    } else {
      const id = 'custom-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      tileCfg.custom.push({ id, ...data });
      tileCfg.order = [...allTiles().map((t) => t.id).filter((x) => x !== id), id];
    }
    resetForm();
    commitTiles();
    fName.focus();
  });

  // ============================================================
  // Controls tab
  // ============================================================

  const bindingRows = $('#binding-rows');
  const captureNote = $('#capture-note');
  let capturing = null; // { action, timer }
  const suppressKeyup = new Set();

  function renderBindings() {
    bindingRows.textContent = '';
    for (const a of SF.ACTIONS) {
      const list = controls.bindings[a.id] || [];
      const chips = h(
        'div',
        { class: 'chips' },
        list.length
          ? list.map((b) =>
              h(
                'span',
                { class: 'chip' + (SF.bindingKind(b) === 'keyboard' ? ' kbd' : '') },
                SF.bindingName(b),
                h('button', {
                  type: 'button', 'aria-label': `Remove ${SF.bindingName(b)} from ${a.label}`, title: 'Remove', text: '×',
                  onclick: () => {
                    controls.bindings[a.id] = list.filter((x) => x !== b);
                    SF.saveControls(controls);
                    renderBindings();
                    $(`tr[data-action="${a.id}"] .add`, bindingRows)?.focus();
                  },
                })
              )
            )
          : h('span', { class: 'note', text: 'Not assigned' })
      );
      const isCap = capturing && capturing.action === a.id;
      const last = isCap
        ? h('td', {}, h('span', { class: 'capture-prompt', text: 'Press a button… ' }), h('button', { type: 'button', class: 'cancel', text: 'Cancel', onclick: cancelCapture }))
        : h(
            'td',
            {},
            h('button', {
              type: 'button', class: 'add', text: list.length ? '+ Add another' : '+ Assign',
              disabled: list.length >= SF.MAX_BINDINGS,
              onclick: () => startCapture(a.id),
            })
          );
      bindingRows.append(h('tr', { 'data-action': a.id, class: isCap ? 'capturing' : '' }, h('td', { text: a.label }), h('td', {}, chips), last));
    }
    if (capturing) $(`tr[data-action="${capturing.action}"] .cancel`, bindingRows)?.focus();
  }

  function startCapture(action) {
    cancelCapture();
    capturing = { action, timer: setTimeout(cancelCapture, 10000) };
    captureNote.textContent = `Press the controller button or key to use for “${label(action)}”.`;
    renderBindings();
  }

  function cancelCapture() {
    if (!capturing) return;
    const action = capturing.action;
    clearTimeout(capturing.timer);
    capturing = null;
    captureNote.textContent = '';
    renderBindings();
    $(`tr[data-action="${action}"] .add`, bindingRows)?.focus();
  }

  const label = (id) => SF.ACTIONS.find((a) => a.id === id).label;

  function finishCapture(binding) {
    const action = capturing.action;
    clearTimeout(capturing.timer);
    capturing = null;
    const moved = [];
    for (const a of SF.ACTIONS) {
      if (a.id === action) continue;
      const before = controls.bindings[a.id] || [];
      const after = before.filter((b) => SF.baseBinding(b) !== binding);
      if (after.length !== before.length) moved.push(a.label);
      controls.bindings[a.id] = after;
    }
    const mine = controls.bindings[action] || [];
    if (!mine.some((b) => SF.baseBinding(b) === binding)) mine.push(binding);
    controls.bindings[action] = mine.slice(0, SF.MAX_BINDINGS);
    SF.saveControls(controls);
    captureNote.textContent =
      `${SF.bindingName(binding)} now triggers “${label(action)}”.` + (moved.length ? ` Removed it from ${moved.join(', ')}.` : '');
    renderBindings();
    $(`tr[data-action="${action}"] .add`, bindingRows)?.focus();
  }

  function renderOptions() {
    const seek = $('#o-seek');
    const vol = $('#o-volume');
    seek.textContent = '';
    vol.textContent = '';
    for (const s of SF.SEEK_STEPS) seek.append(h('option', { value: s, text: `${s} seconds` }));
    for (const s of SF.VOLUME_STEPS) vol.append(h('option', { value: s, text: `${s}%` }));
    seek.value = controls.seekStep;
    vol.value = controls.volumeStep;
    $('#o-home').value = controls.homeConfirm ? 'confirm' : 'immediate';
  }

  $('#o-seek').addEventListener('change', (e) => {
    controls.seekStep = +e.target.value;
    SF.saveControls(controls);
  });
  $('#o-volume').addEventListener('change', (e) => {
    controls.volumeStep = +e.target.value;
    SF.saveControls(controls);
  });
  $('#o-home').addEventListener('change', (e) => {
    controls.homeConfirm = e.target.value === 'confirm';
    SF.saveControls(controls);
  });
  $('#reset-controls').addEventListener('click', (e) =>
    armed(e.currentTarget, () => {
      controls = SF.normalizeControls(null);
      SF.saveControls(controls);
      cancelCapture();
      renderBindings();
      renderOptions();
      captureNote.textContent = 'Controls reset to defaults.';
    })
  );

  // ============================================================
  // Server tab + start page address (send links from a phone)
  // ============================================================

  let serverStatus = null; // published by background.js; null until it has connected once
  const sEnabled = $('#s-enabled');
  const sPort = $('#s-port');
  const sPortError = $('#s-port-error');
  const sCodeEnabled = $('#s-code-enabled');

  function saveServer() {
    SF.saveServer(server);
    renderServer();
  }

  // What the server is doing, in words. The status lags a settings change by a moment.
  function serverState() {
    const st = serverStatus;
    if (!st || !st.running) return { text: 'Server not running. Relaunch Stream Frame.', url: null };
    if (!server.enabled) return { text: 'Off. Phones cannot send links.', url: null };
    if (st.enabled !== server.enabled || st.port !== server.port || st.codeEnabled !== server.codeEnabled)
      return { text: 'Restarting…', url: null };
    if (st.error) return { text: st.error, url: null };
    if (st.listening && st.url) return { text: 'Running at ', url: st.url };
    return { text: 'Starting…', url: null };
  }

  function renderServer() {
    sEnabled.checked = server.enabled;
    if (document.activeElement !== sPort) sPort.value = server.port;
    sCodeEnabled.checked = server.codeEnabled;
    $('#s-code-box').hidden = !server.codeEnabled;
    $('#s-code').textContent = server.code;
    const state = serverState();
    const status = $('#s-status');
    status.replaceChildren(state.text, state.url ? h('strong', { text: state.url }) : '');
    status.className = state.url ? 'ok' : serverStatus?.error && server.enabled ? 'bad' : '';
    const alt = serverStatus?.hostnameUrl;
    $('#s-alt').textContent = state.url && alt ? `(may also work: ${alt})` : '';
    if (serverStatus?.codeLocked) {
      $('#s-alt').textContent = 'Code entry is blocked after too many wrong codes. Press New code to unblock it.';
    }
    renderRemoteHint(state);
  }

  function renderRemoteHint(state = serverState()) {
    const hint = $('#remote-hint');
    hint.hidden = !state.url;
    if (!state.url) return;
    hint.replaceChildren(
      'Send links from your phone: ',
      h('strong', { text: state.url.replace(/\/$/, '') }),
      ...(server.codeEnabled ? [' · code ', h('strong', { class: 'code', text: server.code })] : [])
    );
  }

  sEnabled.addEventListener('change', () => {
    server.enabled = sEnabled.checked;
    saveServer();
  });

  $('#s-port-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const port = Number(sPort.value);
    if (!SF.validServerPort(port)) {
      sPortError.textContent =
        port === SF.CONTROL_PORT
          ? `Port ${SF.CONTROL_PORT} is reserved for Stream Frame itself.`
          : 'Enter a port between 1024 and 65535.';
      sPort.focus();
      return;
    }
    sPortError.textContent = '';
    server.port = port;
    saveServer();
  });

  sCodeEnabled.addEventListener('change', () => {
    server.codeEnabled = sCodeEnabled.checked;
    if (server.codeEnabled && !server.code) server.code = SF.newServerCode();
    saveServer();
  });

  $('#s-new-code').addEventListener('click', () => {
    let code;
    do code = SF.newServerCode();
    while (code === server.code);
    server.code = code;
    saveServer();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.serverStatus) {
      serverStatus = changes.serverStatus.newValue || null;
      renderServer();
    } else if (area === 'local' && changes.server) {
      server = SF.normalizeServer(changes.server.newValue);
      renderServer();
    }
  });
  chrome.storage.session
    .get('serverStatus')
    .then((s) => {
      serverStatus = s.serverStatus || null;
      renderServer();
    })
    .catch(() => {});
  chrome.runtime.sendMessage({ type: 'sf-wake' }).catch(() => {});

  // ---------- live input indicator ----------

  const liveHeld = new Map(); // binding -> kind
  const liveRecent = new Map(); // binding -> timeout
  const liveChips = $('#live-chips');
  const liveMode = $('#live-mode');

  function renderLive() {
    liveChips.textContent = '';
    for (const [b] of liveHeld) liveChips.append(h('span', { class: 'chip held', text: SF.bindingName(b) }));
    for (const [b] of liveRecent) if (!liveHeld.has(b)) liveChips.append(h('span', { class: 'chip fading', text: SF.bindingName(b) }));
  }

  function liveDown(binding, modeText) {
    liveMode.textContent = modeText;
    clearTimeout(liveRecent.get(binding));
    liveRecent.delete(binding);
    liveHeld.set(binding, true);
    renderLive();
  }

  function liveUp(binding) {
    if (!liveHeld.delete(binding)) return;
    liveRecent.set(
      binding,
      setTimeout(() => {
        liveRecent.delete(binding);
        renderLive();
      }, 1500)
    );
    renderLive();
  }

  // ============================================================
  // Input: keyboard + gamepad
  // ============================================================

  const MODIFIER_ONLY = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted) return;
      if (!e.repeat) liveDown(SF.bindingFromKeyEvent(e), 'Keyboard mode: Steam Input is sending key presses.');
      if (capturing) {
        e.preventDefault();
        e.stopPropagation();
        suppressKeyup.add(e.code);
        if (!e.repeat && !MODIFIER_ONLY.has(e.code)) finishCapture(SF.bindingFromKeyEvent(e));
        return;
      }
      if (!dialog.open && !SF.isTypingTarget(e.target) && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
        if (dir) {
          e.preventDefault();
          moveFocus(dir);
        }
      }
    },
    true
  );
  window.addEventListener(
    'keyup',
    (e) => {
      liveUp(SF.bindingFromKeyEvent(e));
      if (suppressKeyup.delete(e.code)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  const NAV = {
    'btn:12': 'up', 'axis:1:-': 'up',
    'btn:13': 'down', 'axis:1:+': 'down',
    'btn:14': 'left', 'axis:0:-': 'left',
    'btn:15': 'right', 'axis:0:+': 'right',
  };

  new SF.GamepadWatcher({
    onPress(binding, { repeat, pad }) {
      if (!repeat) liveDown(binding, `Gamepad mode: ${pad.id.replace(/\s*\(.*$/, '') || 'controller'}`);
      if (capturing) {
        if (!repeat) finishCapture(binding);
        return;
      }
      if (NAV[binding]) {
        moveFocus(NAV[binding]);
      } else if (binding === 'btn:0' && !repeat) {
        const el = document.activeElement;
        if (el && el !== document.body) {
          if (el.matches('input[type=checkbox]')) el.click();
          else if (el.matches('select')) el.showPicker?.();
          else el.click();
        }
      } else if (binding === 'btn:1' && !repeat && dialog.open) {
        closeConfig();
      }
    },
    onRelease(binding) {
      liveUp(binding);
    },
  });

  // Spatial navigation for d-pad / arrow keys within the grid or the open dialog.
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function moveFocus(dir) {
    document.body.classList.add('pad-nav');
    const scope = dialog.open ? dialog : document.body;
    const cands = [...scope.querySelectorAll(FOCUSABLE)].filter(
      (el) => el.getClientRects().length && (dialog.open || !dialog.contains(el)) && !el.closest('[hidden]')
    );
    if (!cands.length) return;
    const cur = document.activeElement;
    if (!cur || cur === document.body || !scope.contains(cur)) {
      (scope === document.body ? grid.querySelector('.tile') || cands[0] : cands[0]).focus();
      return;
    }
    const c = center(cur.getBoundingClientRect());
    let best = null;
    let bestScore = Infinity;
    for (const el of cands) {
      if (el === cur) continue;
      const p = center(el.getBoundingClientRect());
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      const along = { up: -dy, down: dy, left: -dx, right: dx }[dir];
      const across = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      if (along <= 4) continue;
      const score = along + across * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) {
      best.focus();
      best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  window.addEventListener('mousemove', () => document.body.classList.remove('pad-nav'), { passive: true });

  // ============================================================
  // Clock, Widevine check, sync
  // ============================================================

  function tickClock() {
    $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  tickClock();
  setInterval(tickClock, 15000);

  async function checkWidevine() {
    const banner = $('#drm-banner');
    const fail = (why) => {
      banner.innerHTML =
        '<strong>Widevine DRM is not available in this browser' + (why ? ` (${why})` : '') + '.</strong> ' +
        'Netflix, HBO Max, Hulu, Disney+, Apple TV+, Prime Video and the other paid services will not play; YouTube still works. ' +
        'Stream Frame needs Google Chrome, not Chromium: re-run <code>install.sh</code> over SSH. ' +
        'If Chrome was just installed, open <code>chrome://components</code>, update “Widevine Content Decryption Module”, then relaunch.';
      banner.hidden = false;
    };
    if (!navigator.requestMediaKeySystemAccess) return fail('no Encrypted Media Extensions');
    try {
      await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [
        {
          initDataTypes: ['cenc'],
          audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
          videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
        },
      ]);
    } catch (_) {
      fail();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || dialog.open) return;
    if (changes.tiles) {
      tileCfg = SF.normalizeTiles(changes.tiles.newValue);
      renderGrid();
    }
    if (changes.controls) controls = SF.normalizeControls(changes.controls.newValue);
  });

  renderGrid();
  checkWidevine();
})();
