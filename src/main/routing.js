'use strict';

const config = require('./config');

/**
 * URL routing, aware of multiple servers.
 *
 * Destinations:
 *   'main'     -> main window of the current server
 *   'call'     -> dedicated Talk call window
 *   'window'   -> new detached window
 *   'server'   -> main window of ANOTHER configured server
 *   'external' -> system browser
 */

const TALK_CALL_PATTERNS = [
  /\/call\/[A-Za-z0-9]+/i,
  /\/apps\/spreed\/call\//i,
  /[?&]callTo=/i
];

const TALK_APP_PATTERNS = [
  /\/apps\/spreed(\/|$|\?)/i,
  /\/call\//i
];

const ALWAYS_EXTERNAL_PATTERNS = [
  /^mailto:/i, /^tel:/i, /^callto:/i, /^sip:/i, /^xmpp:/i
];

function parse(rawUrl) {
  try { return new URL(rawUrl); } catch (err) { return null; }
}

/** The configured server this URL belongs to, or null. */
function serverForUrl(rawUrl) {
  const url = parse(rawUrl);
  if (!url) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const hostname = url.hostname.toLowerCase();
  for (const server of config.list()) {
    if (config.hostsFor(server).includes(hostname)) return server;
  }
  return null;
}

/** Does this URL belong to the given server? */
function isInternalTo(rawUrl, serverId) {
  const server = serverForUrl(rawUrl);
  return Boolean(server && server.id === serverId);
}

/** Does this URL belong to any configured server? */
function isKnown(rawUrl) {
  return Boolean(serverForUrl(rawUrl));
}

function matchesTalkCall(rawUrl) {
  const url = parse(rawUrl);
  if (!url) return false;
  const target = url.pathname + url.search;
  return TALK_CALL_PATTERNS.some(function (pattern) { return pattern.test(target); });
}

function matchesTalkApp(rawUrl) {
  const url = parse(rawUrl);
  if (!url) return false;
  const target = url.pathname + url.search;
  return TALK_APP_PATTERNS.some(function (pattern) { return pattern.test(target); });
}

/** Extract the conversation token from a Talk URL. */
function talkToken(rawUrl) {
  const url = parse(rawUrl);
  if (!url) return null;
  const match = /\/call\/([A-Za-z0-9]+)/.exec(url.pathname);
  return match ? match[1] : null;
}

/**
 * @param {string} rawUrl
 * @param {object} ctx
 * @param {string} ctx.serverId      server owning the window the click came from
 * @param {string} ctx.disposition   Electron disposition
 * @param {string} ctx.features      features string from window.open()
 * @returns {{action: string, serverId: string|null}}
 */
function route(rawUrl, ctx) {
  const context = ctx || {};

  if (ALWAYS_EXTERNAL_PATTERNS.some(function (p) { return p.test(rawUrl); })) {
    return { action: 'external', serverId: null };
  }

  const target = serverForUrl(rawUrl);
  if (!target) return { action: 'external', serverId: null };

  // URL belonging to another configured server: send it to THAT window,
  // otherwise it would load in a session the user is not signed in to.
  if (context.serverId && target.id !== context.serverId) {
    return { action: 'server', serverId: target.id };
  }

  if (config.get('talkCallsInSeparateWindow') && matchesTalkCall(rawUrl)) {
    return { action: 'call', serverId: target.id };
  }

  if (config.get('talkChatInSeparateWindow') && matchesTalkApp(rawUrl)) {
    return { action: 'call', serverId: target.id };
  }

  const popup = context.features && /popup|width=|height=/i.test(context.features);
  if (popup || context.disposition === 'new-window') {
    return { action: 'window', serverId: target.id };
  }

  return { action: 'main', serverId: target.id };
}

module.exports = {
  route: route,
  serverForUrl: serverForUrl,
  isInternalTo: isInternalTo,
  isKnown: isKnown,
  matchesTalkCall: matchesTalkCall,
  matchesTalkApp: matchesTalkApp,
  talkToken: talkToken,
  parse: parse
};
