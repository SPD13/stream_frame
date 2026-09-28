// Runs in Netflix's MAIN world. Receives actions from content.js via postMessage and
// drives Netflix's own player API, because seeking the <video> directly makes
// Netflix fail with error M7375.
(function () {
  'use strict';

  function player() {
    const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
    const ids = vp.getAllPlayerSessionIds();
    const id = ids.find((s) => s.startsWith('watch')) || ids[0];
    return id ? vp.getVideoPlayerBySessionId(id) : null;
  }

  function osd(text) {
    window.postMessage({ __streamFrameOsd: text }, location.origin);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__streamFrame !== 'netflix') return;
    let p;
    try {
      p = player();
    } catch (_) {
      p = null;
    }
    if (!p) return;
    try {
      switch (e.data.op) {
        case 'togglePlay':
          if (p.isPaused()) {
            p.play();
            osd('▶');
          } else {
            p.pause();
            osd('❚❚');
          }
          break;
        case 'seekBy': {
          const t = Math.max(0, Math.min(p.getDuration() - 500, p.getCurrentTime() + e.data.arg));
          p.seek(t);
          break;
        }
        case 'volumeBy': {
          const v = Math.max(0, Math.min(1, Math.round((p.getVolume() + e.data.arg) * 100) / 100));
          p.setMuted(false);
          p.setVolume(v);
          osd(`Volume ${Math.round(v * 100)}%`);
          break;
        }
        case 'toggleMute': {
          const m = !p.isMuted();
          p.setMuted(m);
          osd(m ? 'Muted' : `Volume ${Math.round(p.getVolume() * 100)}%`);
          break;
        }
      }
    } catch (err) {
      console.warn('[Stream Frame] Netflix player API call failed', err);
    }
  });
})();
