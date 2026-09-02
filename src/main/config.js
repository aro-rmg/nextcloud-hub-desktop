'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

const DEFAULTS = {
  /**
   * Registered servers. Each one gets its own isolated session, and therefore
   * its own cookies, so two accounts on two instances stay signed in at the
   * same time in two separate windows.
   *
   * { id, label, url, color, additionalHosts: [], allowInsecureCertificates, openAtStartup }
   */
  servers: [],

  // --- Talk call behaviour ----------------------------------------------
  // Pop the call out into its own window as soon as a call starts, with no
  // link click involved (detected from Talk's own SPA state).
  autoDetachCallOnStart: true,
  // Also detach calls opened through a direct link.
  talkCallsInSeparateWindow: true,
  // Leave the call in the originating window after handing over, so the main
  // window is free again and there is no echo.
  hangUpOriginalOnDetach: true,
  // In the detached window, click through to the device-check dialog
  // automatically so the user does not have to press Join a second time.
  autoJoinInCallWindow: true,
  // Also press the confirm button inside that dialog. Off by default: landing
  // on the device chooser and starting the call yourself is the intended flow.
  confirmDeviceDialog: false,
  // Strip the surrounding Hub chrome in the call window: call plus its chat only.
  minimalCallWindow: true,
  // Window background behind the Nextcloud content card. Use a dark value if
  // your instance runs a dark theme, otherwise the seam shows on load.
  callWindowBackground: '#f5f5f5',
  // Close the call window once the call ends or is left.
  closeCallWindowOnEnd: true,
  // Where the main window goes once it has handed the call over. It must leave
  // the conversation: Talk allows one session per conversation per login, so
  // two windows on the same conversation trigger "Duplicate session".
  // 'talk-list' | 'dashboard' | 'files' | 'stay'
  mainWindowAfterDetach: 'talk-list',
  // Stop a call from ever starting in the main window: the join is blocked
  // there and handed to the popup, so only one Talk session is created.
  interceptCallStart: true,
  // Leave the main window wherever it is when the call window closes. Set to
  // true to pull it back to the conversation instead.
  returnToConversationOnCallEnd: false,
  // Detach all of Talk, chat included, not just calls.
  talkChatInSeparateWindow: false,

  // --- Windows -----------------------------------------------------------
  windowStates: {},
  callWindow: { width: 1100, height: 720 },
  minimizeToTray: true,
  startMinimized: false,
  zoomLevel: 0
};

let cache = null;

function load() {
  if (cache) return cache;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    raw = {};
  }
  cache = Object.assign({}, DEFAULTS, raw);
  migrate();
  return cache;
}

/** Migrate from the single-server layout (serverUrl key). */
function migrate() {
  if (!Array.isArray(cache.servers)) cache.servers = [];
  if (cache.serverUrl && cache.servers.length === 0) {
    const url = normalizeServerUrl(cache.serverUrl);
    if (url) {
      cache.servers.push(buildServer({
        url,
        additionalHosts: cache.additionalInternalHosts || [],
        allowInsecureCertificates: Boolean(cache.allowInsecureCertificates)
      }));
    }
  }
  delete cache.serverUrl;
  delete cache.additionalInternalHosts;
  delete cache.allowInsecureCertificates;

  cache.servers = cache.servers
    .filter(function (server) { return server && server.url; })
    .map(function (server) {
      return Object.assign(buildServer({ url: server.url }), server, {
        id: server.id || makeId(server.url),
        additionalHosts: Array.isArray(server.additionalHosts) ? server.additionalHosts : [],
        openAtStartup: server.openAtStartup !== false
      });
    });
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('[config] write failed:', err.message);
  }
}

function save(patch) {
  const current = load();
  cache = Object.assign({}, current, patch || {});
  persist();
  return cache;
}

function get(key) { return load()[key]; }
function set(key, value) { return save({ [key]: value }); }

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

const PALETTE = ['#0082c9', '#46ba61', '#e9a23b', '#c34a4a', '#8e6ecf', '#00a0a0', '#d95f8b'];

function makeId(url) {
  const hash = crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 8);
  let host = 'serveur';
  try {
    host = new URL(url).hostname.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  } catch (err) { /* fall through */ }
  return host + '-' + hash;
}

function buildServer(input) {
  const url = normalizeServerUrl(input.url);
  let host = url;
  try { host = new URL(url).hostname; } catch (err) { /* defaut */ }
  const count = Array.isArray(cache && cache.servers) ? cache.servers.length : 0;
  return {
    id: input.id || makeId(url),
    label: input.label || host,
    url: url,
    color: input.color || PALETTE[count % PALETTE.length],
    additionalHosts: input.additionalHosts || [],
    allowInsecureCertificates: Boolean(input.allowInsecureCertificates),
    openAtStartup: input.openAtStartup !== false
  };
}

function list() { return load().servers; }

function getServer(id) {
  return list().find(function (server) { return server.id === id; }) || null;
}

function addServer(input) {
  const server = buildServer(input);
  const servers = list();
  const existing = servers.findIndex(function (entry) { return entry.url === server.url; });
  if (existing >= 0) {
    servers[existing] = Object.assign({}, servers[existing], server, { id: servers[existing].id });
    persist();
    return servers[existing];
  }
  servers.push(server);
  persist();
  return server;
}

function updateServer(id, patch) {
  const server = getServer(id);
  if (!server) return null;
  Object.assign(server, patch || {});
  persist();
  return server;
}

function removeServer(id) {
  const servers = list();
  const index = servers.findIndex(function (server) { return server.id === id; });
  if (index < 0) return false;
  servers.splice(index, 1);
  const states = load().windowStates || {};
  delete states[id];
  persist();
  return true;
}

/** One Electron partition per server: isolated cookies and storage. */
function partitionFor(serverId) {
  return 'persist:ncs-' + serverId;
}

/** Every host treated as internal for a given server. */
function hostsFor(server) {
  if (!server) return [];
  const hosts = [];
  try { hosts.push(new URL(server.url).hostname.toLowerCase()); } catch (err) { /* ignore */ }
  for (const host of server.additionalHosts || []) {
    if (typeof host === 'string' && host.trim()) hosts.push(host.trim().toLowerCase());
  }
  return hosts;
}

function normalizeServerUrl(input) {
  if (!input) return '';
  let value = String(input).trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/, '');
    return url.origin + pathname;
  } catch (err) {
    return '';
  }
}

function getWindowState(serverId) {
  return (load().windowStates || {})[serverId] || {};
}

function setWindowState(serverId, state) {
  const states = Object.assign({}, load().windowStates || {});
  states[serverId] = state;
  return set('windowStates', states);
}

module.exports = {
  load: load, save: save, get: get, set: set,
  list: list, getServer: getServer, addServer: addServer,
  updateServer: updateServer, removeServer: removeServer,
  partitionFor: partitionFor, hostsFor: hostsFor,
  normalizeServerUrl: normalizeServerUrl, buildServer: buildServer,
  getWindowState: getWindowState, setWindowState: setWindowState,
  CONFIG_FILE: CONFIG_FILE, DEFAULTS: DEFAULTS
};
