'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const talkBridge = require('./talk-bridge');

// --- Window role, passed through additionalArguments ------------------------
function argValue(name) {
  const prefix = '--' + name + '=';
  const found = process.argv.find(function (arg) { return arg.startsWith(prefix); });
  return found ? found.slice(prefix.length) : '';
}

const ROLE = argValue('hub-role') || 'main';   // main | call | child
const SERVER_ID = argValue('hub-server') || '';
const MINIMAL = argValue('hub-minimal') === '1';
const INTERCEPT = argValue('hub-intercept') === '1';
const AUTOJOIN = argValue('hub-autojoin') === '1';
const CONFIRM_DEVICE = argValue('hub-confirm-device') === '1';
const WATCH_LEAVE = ROLE === 'call';

contextBridge.exposeInMainWorld('nextcloudHub', {
  isDesktopClient: true,
  version: '1.5.0',
  role: ROLE,
  serverId: SERVER_ID,
  // Used by the error page, which is loaded inside a main window.
  retry: function (id) { return ipcRenderer.invoke('hub:retry', id || SERVER_ID); },
  openSetup: function () { return ipcRenderer.invoke('hub:open-setup'); }
});

// --- Injecting the Talk bridge into the page's main world -------------------
function injectTalkBridge() {
  try {
    const script = document.createElement('script');
    script.textContent = talkBridge.buildScript({
      minimal: MINIMAL,
      intercept: INTERCEPT,
      autoJoin: AUTOJOIN,
      confirmDevice: CONFIRM_DEVICE,
      watchLeave: WATCH_LEAVE,
      // The popup polls faster so a call ending remotely is noticed quickly.
      pollMs: ROLE === 'call' ? 300 : 600
    });
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  } catch (err) { /* not a Nextcloud page */ }
}

function runInPage(expression) {
  try {
    const script = document.createElement('script');
    script.textContent = expression;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  } catch (err) { /* ignored */ }
}

// Inject as early as the document allows, then again at the usual milestones.
// The bridge guards against running twice; missing the first chance used to
// mean auto-join never happened.
injectTalkBridge();
document.addEventListener('DOMContentLoaded', injectTalkBridge);
window.addEventListener('load', injectTalkBridge);

// --- Main window: detect a call starting and report it ----------------------
if (ROLE === 'main') {
  // Preferred path: the join was stopped before Talk could create a session.
  document.addEventListener('nchub:call-intent', function (event) {
    const detail = event.detail || {};
    if (!detail.token) return;
    ipcRenderer.send('hub:call-intent', { serverId: SERVER_ID, token: detail.token });
  });

  // Fallback: interception missed and the call started here anyway.
  document.addEventListener('nchub:call-state', function (event) {
    const detail = event.detail || {};
    if (!detail.inCall || !detail.token) return;
    ipcRenderer.send('hub:call-started', {
      serverId: SERVER_ID,
      token: detail.token,
      href: detail.href,
      source: detail.source
    });
  });

  ipcRenderer.on('hub:leave-call', function () {
    runInPage('try { window.__nchubLeaveCall && window.__nchubLeaveCall(); } catch (e) {}');
  });
}

// --- Call window: auto-join, then close itself when the call ends ------------
if (ROLE === 'call') {
  let hasJoined = false;
  let closeTimer = null;
  let ended = false;

  const reportEnded = function () {
    if (ended) return;
    ended = true;
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    ipcRenderer.send('hub:call-ended', { serverId: SERVER_ID });
  };

  ipcRenderer.on('hub:auto-join', function () {
    injectTalkBridge();
    runInPage('try { window.__nchubAutoJoin && window.__nchubAutoJoin(60); } catch (e) {}');
  });

  // Fast path: the hang-up itself was observed, so close straight away.
  document.addEventListener('nchub:call-ended-now', function () {
    reportEnded();
  });

  // Fallback: the call ended some other way (remote hang-up, connection lost).
  document.addEventListener('nchub:call-state', function (event) {
    const detail = event.detail || {};

    if (detail.inCall) {
      hasJoined = true;
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      return;
    }

    // Before the first join, inCall is legitimately false: ignore it.
    if (!hasJoined || ended) return;

    // Brief grace period: Talk reports false for an instant while renegotiating.
    if (closeTimer) return;
    closeTimer = setTimeout(function () {
      closeTimer = null;
      reportEnded();
    }, 500);
  });
}

// --- Notification counter (main window only) --------------------------------
const NOTIFICATION_SELECTORS = [
  '.notifications-button .notification-container__counter',
  '#notifications .notifications-button .badge',
  '.header-menu__trigger .notification-counter',
  '[data-notification-count]'
];

function readNotificationCount() {
  for (const selector of NOTIFICATION_SELECTORS) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const raw = el.getAttribute('data-notification-count') || el.textContent || '';
    const parsed = parseInt(String(raw).replace(/\D+/g, ''), 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const match = /^\((\d+)\)/.exec(document.title || '');
  return match ? parseInt(match[1], 10) : 0;
}

let lastCount = -1;

function reportCount() {
  if (ROLE !== 'main') return;
  try {
    const count = readNotificationCount();
    if (count !== lastCount) {
      lastCount = count;
      ipcRenderer.send('hub:notification-count', { serverId: SERVER_ID, count: count });
    }
  } catch (err) { /* ignored */ }
}

window.addEventListener('DOMContentLoaded', function () {
  reportCount();
  setInterval(reportCount, 4000);
  const titleEl = document.querySelector('title');
  if (titleEl) new MutationObserver(reportCount).observe(titleEl, { childList: true });
  try { document.documentElement.classList.add('nextcloud-hub-desktop'); } catch (err) { /* ignored */ }
});
