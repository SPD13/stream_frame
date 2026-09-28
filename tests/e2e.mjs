// End-to-end test of the Stream Frame Helper extension in Chrome for Testing, over CDP.
// Covers boot redirect, start page, Configuration (tiles + controls), persistence, and the
// keyboard mapper / Home overlay on a local player page. Gamepad input is not simulated.
//
//   npx @puppeteer/browsers install chrome@stable      # prints the binary path
//   CHROME=/path/to/chrome-for-testing node tests/e2e.mjs
//
// Branded Chrome 137+ ignores --load-extension, hence Chrome for Testing.
// Screenshots go to tests/out/. Needs Node 22+ (global WebSocket and fetch).
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const REPO = join(HERE, '..');
const CHROME = process.env.CHROME;
if (!CHROME) { console.error('Set CHROME to a Chrome for Testing binary (see the header of this file).'); process.exit(2); }
const OUT = join(HERE, 'out') + '/';
mkdirSync(OUT, { recursive: true });
const PROFILE = mkdtempSync(join(tmpdir(), 'stream-frame-e2e-'));
const SITE_PORT = 8765;
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(readFileSync(join(HERE, 'site/player.html')));
}).listen(SITE_PORT, '127.0.0.1');
const ID = 'cjgndomenjkjikknkabepmobpflkbchl';
const HOME = `chrome-extension://${ID}/home.html`;
const PORT = 9335;

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, `--load-extension=${REPO}/extension`,
  '--disable-extensions-except=' + REPO + '/extension', '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,720', '--headless=new', '--disable-background-timer-throttling', '--autoplay-policy=no-user-gesture-required',
  `file://${REPO}/web/boot.html#${ID}`,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let results = [];
const check = (name, ok, extra = '') => { results.push([ok, name]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };

let ws, seq = 0; const pending = new Map();
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch {}
    await sleep(200);
  }
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
}
// Every CDP call times out, so a stuck headless Chrome fails the run instead of hanging it.
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 15000);
  pending.set(id, (d) => { clearTimeout(timer); resolve(d); });
  ws.send(JSON.stringify({ id, method, params }));
});
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
}
async function waitFor(expr, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if (await ev(expr)) return true; } catch {} await sleep(150); }
  return false;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT + name, Buffer.from(r.result.data, 'base64'));
}
const KEYS = {
  Space: [' ', 32], ArrowRight: ['ArrowRight', 39], ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38],
  KeyM: ['m', 77], KeyP: ['p', 80], Escape: ['Escape', 27], KeyA: ['a', 65], KeyF: ['f', 70],
};
async function key(code, { hold = 0, text } = {}) {
  const [k, vk] = KEYS[code];
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, text });
  if (hold) {
    const end = Date.now() + hold;
    await sleep(500);
    while (Date.now() < end) { await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, autoRepeat: true }); await sleep(50); }
  }
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  await sleep(120);
}
async function click(selector) {
  const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({block:'center'}); const b = e.getBoundingClientRect(); return [b.x + b.width/2, b.y + b.height/2]; })()`);
  if (!r) throw new Error('no element ' + selector);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: r[0], y: r[1], button: 'left', clickCount: 1 });
  await sleep(150);
}
async function navigate(url) { await send('Page.navigate', { url }); await sleep(300); }

try {
  await connect();
  await send('Page.enable'); await send('Runtime.enable');

  // 1. boot.html redirects to the start page
  check('boot.html redirects to the extension start page', await waitFor(`location.href === ${JSON.stringify(HOME)}`));
  check('seven default tiles', await waitFor(`document.querySelectorAll('#grid .tile').length === 7`));
  await sleep(+process.env.LOGO_WAIT || 500); // LOGO_WAIT=4000 when testing site-icon fallbacks
  check('built-in services use full-bleed tile images', (await ev(`document.querySelectorAll('#grid .tile img.cover').length`)) === 7);
  check('logos loaded', await ev(`[...document.querySelectorAll('#grid .tile img')].every(i => i.complete && i.naturalWidth > 0)`));
  check('Widevine banner hidden or shown (informational)', true, '→ banner hidden: ' + await ev(`document.getElementById('drm-banner').hidden`));
  await shot('01-home.png');

  // 2. Tiles tab: hide Hulu, move YouTube to the top, add a custom tile
  await click('#gear');
  check('configuration dialog opens', await ev(`document.getElementById('config').open`));
  await click('[data-id="hulu"] input[type=checkbox]');
  for (let i = 0; i < 6; i++) await click('[data-id="youtube"] .move.up:not([disabled])').catch(() => {});
  await click('#f-name'); await ev(`document.getElementById('f-name').value = 'Jellyfin'`);
  await ev(`document.getElementById('f-url').value = 'jellyfin.local:8096'`);
  await click('#f-submit');
  await sleep(300);
  // duplicate name and invalid URL are rejected
  await ev(`document.getElementById('f-name').value = 'netflix'; document.getElementById('f-url').value = 'https://x.test'`);
  await click('#f-submit');
  check('duplicate name rejected', (await ev(`document.getElementById('f-error').textContent`)).includes('already'));
  await ev(`document.getElementById('f-name').value = 'Bad'; document.getElementById('f-url').value = 'ftp://x.test'`);
  await click('#f-submit');
  check('non-http URL rejected', (await ev(`document.getElementById('f-error').textContent`)).includes('http'));
  await ev(`document.getElementById('f-name').value = 'Evil'; document.getElementById('f-url').value = 'javascript:alert(1)'`);
  await click('#f-submit');
  check('javascript: URL rejected', (await ev(`chrome.storage.local.get('tiles').then(s => s.tiles.custom.length)`)) === 1);
  await ev(`document.getElementById('f-cancel').click(); document.getElementById('f-name').value=''; document.getElementById('f-url').value=''`);
  await shot('02-config-tiles.png');

  const tiles = await ev(`chrome.storage.local.get('tiles').then(s => s.tiles)`);
  check('YouTube moved first', tiles.order[0] === 'youtube', JSON.stringify(tiles.order));
  check('Hulu hidden', tiles.hidden.includes('hulu'));
  check('custom tile saved with normalised URL', tiles.custom[0]?.url === 'https://jellyfin.local:8096/', JSON.stringify(tiles.custom));

  // 3. Controls tab: capture KeyP for play/pause
  await click('#tab-controls');
  await click('tr[data-action="playPause"] .add');
  check('capture prompt shown', await ev(`!!document.querySelector('tr.capturing .capture-prompt')`));
  await key('KeyP');
  const controls = await ev(`chrome.storage.local.get('controls').then(s => s.controls)`);
  check('KeyP captured for play/pause', controls?.bindings.playPause.includes('key:KeyP'), JSON.stringify(controls?.bindings.playPause));
  // move ArrowUp from volumeUp to mute
  await click('tr[data-action="mute"] .add');
  await key('ArrowUp');
  const c2 = await ev(`chrome.storage.local.get('controls').then(s => s.controls.bindings)`);
  check('re-assigning moves a binding', c2.mute.includes('key:ArrowUp') && !c2.volumeUp.includes('key:ArrowUp'));
  check('live indicator saw keyboard input', (await ev(`document.getElementById('live-mode').textContent`)).startsWith('Keyboard'));
  await shot('03-config-controls.png');
  // put ArrowUp back via reset
  await click('#reset-controls'); await click('#reset-controls');
  const c3 = await ev(`chrome.storage.local.get('controls').then(s => s.controls.bindings)`);
  check('reset controls restores defaults', c3.volumeUp.includes('key:ArrowUp') && !c3.playPause.includes('key:KeyP'));
  // re-add KeyP for later tests
  await click('tr[data-action="playPause"] .add'); await key('KeyP');
  await click('#config-close');

  // 4. layout persists across reload
  await navigate(HOME);
  await waitFor(`document.querySelectorAll('#grid .tile').length > 0`);
  await sleep(600);
  const names = await ev(`[...document.querySelectorAll('#grid .tile .name')].map(n => n.textContent)`);
  check('grid persisted after reload', names[0] === 'YouTube' && !names.includes('Hulu') && names.at(-1) === 'Jellyfin', JSON.stringify(names));
  await shot('04-home-custom.png');

  // 5. keyboard grid navigation
  await key('ArrowRight');
  check('arrow key focuses a tile', await ev(`document.activeElement.classList.contains('tile')`));

  // 6. content script on a player page
  await navigate(`http://127.0.0.1:${SITE_PORT}/player.html`);
  check('test video ready', await waitFor('window.ready === true', 30000));
  check('overlay host injected', await ev(`!!document.querySelector('stream-frame-overlay')`));
  check('overlay is in the top layer', await ev(`document.querySelector('stream-frame-overlay').matches(':popover-open')`));
  await ev(`(() => { const v = document.getElementById('v'); v.currentTime = 1; })()`); await sleep(200);

  await key('Space');
  check('Space pauses', await ev(`document.getElementById('v').paused`));
  check('Space swallowed (site did not see it)', !(await ev(`siteKeys.includes('Space')`)));
  await key('KeyP');
  check('remapped KeyP resumes', !(await ev(`document.getElementById('v').paused`)));
  await key('Space'); // pause again for stable seeking
  const t0 = await ev(`document.getElementById('v').currentTime`);
  await key('ArrowRight'); await sleep(300);
  const t1 = await ev(`document.getElementById('v').currentTime`);
  check('ArrowRight seeks +10 s', t1 - t0 > 9, `${t0.toFixed(2)} → ${t1.toFixed(2)}`);
  await key('ArrowLeft'); await sleep(300);
  const t2 = await ev(`document.getElementById('v').currentTime`);
  check('ArrowLeft seeks back', t1 - t2 > 9, `${t1.toFixed(2)} → ${t2.toFixed(2)}`);
  await key('KeyM');
  check('M toggles mute', !(await ev(`document.getElementById('v').muted`)));
  await ev(`document.getElementById('v').volume = 0.5`);
  await key('ArrowUp');
  check('ArrowUp raises volume', Math.abs((await ev(`document.getElementById('v').volume`)) - 0.6) < 0.001);
  await shot('05-player-osd.png');

  // fullscreen: F fullscreens the player container, overlay stays on top
  await key('KeyF'); await sleep(400);
  check('F enters element fullscreen on the player', await ev(`document.fullscreenElement?.id === 'player'`));
  check('overlay re-raised above fullscreen', await ev(`document.querySelector('stream-frame-overlay').matches(':popover-open')`));
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500, y: 300 }); await sleep(400);
  await shot('05b-fullscreen.png');
  await key('KeyF'); await sleep(300);
  check('F again exits fullscreen', await ev(`!document.fullscreenElement`));

  // typing is never hijacked
  await click('#search');
  await ev(`siteKeys.length = 0`);
  const pausedBefore = await ev(`document.getElementById('v').paused`);
  await key('Space', { text: ' ' });
  await key('KeyA', { text: 'a' });
  check('typing in a text field is not hijacked', (await ev(`document.getElementById('search').value`)) === ' a' && (await ev(`document.getElementById('v').paused`)) === pausedBefore);
  await ev(`document.activeElement.blur()`);

  // Home: Escape hold opens the confirmation, a different key cancels, re-press confirms
  await key('Escape', { hold: 900 });
  await sleep(200);
  await shot('06-home-confirm.png');
  await key('KeyM'); // cancels
  check('other key cancels (still on the page)', await ev(`location.pathname === '/player.html'`));
  await key('Escape', { hold: 900 });
  await key('Escape'); // re-press within 3 s
  check('Home re-press returns to the start page', await waitFor(`location.href === ${JSON.stringify(HOME)}`, 4000));

  // Home button click
  await navigate(`http://127.0.0.1:${SITE_PORT}/player.html`);
  await waitFor(`!!document.querySelector('stream-frame-overlay')`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 300 });
  await sleep(500);
  await shot('07-home-button.png');
  const hy = (await ev('innerHeight')) - 60;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 60, y: hy });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 60, y: hy, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 60, y: hy, button: 'left', clickCount: 1 });
  check('Home button click returns to the start page', await waitFor(`location.href === ${JSON.stringify(HOME)}`, 4000));
} catch (e) {
  console.log('ERROR', e.message);
  results.push([false, 'exception']);
} finally {
  chrome.kill();
  server.close();
  setTimeout(() => rmSync(PROFILE, { recursive: true, force: true }), 500);
  const failed = results.filter((r) => !r[0]).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  setTimeout(() => process.exit(failed ? 1 : 0), 700);
}
