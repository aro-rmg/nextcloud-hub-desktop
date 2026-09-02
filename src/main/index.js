'use strict';

const { app, ipcMain, dialog, shell, session, Notification, BrowserWindow } = require('electron');
const path = require('path');

const config = require('./config');
const paths = require('./paths');
const windows = require('./windows');
const permissions = require('./permissions');
const menu = require('./menu');
const tray = require('./tray');

// --- Single instance --------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', function () {
    const servers = config.list();
    if (servers.length === 0) return windows.openSetupWindow();
    windows.focusServer(servers[0].id);
  });
}

// Windows needs this for notifications to carry the right application name.
if (process.platform === 'win32') {
  app.setAppUserModelId('org.antoine.nextcloudhub');
}

// Screen sharing under Wayland goes through PipeWire.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

app.isQuitting = false;

app.whenReady().then(function () {
  permissions.setupAll();
  setupIpc();
  menu.build();
  tray.create();

  const servers = config.list();
  if (servers.length === 0) {
    windows.openSetupWindow();
  } else {
    for (const server of servers) {
      if (server.openAtStartup !== false) {
        const win = windows.createMainWindow(server.id);
        attachCloseBehaviour(win, server.id);
        setupDownloads(server.id);
      }
    }
  }
});

/** Closing a main window hides it to the tray instead of quitting. */
function attachCloseBehaviour(win, serverId) {
  if (!win) return;
  win.on('close', function (event) {
    if (app.isQuitting) return;
    if (!config.get('minimizeToTray')) return;
    event.preventDefault();
    win.hide();
  });
}

app.on('window-all-closed', function () {
  // macOS convention: the app stays alive with no windows open.
  if (process.platform === 'darwin') return;
  if (!config.get('minimizeToTray')) app.quit();
});

app.on('activate', function () {
  const servers = config.list();
  if (servers.length > 0) windows.focusServer(servers[0].id);
});

app.on('before-quit', function () {
  app.isQuitting = true;
  tray.destroy();
});

// --- Downloads, per server session ------------------------------------------
const downloadsReady = new Set();

function setupDownloads(serverId) {
  const partition = config.partitionFor(serverId);
  if (downloadsReady.has(partition)) return;
  downloadsReady.add(partition);

  session.fromPartition(partition).on('will-download', function (event, item) {
    const filename = item.getFilename();
    item.once('done', function (doneEvent, state) {
      if (state === 'completed') {
        const savePath = item.getSavePath();
        if (Notification.isSupported()) {
          const notification = new Notification({ title: 'Download complete', body: filename });
          notification.on('click', function () { shell.showItemInFolder(savePath); });
          notification.show();
        }
      } else if (state === 'interrupted') {
        dialog.showErrorBox('Download interrupted', filename + ' could not be downloaded.');
      }
    });
  });
}

// --- IPC --------------------------------------------------------------------
function setupIpc() {
  ipcMain.handle('hub:add-server', async function (event, payload) {
    const input = payload || {};
    const url = config.normalizeServerUrl(input.url);
    if (!url) return { ok: false, error: 'Invalid address.' };

    const existing = config.list().find(function (server) { return server.url === url; });
    if (existing) return { ok: false, error: 'This server is already registered.' };

    const probeResult = await probe(url, Boolean(input.allowInsecureCertificates));
    if (!probeResult.ok) return { ok: false, error: probeResult.error };

    const server = config.addServer({
      url: url,
      label: (input.label || '').trim() || undefined,
      allowInsecureCertificates: Boolean(input.allowInsecureCertificates)
    });

    permissions.setupServer(server);
    setupDownloads(server.id);
    const win = windows.createMainWindow(server.id);
    attachCloseBehaviour(win, server.id);
    menu.build();
    tray.refresh();

    return { ok: true, server: server, version: probeResult.version };
  });

  ipcMain.handle('hub:list-servers', function () {
    return config.list().map(function (server) {
      return { id: server.id, label: server.label, url: server.url, color: server.color };
    });
  });

  ipcMain.handle('hub:remove-server', async function (event, id) {
    const server = config.getServer(id);
    if (!server) return { ok: false, error: 'Server not found.' };

    const answer = await dialog.showMessageBox(windows.getSetupWindow(), {
      type: 'warning',
      buttons: ['Remove', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Remove server',
      message: 'Remove ' + server.label + '?',
      detail: 'The local session for this server is erased. Other servers are unaffected.'
    });
    if (answer.response !== 0) return { ok: false, cancelled: true };

    windows.closeServerWindows(id);
    try {
      await session.fromPartition(config.partitionFor(id)).clearStorageData();
    } catch (err) { /* session never opened */ }
    config.removeServer(id);
    tray.forget(id);
    menu.build();

    return { ok: true };
  });

  ipcMain.handle('hub:sign-out', async function (event, id) {
    const server = config.getServer(id);
    if (!server) return { ok: false, error: 'Server not found.' };

    const answer = await dialog.showMessageBox(windows.getSetupWindow(), {
      type: 'question',
      buttons: ['Sign out', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Sign out',
      message: 'Sign out of ' + server.label + '?',
      detail: 'The stored session for this server is cleared and the login page is shown again. '
        + 'The server stays in your list, and other servers are unaffected.'
    });
    if (answer.response !== 0) return { ok: false, cancelled: true };

    windows.closeCallWindow(id);
    try {
      const ses = session.fromPartition(config.partitionFor(id));
      // Cleared wholesale rather than by named storage: the accepted names have
      // shifted between Electron releases (WebSQL is gone from Chromium
      // entirely), and signing out wants everything cleared anyway.
      await ses.clearStorageData();
      await ses.clearCache();
    } catch (err) { /* session never opened */ }

    tray.forget(id);
    const win = windows.getMainWindow(id);
    if (win) win.loadURL(server.url);

    return { ok: true };
  });

  ipcMain.handle('hub:open-server', function (event, id) {
    const win = windows.focusServer(id);
    if (win) attachCloseBehaviour(win, id);
    setupDownloads(id);
    return Boolean(win);
  });

  ipcMain.handle('hub:retry', function (event, serverId) {
    const server = config.getServer(serverId);
    if (!server) { windows.openSetupWindow(); return false; }
    const win = windows.getOrCreateMainWindow(serverId);
    if (win) win.loadURL(server.url);
    return true;
  });

  ipcMain.handle('hub:open-setup', function () {
    windows.openSetupWindow();
    return true;
  });

  ipcMain.handle('hub:quit', function () {
    app.isQuitting = true;
    app.quit();
  });

  ipcMain.on('hub:notification-count', function (event, payload) {
    if (!payload || !payload.serverId) return;
    tray.setBadge(payload.serverId, payload.count);
  });

  // Preferred path: a join was intercepted before Talk created a session
  ipcMain.on('hub:call-intent', function (event, payload) {
    if (!payload || !payload.serverId || !payload.token) return;
    if (!windows.shouldDetach(payload.serverId)) return;
    windows.handleCallIntent(payload.serverId, payload.token);
  });

  // Fallback: interception missed and Talk entered a call in the main window
  ipcMain.on('hub:call-started', function (event, payload) {
    if (!payload || !payload.serverId || !payload.token) return;
    if (!windows.shouldDetach(payload.serverId)) return;
    windows.detachCall(payload.serverId, payload.token);
  });

  // The detached call ended or was left: close the popup
  ipcMain.on('hub:call-ended', function (event, payload) {
    if (!payload || !payload.serverId) return;
    if (config.get('closeCallWindowOnEnd') === false) return;
    windows.closeCallWindow(payload.serverId);
  });
}

// --- Reachability check for an instance -------------------------------------
function probe(serverUrl, allowInsecure) {
  return new Promise(function (resolve) {
    let url;
    try {
      url = new URL(serverUrl + '/status.php');
    } catch (err) {
      return resolve({ ok: false, error: 'Adresse invalide.' });
    }

    const client = url.protocol === 'http:' ? require('http') : require('https');
    const options = { timeout: 8000, rejectUnauthorized: !allowInsecure };

    const request = client.get(url, options, function (response) {
      let body = '';
      response.on('data', function (chunk) {
        body += chunk;
        if (body.length > 8192) request.destroy();
      });
      response.on('end', function () {
        try {
          const status = JSON.parse(body);
          if (status && status.installed !== undefined) {
            return resolve({ ok: true, version: status.versionstring });
          }
        } catch (err) { /* non-JSON body */ }
        resolve({ ok: false, error: 'That address responds, but does not look like a Nextcloud instance.' });
      });
    });

    request.on('timeout', function () {
      request.destroy();
      resolve({ ok: false, error: 'The server did not respond (timed out).' });
    });

    request.on('error', function (err) {
      let message = 'Could not reach the server.';
      if (err.code === 'ENOTFOUND') message = 'Domain name not found.';
      else if (err.code === 'ECONNREFUSED') message = 'Connection refused by the server.';
      else if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || /TLS|CERT/i.test(err.code || '')) {
        message = 'Invalid TLS certificate. Tick the self-signed certificate option if that is expected.';
      }
      resolve({ ok: false, error: message });
    });
  });
}

app.on('web-contents-created', function (event, contents) {
  contents.on('will-attach-webview', function (attachEvent) { attachEvent.preventDefault(); });
});
