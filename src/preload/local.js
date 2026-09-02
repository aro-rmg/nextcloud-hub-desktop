'use strict';

/**
 * Preload for local application pages (server manager, error page).
 *
 * Deliberately dependency-free: it requires nothing but 'electron'. Local
 * windows may run sandboxed, and a sandboxed preload cannot require relative
 * modules -- doing so throws and silently kills the whole preload, leaving the
 * page with no bridge at all.
 */

const { contextBridge, ipcRenderer } = require('electron');

function argValue(name) {
  const prefix = '--' + name + '=';
  const found = process.argv.find(function (arg) { return arg.startsWith(prefix); });
  return found ? found.slice(prefix.length) : '';
}

contextBridge.exposeInMainWorld('nextcloudHub', {
  isDesktopClient: true,
  version: '1.5.0',
  role: argValue('hub-role') || 'local',
  serverId: argValue('hub-server') || '',
  addServer: function (payload) { return ipcRenderer.invoke('hub:add-server', payload); },
  listServers: function () { return ipcRenderer.invoke('hub:list-servers'); },
  removeServer: function (id) { return ipcRenderer.invoke('hub:remove-server', id); },
  signOut: function (id) { return ipcRenderer.invoke('hub:sign-out', id); },
  openServer: function (id) { return ipcRenderer.invoke('hub:open-server', id); },
  retry: function (id) { return ipcRenderer.invoke('hub:retry', id || argValue('hub-server')); },
  openSetup: function () { return ipcRenderer.invoke('hub:open-setup'); },
  quit: function () { return ipcRenderer.invoke('hub:quit'); }
});
