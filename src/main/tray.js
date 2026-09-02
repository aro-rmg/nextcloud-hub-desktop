'use strict';

const { Tray, Menu, nativeImage, app } = require('electron');
const config = require('./config');
const windows = require('./windows');
const paths = require('./paths');

let tray = null;
const counts = new Map();   // serverId -> notification count

function create() {
  const iconPath = paths.trayIcon();
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  if (process.platform === 'darwin') {
    image = image.resize({ width: 18, height: 18 });
  }

  tray = new Tray(image);
  refresh();

  tray.on('click', function () {
    const servers = config.list();
    if (servers.length === 0) return windows.openSetupWindow();
    // Single server: focus it directly. Several: open the menu.
    if (servers.length === 1) {
      const win = windows.getMainWindow(servers[0].id);
      if (win && win.isVisible() && !win.isMinimized()) return win.focus();
      return windows.focusServer(servers[0].id);
    }
    tray.popUpContextMenu();
  });

  return tray;
}

function totalCount() {
  return Array.from(counts.values()).reduce(function (sum, value) { return sum + value; }, 0);
}

function refresh() {
  if (!tray || tray.isDestroyed()) return;

  const servers = config.list();
  const items = [];

  for (const server of servers) {
    const count = counts.get(server.id) || 0;
    items.push({
      label: server.label + (count > 0 ? '  (' + count + ')' : ''),
      submenu: [
        { label: 'Open', click: function () { windows.focusServer(server.id); } },
        {
          label: 'Talk',
          click: function () {
            const win = windows.focusServer(server.id);
            if (win) win.webContents.loadURL(server.url + '/apps/spreed/');
          }
        },
        {
          label: 'Dashboard',
          click: function () {
            const win = windows.focusServer(server.id);
            if (win) win.webContents.loadURL(server.url + '/apps/dashboard/');
          }
        }
      ]
    });
  }

  if (servers.length === 0) {
    items.push({ label: 'No server configured', enabled: false });
  }

  items.push({ type: 'separator' });
  items.push({ label: 'Manage servers...', click: function () { windows.openSetupWindow(); } });
  items.push({
    label: 'Minimise to tray on close',
    type: 'checkbox',
    checked: Boolean(config.get('minimizeToTray')),
    click: function (item) { config.set('minimizeToTray', item.checked); }
  });
  items.push({ type: 'separator' });
  items.push({
    label: 'Quit',
    click: function () { app.isQuitting = true; app.quit(); }
  });

  tray.setContextMenu(Menu.buildFromTemplate(items));

  const total = totalCount();
  tray.setToolTip(total > 0 ? 'Nextcloud Hub - ' + total + ' notification(s)' : 'Nextcloud Hub');
}

/**
 * Per-server unread badge.
 *
 * Each platform exposes this differently: Windows overlays the taskbar icon,
 * macOS writes a dock badge, and Linux uses a launcher count where the desktop
 * environment supports it. setOverlayIcon does not exist off Windows, so it
 * must be guarded rather than called blindly.
 */
function setBadge(serverId, count) {
  const value = Number(count) || 0;
  counts.set(serverId, value);
  refresh();

  const total = totalCount();

  if (process.platform === 'darwin') {
    if (app.dock) app.dock.setBadge(total > 0 ? String(total) : '');
    return;
  }

  if (process.platform === 'linux') {
    if (typeof app.setBadgeCount === 'function') app.setBadgeCount(total);
    return;
  }

  const win = windows.getMainWindow(serverId);
  if (!win || typeof win.setOverlayIcon !== 'function') return;

  if (value <= 0) return win.setOverlayIcon(null, '');

  const label = value > 99 ? '99+' : String(value);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">' +
    '<circle cx="16" cy="16" r="15" fill="#c9302c"/>' +
    '<text x="16" y="21" font-family="sans-serif" font-size="' +
    (label.length > 2 ? 12 : 15) + '" font-weight="bold" fill="#ffffff" text-anchor="middle">' +
    label + '</text></svg>';

  const overlay = nativeImage.createFromDataURL(
    'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
  );
  win.setOverlayIcon(overlay, value + ' notification(s)');
}

function forget(serverId) {
  counts.delete(serverId);
  refresh();
}

function destroy() {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

module.exports = { create: create, refresh: refresh, setBadge: setBadge, forget: forget, destroy: destroy };
