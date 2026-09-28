// Player actions and the per-service quirks table. Actions work on the page's
// <video> element (fine for DRM video too); where a service fights direct control,
// the quirk routes the action to the service's own player API or shortcut key.
(function (g) {
  'use strict';
  const SF = (g.StreamFrame = g.StreamFrame || {});

  // host: matched against location.hostname.
  // bridge: actions handled by a MAIN-world script that talks to the site's player API.
  // keys: native shortcut used as a fallback for an action ({ key, code }).
  // playerPath: only treat the page as a player page when the path matches.
  SF.SERVICE_QUIRKS = [
    {
      id: 'netflix',
      host: /(^|\.)netflix\.com$/,
      playerPath: /^\/watch\//,
      // Setting video.currentTime on Netflix triggers error M7375, so every action
      // goes through the Netflix player API (bridge-netflix.js).
      bridge: new Set(['playPause', 'seekBack', 'seekForward', 'volumeUp', 'volumeDown', 'mute']),
      keys: { fullscreen: { key: 'f', code: 'KeyF' } },
    },
    { id: 'max', host: /(^|\.)(max|hbomax)\.com$/, keys: { fullscreen: { key: 'f', code: 'KeyF' } } },
    { id: 'hulu', host: /(^|\.)hulu\.com$/, keys: { fullscreen: { key: 'f', code: 'KeyF' } } },
    { id: 'disneyplus', host: /(^|\.)disneyplus\.com$/, keys: { fullscreen: { key: 'f', code: 'KeyF' } } },
    // Apple TV+ renders its player inside open shadow roots; deep search handles it.
    { id: 'appletv', host: /^tv\.apple\.com$/, keys: {} },
    // Prime Video keeps preview/trailer videos in the DOM; pickVideo prefers the playing one.
    { id: 'primevideo', host: /(^|\.)(primevideo\.com|amazon\.[a-z.]+)$/, keys: { fullscreen: { key: 'f', code: 'KeyF' } } },
    { id: 'youtube', host: /(^|\.)youtube\.com$/, keys: { fullscreen: { key: 'f', code: 'KeyF' } } },
  ];

  SF.currentQuirk = function () {
    const h = location.hostname;
    return SF.SERVICE_QUIRKS.find((q) => q.host.test(h)) || { id: 'generic', keys: {} };
  };

  // All <video> elements, including inside open shadow roots.
  function allVideos(root, out) {
    out = out || [];
    root.querySelectorAll('video').forEach((v) => out.push(v));
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) allVideos(el.shadowRoot, out);
    });
    return out;
  }

  // The video the user is watching: playing beats paused, then biggest on screen.
  SF.pickVideo = function () {
    const vids = allVideos(document).filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width > 80 && r.height > 45 && v.readyState > 0;
    });
    if (!vids.length) return null;
    const score = (v) => {
      const r = v.getBoundingClientRect();
      return (!v.paused && !v.ended ? 1e9 : 0) + r.width * r.height;
    };
    return vids.sort((a, b) => score(b) - score(a))[0];
  };

  function sendKey(k, target) {
    target = target || document.activeElement || document.body;
    const opts = { key: k.key, code: k.code, bubbles: true, cancelable: true, composed: true };
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function bridge(serviceId, op, arg) {
    window.postMessage({ __streamFrame: serviceId, op, arg }, location.origin);
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Runs a media action. Returns { handled, osd } where handled means the input
  // should be swallowed and osd is a short text for the on-screen display.
  SF.runMediaAction = function (action, controls) {
    const q = SF.currentQuirk();
    const seek = controls.seekStep;
    const volStep = controls.volumeStep / 100;

    if (q.bridge && q.bridge.has(action) && (!q.playerPath || q.playerPath.test(location.pathname))) {
      const map = {
        playPause: ['togglePlay', null, null],
        seekBack: ['seekBy', -seek * 1000, `−${seek} s`],
        seekForward: ['seekBy', seek * 1000, `+${seek} s`],
        volumeUp: ['volumeBy', volStep, null],
        volumeDown: ['volumeBy', -volStep, null],
        mute: ['toggleMute', null, null],
      };
      const [op, arg, osd] = map[action];
      bridge(q.id, op, arg);
      return { handled: true, osd, osdFromBridge: !osd };
    }

    const v = SF.pickVideo();

    if (action === 'fullscreen') {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
        return { handled: true };
      }
      if (q.keys.fullscreen) {
        sendKey(q.keys.fullscreen, v || undefined);
        return { handled: true };
      }
      if (!v) return { handled: false };
      // Fullscreen the player container rather than the bare <video> so the
      // site's own controls and subtitles stay visible.
      let el = v;
      const vr = v.getBoundingClientRect();
      while (el.parentElement && el.parentElement !== document.body) {
        const pr = el.parentElement.getBoundingClientRect();
        if (pr.width > vr.width * 1.3 || pr.height > vr.height * 1.3) break;
        el = el.parentElement;
      }
      el.requestFullscreen().catch(() => v.requestFullscreen().catch(() => {}));
      return { handled: true };
    }

    if (!v) {
      const k = q.keys[action];
      if (k) {
        sendKey(k);
        return { handled: true };
      }
      return { handled: false };
    }

    switch (action) {
      case 'playPause':
        if (v.paused || v.ended) {
          v.play().catch(() => {});
          return { handled: true, osd: '▶' };
        }
        v.pause();
        return { handled: true, osd: '❚❚' };
      case 'seekBack':
      case 'seekForward': {
        const d = action === 'seekBack' ? -seek : seek;
        const end = isFinite(v.duration) ? v.duration - 0.5 : Infinity;
        v.currentTime = clamp(v.currentTime + d, 0, end);
        return { handled: true, osd: d < 0 ? `−${seek} s` : `+${seek} s` };
      }
      case 'volumeUp':
      case 'volumeDown': {
        const d = action === 'volumeUp' ? volStep : -volStep;
        v.muted = false;
        v.volume = clamp(Math.round((v.volume + d) * 100) / 100, 0, 1);
        return { handled: true, osd: `Volume ${Math.round(v.volume * 100)}%` };
      }
      case 'mute':
        v.muted = !v.muted;
        return { handled: true, osd: v.muted ? 'Muted' : `Volume ${Math.round(v.volume * 100)}%` };
    }
    return { handled: false };
  };
})(globalThis);
