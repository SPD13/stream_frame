// Shared by the start page and the content script: action list, default controls,
// and load/save helpers for chrome.storage.local.
(function (g) {
  'use strict';
  const SF = (g.StreamFrame = g.StreamFrame || {});

  SF.ACTIONS = [
    { id: 'playPause', label: 'Play / pause' },
    { id: 'seekBack', label: 'Seek back' },
    { id: 'seekForward', label: 'Seek forward' },
    { id: 'volumeUp', label: 'Volume up' },
    { id: 'volumeDown', label: 'Volume down' },
    { id: 'mute', label: 'Mute' },
    { id: 'fullscreen', label: 'Fullscreen' },
    { id: 'home', label: 'Home (start page)' },
  ];

  // Actions that fire repeatedly while their button is held.
  SF.REPEATABLE = new Set(['seekBack', 'seekForward', 'volumeUp', 'volumeDown']);

  SF.MAX_BINDINGS = 4;

  // Binding ids: "btn:<index>" (Gamepad API standard mapping), "axis:<index>:<+|->",
  // "key:<KeyboardEvent.code>", optionally suffixed ":hold" (fires after a long press
  // and does not swallow the short press).
  SF.DEFAULT_CONTROLS = {
    bindings: {
      playPause: ['btn:0', 'key:Space'],
      seekBack: ['btn:14', 'axis:0:-', 'key:ArrowLeft'],
      seekForward: ['btn:15', 'axis:0:+', 'key:ArrowRight'],
      volumeUp: ['btn:12', 'axis:1:-', 'key:ArrowUp'],
      volumeDown: ['btn:13', 'axis:1:+', 'key:ArrowDown'],
      mute: ['btn:3', 'key:KeyM'],
      fullscreen: ['btn:2', 'key:KeyF'],
      home: ['btn:9', 'key:Escape:hold'],
    },
    seekStep: 10, // seconds
    volumeStep: 10, // percent
    homeConfirm: true,
  };

  SF.SEEK_STEPS = [5, 10, 30];
  SF.VOLUME_STEPS = [5, 10, 20];

  SF.DEFAULT_TILES = { order: [], hidden: [], custom: [] };

  const clone = (v) => JSON.parse(JSON.stringify(v));

  SF.normalizeControls = function (saved) {
    const d = SF.DEFAULT_CONTROLS;
    const out = clone(d);
    if (!saved || typeof saved !== 'object') return out;
    if (saved.bindings && typeof saved.bindings === 'object') {
      for (const a of SF.ACTIONS) {
        const b = saved.bindings[a.id];
        if (Array.isArray(b)) out.bindings[a.id] = b.filter((x) => typeof x === 'string').slice(0, SF.MAX_BINDINGS);
      }
    }
    if (SF.SEEK_STEPS.includes(saved.seekStep)) out.seekStep = saved.seekStep;
    if (SF.VOLUME_STEPS.includes(saved.volumeStep)) out.volumeStep = saved.volumeStep;
    if (typeof saved.homeConfirm === 'boolean') out.homeConfirm = saved.homeConfirm;
    return out;
  };

  SF.normalizeTiles = function (saved) {
    const out = clone(SF.DEFAULT_TILES);
    if (!saved || typeof saved !== 'object') return out;
    if (Array.isArray(saved.order)) out.order = saved.order.filter((x) => typeof x === 'string');
    if (Array.isArray(saved.hidden)) out.hidden = saved.hidden.filter((x) => typeof x === 'string');
    if (Array.isArray(saved.custom)) {
      out.custom = saved.custom.filter(
        (t) => t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.url === 'string'
      );
    }
    return out;
  };

  SF.loadSettings = async function () {
    const s = await chrome.storage.local.get(['tiles', 'controls']);
    return { tiles: SF.normalizeTiles(s.tiles), controls: SF.normalizeControls(s.controls) };
  };

  SF.saveTiles = (tiles) => chrome.storage.local.set({ tiles });
  SF.saveControls = (controls) => chrome.storage.local.set({ controls });

  SF.homeUrl = () => chrome.runtime.getURL('home.html');
})(globalThis);
