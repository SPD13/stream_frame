// Background worker: the link between the "Send from your phone" server (lib/remote.py)
// and the browser. Keeps a WebSocket to the server's localhost control port, pushes the
// Configuration › Server settings to it, publishes its status for the start page, and
// opens the links phones send (asking first on the page if a video is playing).
importScripts('settings.js');

const SF = globalThis.StreamFrame;
const CONTROL_URL = `ws://127.0.0.1:${SF.CONTROL_PORT}/ws`;
const PING_MS = 20000; // WebSocket traffic keeps an MV3 service worker alive (Chrome 116+)
const MAX_RETRY_MS = 10000;

let ws = null;
let pingTimer = 0;
let retryTimer = 0;
let retryMs = 1000;

function setStatus(status) {
  chrome.storage.session.set({ serverStatus: status }).catch(() => {});
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

async function sendSettings() {
  const { server } = await SF.loadSettings();
  send({ type: 'settings', settings: server });
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(retryTimer);
  let sock;
  try {
    sock = new WebSocket(CONTROL_URL);
  } catch (_) {
    return scheduleRetry();
  }
  ws = sock;
  sock.onopen = () => {
    retryMs = 1000;
    sendSettings();
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping' }), PING_MS);
  };
  sock.onmessage = (e) => onMessage(e.data);
  sock.onclose = () => {
    if (ws !== sock) return;
    clearInterval(pingTimer);
    ws = null;
    setStatus({ running: false });
    scheduleRetry();
  };
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retryMs);
  retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
}

function onMessage(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch (_) {
    return;
  }
  if (m.type === 'status') {
    setStatus({ running: true, ...m.status });
  } else if (m.type === 'open' && typeof m.url === 'string') {
    openLink(m).then(
      (status) => send({ type: 'result', id: m.id, status }),
      () => send({ type: 'result', id: m.id, status: 'error' })
    );
  }
}

// Opens a link in the tab the user is looking at. The content script answers
// 'no-video' straight away, or shows a prompt and answers 'yes', 'no' or 'expired'.
async function openLink({ id, url, serviceName }) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) {
    await chrome.tabs.create({ url });
    return 'opened';
  }
  let answer = 'no-video';
  try {
    answer = await chrome.tabs.sendMessage(tab.id, { type: 'sf-link', id, serviceName });
  } catch (_) {
    // No content script (start page, chrome:// pages): nothing is playing.
  }
  if (answer === 'no') return 'declined';
  if (answer === 'expired') return 'expired';
  await chrome.tabs.update(tab.id, { url });
  return 'opened';
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'sf-wake') connect();
  else if (msg.type === 'sf-link-prompting') send({ type: 'result', id: msg.id, status: 'prompting' });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.server) sendSettings();
});

// Wake-ups: browser start, install/update, and a 30 s alarm in case the worker was
// stopped while the server was down.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.onAlarm.addListener((a) => a.name === 'sf-reconnect' && connect());
chrome.alarms.create('sf-reconnect', { periodInMinutes: 0.5 });
connect();
