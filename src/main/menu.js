'use strict';

const { Menu, app, shell, dialog, BrowserWindow } = require('electron');
const config = require('./config');
const windows = require('./windows');

/** Server owning the window currently in the foreground. */
function currentServerId() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) {
    for (const entry of windows.mainWindows.entries()) {
      if (entry[1] === focused) return entry[0];
    }
  }
  const first = config.list()[0];
  return first ? first.id : null;
}

function goHome() {
  const serverId = currentServerId();
  const server = config.getServer(serverId);
  if (!server) return;
  const win = windows.focusServer(serverId);
  if (win) win.webContents.loadURL(server.url);
}

function changeZoom(delta) {
  const next = Math.min(4, Math.max(-3, (config.get('zoomLevel') || 0) + delta));
  config.set('zoomLevel', next);
  windows.applyZoomToAll(next);
}

function serversSubmenu() {
  const servers = config.list();
  const items = [];

  if (servers.length === 0) {
    items.push({ label: 'No server configured', enabled: false });
  } else {
    servers.forEach(function (server, index) {
      items.push({
        label: server.label,
        accelerator: index < 9 ? 'CmdOrCtrl+Shift+' + (index + 1) : undefined,
        click: function () { windows.focusServer(server.id); }
      });
    });
  }

  items.push({ type: 'separator' });
  items.push({
    label: 'Open all servers',
    click: function () {
      for (const server of config.list()) windows.getOrCreateMainWindow(server.id);
    }
  });
  items.push({
    label: 'Manage servers...',
    accelerator: 'CmdOrCtrl+Shift+S',
    click: function () { windows.openSetupWindow(); }
  });

  return items;
}

function build() {
  const isMac = process.platform === 'darwin';

  const template = [];

  // macOS expects a first menu named after the application, carrying the
  // standard About / Services / Hide / Quit roles.
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: 'About ' + app.name },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit ' + app.name }
      ]
    });
  }

  template.push.apply(template, [
    {
      label: 'File',
      submenu: [
        {
          label: 'New window',
          accelerator: 'CmdOrCtrl+N',
          click: function () {
            const serverId = currentServerId();
            const server = config.getServer(serverId);
            if (server) windows.openChildWindow(serverId, server.url);
          }
        },
        { type: 'separator' },
        {
          label: 'Open configuration file',
          click: function () { shell.showItemInFolder(config.CONFIG_FILE); }
        },
        { type: 'separator' },
        { label: 'Close window', accelerator: 'CmdOrCtrl+W', role: 'close' },
        {
          label: 'Quit',
          accelerator: 'CmdOrCtrl+Q',
          click: function () { app.isQuitting = true; app.quit(); }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'selectAll', label: 'Select all' }
      ]
    },
    { label: 'Servers', submenu: serversSubmenu() },
    {
      label: 'Go',
      submenu: [
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          click: function () {
            const win = BrowserWindow.getFocusedWindow();
            if (win && win.webContents.navigationHistory.canGoBack()) {
              win.webContents.navigationHistory.goBack();
            }
          }
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          click: function () {
            const win = BrowserWindow.getFocusedWindow();
            if (win && win.webContents.navigationHistory.canGoForward()) {
              win.webContents.navigationHistory.goForward();
            }
          }
        },
        { type: 'separator' },
        { label: 'Home', accelerator: 'Alt+Home', click: goHome }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: 'Force reload', accelerator: 'CmdOrCtrl+Shift+R', role: 'forceReload' },
        { type: 'separator' },
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+Plus', click: function () { changeZoom(0.5); } },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: function () { changeZoom(-0.5); } },
        {
          label: 'Actual size',
          accelerator: 'CmdOrCtrl+0',
          click: function () { changeZoom(-(config.get('zoomLevel') || 0)); }
        },
        { type: 'separator' },
        { label: 'Full screen', accelerator: 'F11', role: 'togglefullscreen' },
        { label: 'Developer tools', accelerator: 'CmdOrCtrl+Shift+I', role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Nextcloud documentation', click: function () { shell.openExternal('https://docs.nextcloud.com/'); } },
        {
          label: 'About',
          click: function () {
            const servers = config.list()
              .map(function (server) { return '  - ' + server.label + ' (' + server.url + ')'; })
              .join('\n') || '  none';
            dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
              type: 'info',
              title: 'About',
              message: 'Nextcloud Hub Desktop',
              detail: 'Version ' + app.getVersion() + '\n' +
                'Electron ' + process.versions.electron + '\n' +
                'Chromium ' + process.versions.chrome + '\n\n' +
                'Configured servers:\n' + servers + '\n\n' +
                'Unofficial client wrapping the full Nextcloud Hub web interface.'
            });
          }
        }
      ]
    }
  ]);

  // Quit already lives in the application menu on macOS.
  if (isMac) {
    const file = template.find(function (item) { return item.label === 'File'; });
    if (file) {
      file.submenu = file.submenu.filter(function (item) { return item.label !== 'Quit'; });
    }
    template.push({ role: 'windowMenu' });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { build: build, currentServerId: currentServerId };
