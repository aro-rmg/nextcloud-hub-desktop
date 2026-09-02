'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BUILD = path.join(ROOT, 'build');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const PRELOAD_DIR = path.join(ROOT, 'src', 'preload');

/**
 * Window icon for the current platform.
 *
 * macOS takes its icon from the bundle rather than from BrowserWindow, and
 * Linux wants a PNG. Only Windows uses the .ico.
 */
function windowIcon() {
  if (process.platform === 'win32') return path.join(BUILD, 'icon.ico');
  return path.join(BUILD, 'icon.png');
}

/** Tray icon. A PNG works on all three platforms. */
function trayIcon() {
  if (process.platform === 'win32') return path.join(BUILD, 'icon.ico');
  return path.join(BUILD, 'tray.png');
}

module.exports = {
  ROOT: ROOT,
  BUILD: BUILD,
  RENDERER: RENDERER,
  PRELOAD_DIR: PRELOAD_DIR,
  PRELOAD: path.join(PRELOAD_DIR, 'nextcloud.js'),
  LOCAL_PRELOAD: path.join(PRELOAD_DIR, 'local.js'),
  windowIcon: windowIcon,
  trayIcon: trayIcon,
  renderer: function (file) { return path.join(RENDERER, file); }
};
