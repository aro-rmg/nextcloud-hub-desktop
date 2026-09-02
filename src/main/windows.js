'use strict';

const { BrowserWindow, shell, screen } = require('electron');
const config = require('./config');
const routing = require('./routing');
const paths = require('./paths');

const PRELOAD = paths.PRELOAD;
// Local pages get a preload with no relative requires, so they keep working
// even when the window is sandboxed.
const LOCAL_PRELOAD = paths.LOCAL_PRELOAD;
const ICON = paths.windowIcon();

const mainWindows = new Map();   // serverId -> BrowserWindow
const callWindows = new Map();   // serverId -> BrowserWindow
const childWindows = new Set();
let setupWindow = null;

/** Loop guard: stops an in-flight detach from re-triggering itself. */
const detaching = new Map();     // serverId -> timestamp
const lastToken = new Map();     // serverId -> conversation token most recently detached

/**
 * Servers whose main window is mid-handover and may bypass beforeunload.
 *
 * Talk installs a beforeunload guard while a call is running. Electron cancels
 * such a navigation by default unless a will-prevent-unload listener calls
 * preventDefault, so without this the main window silently refuses to leave the
 * conversation and Talk reports a duplicate session when the popup joins.
 */
const forceUnload = new Set();   // serverId

function webPreferencesFor(serverId, role, extra) {
  const options = extra || {};
  return {
    preload: PRELOAD,
    partition: config.partitionFor(serverId),
    contextIsolation: true,
    nodeIntegration: false,
    // Required: the preload requires a relative module, which a sandboxed
    // preload cannot do. Sandboxing it would kill the bridge silently.
    sandbox: false,
    webviewTag: false,
    spellcheck: true,
    backgroundThrottling: false,
    additionalArguments: [
      '--hub-role=' + role,
      '--hub-server=' + serverId,
      '--hub-minimal=' + (options.minimal ? '1' : '0'),
      '--hub-autojoin=' + (options.autoJoin ? '1' : '0'),
      '--hub-confirm-device=' + (options.confirmDevice ? '1' : '0'),
      // Only the main window stops calls before they start; the popup is the
      // window that is meant to join.
      '--hub-intercept=' + (role === 'main' && config.get('interceptCallStart') !== false ? '1' : '0')
    ]
  };
}

// ---------------------------------------------------------------------------
// Navigation policy
// ---------------------------------------------------------------------------

function attachNavigationPolicy(webContents, options) {
  const opts = options || {};
  const serverId = opts.serverId;

  webContents.setWindowOpenHandler(function (details) {
    const decision = routing.route(details.url, {
      serverId: serverId,
      disposition: details.disposition,
      features: details.features
    });

    if (decision.action === 'external') {
      shell.openExternal(details.url).catch(function () {});
      return { action: 'deny' };
    }

    if (decision.action === 'server') {
      const win = getOrCreateMainWindow(decision.serverId);
      win.webContents.loadURL(details.url);
      win.show();
      win.focus();
      return { action: 'deny' };
    }

    if (decision.action === 'call') {
      openCallWindow(decision.serverId, details.url, { autoJoin: true });
      return { action: 'deny' };
    }

    if (decision.action === 'window') {
      openChildWindow(decision.serverId, details.url);
      return { action: 'deny' };
    }

    // 'main': ordinary navigation, brought back to the main window
    if (opts.role === 'call' || opts.role === 'child') {
      const target = getOrCreateMainWindow(serverId);
      target.webContents.loadURL(details.url);
      target.show();
      target.focus();
    } else {
      webContents.loadURL(details.url);
    }
    return { action: 'deny' };
  });

  webContents.on('will-navigate', function (event, url) {
    const decision = routing.route(url, { serverId: serverId });
    if (decision.action === 'external') {
      event.preventDefault();
      shell.openExternal(url).catch(function () {});
      return;
    }
    if (decision.action === 'server') {
      event.preventDefault();
      const win = getOrCreateMainWindow(decision.serverId);
      win.webContents.loadURL(url);
      win.show();
      win.focus();
      return;
    }
    // Internal navigation: left alone, the SPA handles its own routing
  });

  webContents.on('will-redirect', function (event, url) {
    if (!/^https?:/i.test(url) && !url.startsWith('about:') && !url.startsWith('data:')) {
      event.preventDefault();
      shell.openExternal(url).catch(function () {});
    }
  });
}

// ---------------------------------------------------------------------------
// Window geometry
// ---------------------------------------------------------------------------

function sanitizeBounds(bounds, fallbackWidth, fallbackHeight) {
  const result = {
    width: bounds && bounds.width ? bounds.width : fallbackWidth,
    height: bounds && bounds.height ? bounds.height : fallbackHeight
  };
  if (bounds && Number.isInteger(bounds.x) && Number.isInteger(bounds.y)) {
    const visible = screen.getAllDisplays().some(function (display) {
      const area = display.workArea;
      return bounds.x >= area.x - 50 && bounds.y >= area.y - 50 &&
        bounds.x < area.x + area.width && bounds.y < area.y + area.height;
    });
    if (visible) { result.x = bounds.x; result.y = bounds.y; }
  }
  return result;
}

/** Cascade windows of different servers so they do not stack exactly. */
function cascadeOffset(index) {
  return { x: 40 * index, y: 32 * index };
}

// ---------------------------------------------------------------------------
// Main window, one per server
// ---------------------------------------------------------------------------

function createMainWindow(serverId, startUrl) {
  const server = config.getServer(serverId);
  if (!server) return null;

  const saved = config.getWindowState(serverId);
  const bounds = sanitizeBounds(saved, 1400, 900);

  if (!Number.isInteger(bounds.x)) {
    const index = config.list().findIndex(function (entry) { return entry.id === serverId; });
    const offset = cascadeOffset(Math.max(0, index));
    const area = screen.getPrimaryDisplay().workArea;
    bounds.x = area.x + 40 + offset.x;
    bounds.y = area.y + 30 + offset.y;
  }

  const win = new BrowserWindow(Object.assign({}, bounds, {
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: server.label + ' - Nextcloud Hub',
    backgroundColor: server.color || '#00679e',
    icon: ICON,
    webPreferences: webPreferencesFor(serverId, 'main')
  }));

  if (saved.maximized) win.maximize();

  mainWindows.set(serverId, win);
  attachNavigationPolicy(win.webContents, { serverId: serverId, role: 'main' });

  win.webContents.on('will-prevent-unload', function (event) {
    // Only bypass the guard for a handover we initiated. Everywhere else the
    // warning is legitimate (unsaved document in Office, for instance).
    if (forceUnload.has(serverId)) event.preventDefault();
  });

  win.webContents.on('did-finish-load', function () {
    win.webContents.setZoomLevel(config.get('zoomLevel') || 0);
  });

  win.once('ready-to-show', function () {
    if (!config.get('startMinimized')) win.show();
  });

  const persistBounds = function () {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const current = maximized ? config.getWindowState(serverId) : win.getBounds();
    config.setWindowState(serverId, {
      width: current.width,
      height: current.height,
      x: Number.isInteger(current.x) ? current.x : null,
      y: Number.isInteger(current.y) ? current.y : null,
      maximized: maximized
    });
  };
  win.on('resize', persistBounds);
  win.on('move', persistBounds);
  win.on('maximize', persistBounds);
  win.on('unmaximize', persistBounds);

  win.on('closed', function () {
    mainWindows.delete(serverId);
    forceUnload.delete(serverId);
  });

  win.webContents.on('did-fail-load', function (event, errorCode, description, validatedURL, isMainFrame) {
    if (!isMainFrame || errorCode === -3) return;
    const params = new URLSearchParams({
      code: String(errorCode),
      description: description || '',
      url: validatedURL || '',
      server: serverId
    });
    win.loadFile(paths.renderer('error.html'), { search: params.toString() });
  });

  win.loadURL(startUrl || server.url);
  return win;
}

function getMainWindow(serverId) {
  const win = mainWindows.get(serverId);
  return win && !win.isDestroyed() ? win : null;
}

function getOrCreateMainWindow(serverId) {
  return getMainWindow(serverId) || createMainWindow(serverId);
}

function focusServer(serverId) {
  const win = getOrCreateMainWindow(serverId);
  if (!win) return null;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

// ---------------------------------------------------------------------------
// Detached Talk call window, one per server, reused
// ---------------------------------------------------------------------------

/** Ask the call window's preload to join as soon as Talk has mounted. */
function armAutoJoin(win) {
  let fired = false;
  const handler = function () {
    if (fired || win.isDestroyed()) return;
    fired = true;
    win.webContents.send('hub:auto-join');
  };
  win.webContents.once('did-finish-load', handler);
  // Safety net in case did-finish-load already fired
  setTimeout(handler, 2500);
}

function openCallWindow(serverId, url, options) {
  const server = config.getServer(serverId);
  if (!server) return null;
  const opts = options || {};
  const saved = config.get('callWindow') || {};
  const minimal = config.get('minimalCallWindow') !== false;

  let win = callWindows.get(serverId);
  if (win && !win.isDestroyed()) {
    win.webContents.loadURL(url);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (opts.autoJoin && config.get('autoJoinInCallWindow')) armAutoJoin(win);
    return win;
  }

  // Parented to the main window so the popup floats above it, while the main
  // window stays fully interactive underneath for other work.
  const parent = getMainWindow(serverId);

  win = new BrowserWindow({
    width: saved.width || 1120,
    height: saved.height || 760,
    minWidth: 520,
    minHeight: 420,
    parent: parent || undefined,
    modal: false,
    show: false,
    title: 'Call - ' + server.label,
    // Matches Nextcloud's page background so there is no dark seam around the
    // rounded content card, and no dark flash before the first paint.
    backgroundColor: config.get('callWindowBackground') || '#f5f5f5',
    icon: ICON,
    autoHideMenuBar: true,
    // No application menu in the popup: it is a call surface, not a browser.
    webPreferences: webPreferencesFor(serverId, 'call', {
      minimal: minimal,
      // Baked into the page rather than sent over IPC: an IPC message can
      // arrive before the bridge exists, and that shot is then lost.
      autoJoin: Boolean(opts.autoJoin) && config.get('autoJoinInCallWindow') !== false,
      confirmDevice: config.get('confirmDeviceDialog') === true
    })
  });

  win.setMenuBarVisibility(false);

  callWindows.set(serverId, win);
  attachNavigationPolicy(win.webContents, { serverId: serverId, role: 'call' });

  // A call popup must always be closable; its beforeunload guard is noise here.
  win.webContents.on('will-prevent-unload', function (event) {
    event.preventDefault();
  });

  win.once('ready-to-show', function () {
    win.show();
    win.focus();
  });

  win.on('resize', function () {
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();
    config.set('callWindow', { width: bounds.width, height: bounds.height });
  });

  win.on('closed', function () {
    callWindows.delete(serverId);
    detaching.delete(serverId);
    // Bring the chat back where the user left it. Safe now: the popup is gone,
    // so nothing else holds a Talk session on that conversation.
    if (config.get('returnToConversationOnCallEnd') !== false) {
      const token = lastToken.get(serverId);
      const main = getMainWindow(serverId);
      if (token && main && !main.isDestroyed()) {
        main.webContents.loadURL(server.url + '/call/' + token);
        main.focus();
      }
    }
  });

  win.loadURL(url);
  if (opts.autoJoin && config.get('autoJoinInCallWindow')) armAutoJoin(win);
  return win;
}

/** Close the detached call window once the call is over. */
function closeCallWindow(serverId) {
  const win = callWindows.get(serverId);
  if (!win || win.isDestroyed()) return false;
  // destroy() fires 'closed', which clears the lock and restores the chat.
  win.destroy();
  return true;
}

function getCallWindow(serverId) {
  const win = callWindows.get(serverId);
  return win && !win.isDestroyed() ? win : null;
}

// ---------------------------------------------------------------------------
// Automatic detach of a call started in the main window
// ---------------------------------------------------------------------------

/**
 * Where the main window goes once it has handed the call over.
 *
 * It must leave the conversation entirely. Talk grants one session per
 * conversation per Nextcloud login, and both windows share the same cookie
 * jar, so two windows sitting on the same conversation make Talk invalidate
 * one of them with "Duplicate session".
 */
function releaseUrlFor(server) {
  const mode = config.get('mainWindowAfterDetach') || 'talk-list';
  if (mode === 'stay') return null;
  if (mode === 'dashboard') return server.url + '/apps/dashboard/';
  if (mode === 'files') return server.url + '/apps/files/';
  return server.url + '/apps/spreed/';
}

function detachCall(serverId, token, options) {
  const detachOpts = options || {};
  const alreadyInCall = detachOpts.alreadyInCall !== false;
  const server = config.getServer(serverId);
  if (!server) return;

  // Debounce: ignore repeated signals while the handover is in progress
  const previous = detaching.get(serverId) || 0;
  if (Date.now() - previous < 8000) return;
  detaching.set(serverId, Date.now());
  lastToken.set(serverId, token);

  const callUrl = server.url + '/call/' + token;
  const main = getMainWindow(serverId);

  if (!main || main.isDestroyed()) {
    openCallWindow(serverId, callUrl, { autoJoin: true });
    return;
  }

  let opened = false;
  const openPopup = function () {
    if (opened) return;
    opened = true;
    forceUnload.delete(serverId);
    openCallWindow(serverId, callUrl, { autoJoin: true });
  };

  // Step 1: hang up in the main window. Skipped when the join was intercepted,
  // because no call was ever started there.
  if (alreadyInCall && config.get('hangUpOriginalOnDetach') !== false) {
    main.webContents.send('hub:leave-call');
  }

  const release = releaseUrlFor(server);
  if (!release) {
    // 'stay' mode: the user accepts Talk's duplicate-session warning.
    setTimeout(openPopup, 800);
    return;
  }

  // Step 2: navigate the main window off the conversation. With a call running
  // Talk's beforeunload guard would cancel this, so arm the bypass. After an
  // intercepted join there is no call and no guard, so this is immediate.
  if (alreadyInCall) forceUnload.add(serverId);

  main.webContents.once('did-finish-load', function () {
    // The main window has left the conversation: its Talk session is released
    // and the popup can join without colliding with it.
    setTimeout(openPopup, 500);
  });

  setTimeout(function () {
    if (!main.isDestroyed()) {
      main.webContents.loadURL(release).catch(function () { openPopup(); });
    }
  }, alreadyInCall ? 400 : 0);

  // Step 3: fallback if that navigation never completes at all.
  setTimeout(openPopup, 8000);
}

/**
 * The user asked to join a call and the join was blocked in the main window.
 * Move that window off the conversation, then let the popup do the joining, so
 * only one Talk session for this conversation ever exists.
 */
function handleCallIntent(serverId, token) {
  detachCall(serverId, token, { alreadyInCall: false });
}

/** Should a call signal from the main window trigger a detach? */
function shouldDetach(serverId) {
  if (!config.get('autoDetachCallOnStart')) return false;
  if (!config.get('talkCallsInSeparateWindow')) return false;
  const call = getCallWindow(serverId);
  // If the call window is already open it owns the call, nothing to do.
  if (call && call.isVisible()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Child windows and the server manager
// ---------------------------------------------------------------------------

function openChildWindow(serverId, url) {
  const child = new BrowserWindow({
    width: 1100,
    height: 780,
    show: false,
    title: 'Nextcloud',
    backgroundColor: '#ffffff',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: webPreferencesFor(serverId, 'child')
  });

  attachNavigationPolicy(child.webContents, { serverId: serverId, role: 'child' });
  child.once('ready-to-show', function () { child.show(); child.focus(); });
  child.on('closed', function () { childWindows.delete(child); });
  childWindows.add(child);
  child.loadURL(url);
  return child;
}

function openSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return setupWindow;
  }

  setupWindow = new BrowserWindow({
    width: 560,
    height: 680,
    show: false,
    resizable: false,
    title: 'Serveurs - Nextcloud Hub',
    backgroundColor: '#0082c9',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: LOCAL_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: ['--hub-role=setup', '--hub-server=']
    }
  });

  setupWindow.once('ready-to-show', function () { setupWindow.show(); });
  setupWindow.on('closed', function () { setupWindow = null; });
  setupWindow.loadFile(paths.renderer('setup.html'));
  return setupWindow;
}

function getSetupWindow() {
  return setupWindow && !setupWindow.isDestroyed() ? setupWindow : null;
}

function allWindows() {
  const list = [];
  for (const win of mainWindows.values()) if (!win.isDestroyed()) list.push(win);
  for (const win of callWindows.values()) if (!win.isDestroyed()) list.push(win);
  for (const win of childWindows) if (!win.isDestroyed()) list.push(win);
  return list;
}

function applyZoomToAll(level) {
  for (const win of allWindows()) win.webContents.setZoomLevel(level);
}

function closeServerWindows(serverId) {
  const main = getMainWindow(serverId);
  if (main) main.destroy();
  const call = getCallWindow(serverId);
  if (call) call.destroy();
}

module.exports = {
  LOCAL_PRELOAD: LOCAL_PRELOAD,
  createMainWindow: createMainWindow,
  getMainWindow: getMainWindow,
  getOrCreateMainWindow: getOrCreateMainWindow,
  focusServer: focusServer,
  openCallWindow: openCallWindow,
  closeCallWindow: closeCallWindow,
  getCallWindow: getCallWindow,
  detachCall: detachCall,
  handleCallIntent: handleCallIntent,
  shouldDetach: shouldDetach,
  openChildWindow: openChildWindow,
  openSetupWindow: openSetupWindow,
  getSetupWindow: getSetupWindow,
  attachNavigationPolicy: attachNavigationPolicy,
  allWindows: allWindows,
  applyZoomToAll: applyZoomToAll,
  closeServerWindows: closeServerWindows,
  mainWindows: mainWindows
};
