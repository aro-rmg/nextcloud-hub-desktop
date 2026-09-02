'use strict';

const { session, desktopCapturer, BrowserWindow } = require('electron');
const config = require('./config');
const routing = require('./routing');

const GRANTED = new Set([
  'media', 'audioCapture', 'videoCapture', 'display-capture',
  'notifications', 'clipboard-read', 'clipboard-sanitized-write',
  'fullscreen', 'pointerLock', 'background-sync', 'idle-detection'
]);

const DENIED = new Set(['geolocation', 'midi', 'midiSysex', 'hid', 'serial', 'usb']);

const configured = new Set();

/**
 * Configure one server's session. Each server owns its partition, and
 * therefore its cookies, so two instances stay signed in side by side without
 * interfering with each other.
 */
function setupServer(server) {
  if (!server) return null;
  const partition = config.partitionFor(server.id);
  if (configured.has(partition)) return session.fromPartition(partition);
  configured.add(partition);

  const ses = session.fromPartition(partition);

  ses.setPermissionRequestHandler(function (webContents, permission, callback, details) {
    const origin = (details && details.requestingUrl) || (webContents ? webContents.getURL() : '');
    if (!routing.isInternalTo(origin, server.id)) return callback(false);
    if (DENIED.has(permission)) return callback(false);
    return callback(GRANTED.has(permission));
  });

  ses.setPermissionCheckHandler(function (webContents, permission, requestingOrigin) {
    const origin = requestingOrigin || (webContents ? webContents.getURL() : '');
    if (!routing.isInternalTo(origin, server.id)) return false;
    if (DENIED.has(permission)) return false;
    return GRANTED.has(permission);
  });

  if (typeof ses.setDisplayMediaRequestHandler === 'function') {
    ses.setDisplayMediaRequestHandler(function (request, callback) {
      desktopCapturer
        .getSources({ types: ['screen', 'window'], fetchWindowIcons: true })
        .then(function (sources) {
          if (!sources.length) return callback({});
          showSourcePicker(sources)
            .then(function (selected) {
              if (!selected) return callback({});
              callback({ video: selected, audio: 'loopback' });
            })
            .catch(function () { callback({}); });
        })
        .catch(function () { callback({}); });
    }, { useSystemPicker: true });
  }

  ses.setCertificateVerifyProc(function (request, callback) {
    const current = config.getServer(server.id);
    const hosts = config.hostsFor(current);
    if (current && current.allowInsecureCertificates && hosts.includes(request.hostname.toLowerCase())) {
      return callback(0);   // forced accept
    }
    callback(-3);           // Chromium default verification
  });

  const original = ses.getUserAgent();
  ses.setUserAgent(original.replace(/Electron\/[\d.]+\s*/i, '') + ' NextcloudHubDesktop/1.5.0');

  return ses;
}

/** Configure the sessions of every registered server. */
function setupAll() {
  for (const server of config.list()) setupServer(server);
}

// ---------------------------------------------------------------------------
// Screen-share source picker
// ---------------------------------------------------------------------------

function showSourcePicker(sources) {
  return new Promise(function (resolve) {
    const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const picker = new BrowserWindow({
      width: 780, height: 520, parent: parent, modal: Boolean(parent),
      show: false, resizable: false, minimizable: false, maximizable: false,
      title: 'Share a screen or window',
      autoHideMenuBar: true, backgroundColor: '#1b1b1b',
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });

    const payload = sources.map(function (source) {
      return {
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail ? source.thumbnail.toDataURL() : ''
      };
    });

    picker.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildPickerHtml(payload)));

    let settled = false;
    const finish = function (id) {
      if (settled) return;
      settled = true;
      resolve(sources.find(function (source) { return source.id === id; }) || null);
      if (!picker.isDestroyed()) picker.close();
    };

    // The console-message signature changed in newer Electron: it used to be
    // (event, level, message, line, sourceId) and is now (event) carrying
    // event.message. Support both, otherwise the picker silently never
    // resolves and screen sharing appears to do nothing.
    picker.webContents.on('console-message', function () {
      const first = arguments[0];
      let message = '';
      if (first && typeof first.message === 'string') {
        message = first.message;                 // Electron 37+
      } else if (typeof arguments[2] === 'string') {
        message = arguments[2];                  // Electron 36 and earlier
      }
      if (!message) return;
      if (message.indexOf('PICK:') === 0) finish(message.slice(5));
      if (message === 'CANCEL') finish(null);
    });

    picker.on('closed', function () {
      if (!settled) { settled = true; resolve(null); }
    });

    picker.once('ready-to-show', function () { picker.show(); });
  });
}

function buildPickerHtml(sources) {
  const items = sources.map(function (source) {
    return '<button class="src" data-id="' + escapeHtml(source.id) + '">' +
      '<img src="' + source.thumbnail + '" alt="">' +
      '<span>' + escapeHtml(source.name) + '</span></button>';
  }).join('');

  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><style>' +
    ':root{color-scheme:dark}' +
    'body{margin:0;font-family:"Segoe UI",system-ui,sans-serif;background:#1b1b1b;color:#f0f0f0;padding:16px}' +
    'h1{font-size:15px;font-weight:600;margin:0 0 14px}' +
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;max-height:390px;overflow:auto}' +
    '.src{background:#272727;border:2px solid transparent;border-radius:8px;padding:8px;cursor:pointer;display:flex;flex-direction:column;gap:6px;color:inherit;font:inherit;text-align:left}' +
    '.src:hover{border-color:#00679e;background:#303030}' +
    '.src img{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:4px;background:#000}' +
    '.src span{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.bar{margin-top:14px;display:flex;justify-content:flex-end}' +
    '.cancel{background:#3a3a3a;border:0;color:#fff;padding:8px 18px;border-radius:6px;cursor:pointer;font:inherit}' +
    '</style></head><body><h1>Choose what to share</h1>' +
    '<div class="grid">' + items + '</div>' +
    '<div class="bar"><button class="cancel">Cancel</button></div><script>' +
    'document.querySelectorAll(".src").forEach(function(el){el.addEventListener("click",function(){console.log("PICK:"+el.dataset.id)})});' +
    'document.querySelector(".cancel").addEventListener("click",function(){console.log("CANCEL")});' +
    'document.addEventListener("keydown",function(e){if(e.key==="Escape")console.log("CANCEL")});' +
    '<\/script></body></html>';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, function (char) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

module.exports = { setupServer: setupServer, setupAll: setupAll };
