'use strict';

/**
 * Bridge into the Talk application.
 *
 * Talk is a single-page app: joining a call triggers no navigation at all, so
 * setWindowOpenHandler and will-navigate never see it. To move a call into its
 * own window we have to work with Talk's own state and markup instead.
 *
 * ---------------------------------------------------------------------------
 * NO TEXT MATCHING
 * Everything here keys off structural markers -- CSS classes Talk assigns for
 * behaviour, and its Vuex store. Nothing reads visible labels, aria-labels or
 * titles, so the client behaves identically whatever language the interface is
 * running in.
 *
 * VERSION-SENSITIVE AREA
 * If this stops working after a Talk upgrade, SELECTORS below is the only place
 * to fix. Nothing else in the app depends on Talk internals.
 * ---------------------------------------------------------------------------
 */

const SELECTORS = {
  // Present only while a call is actually running
  inCall: [
    '#call-container',
    '.in-call',
    '.app-talk .in-call',
    '[class*="call-view"]',
    '.videos-and-screens'
  ],

  // Talk marks every join affordance with the semantic class `join-call`.
  // Two of them exist and they must not be confused:
  //
  //   conversation -> opens the device-check dialog
  //   confirm      -> inside that dialog, actually starts the call
  //
  // The conversation button stays in the DOM behind the dialog, hence :not().
  joinConversation: [
    'button.join-call:not(.action-button)',
    'button[data-test="join-call"]:not(.action-button)'
  ],
  joinConfirm: [
    'button.join-call.action-button'
  ],
  // Any join affordance, used to recognise a click worth intercepting
  joinAny: [
    'button.join-call',
    '.join-call',
    'button[data-test="join-call"]'
  ],

  // Hang up
  leaveCall: [
    'button.leave-call.action-button',
    'button.leave-call',
    '.leave-call',
    'button[data-test="leave-call"]'
  ]
};

/**
 * CSS applied in the detached call window only. Strips the surrounding Hub
 * chrome so the window holds the call and its chat and nothing else, while
 * leaving the top bar intact because it carries the hang-up button.
 */
const MINIMAL_CALL_CSS = `
  /* Nextcloud sizes #content with calc() against --header-height, so zeroing
     the variable reclaims the header strip without forcing any height
     ourselves. Forcing heights here collapses the sidebar tab panel and the
     chat renders as tabs with no content. */
  :root, body, #body-user, #content, #content-vue {
    --header-height: 0px !important;
  }

  #header,
  #nextcloud > header,
  header#header { display: none !important; }

  #app-navigation,
  .app-navigation,
  #app-navigation-vue,
  #app-navigation-toggle,
  .app-navigation-toggle { display: none !important; }

  /* Only the vertical offset is corrected. Nextcloud 28+ draws the content as
     an inset rounded card using --body-container-margin and
     --body-container-radius; overriding margin, border-radius or border here
     flattens that card and is what made the popup look raw. */
  #content, #content-vue {
    top: 0 !important;
  }

  /* Safety net: some Talk builds give the sidebar panel an explicit min-height
     that leaves the chat pane at zero once the header is gone. */
  .app-sidebar-tabs,
  .app-sidebar-tabs__content,
  .app-sidebar__content { min-height: 0 !important; }
`;

function buildScript(options) {
  const opts = options || {};
  return `(function () {
  if (window.__nchubBridge) return;
  window.__nchubBridge = true;

  var SELECTORS = ${JSON.stringify(SELECTORS)};
  var MINIMAL_CSS = ${JSON.stringify(MINIMAL_CALL_CSS)};
  var MINIMAL = ${opts.minimal ? 'true' : 'false'};
  var INTERCEPT = ${opts.intercept ? 'true' : 'false'};
  var AUTOJOIN = ${opts.autoJoin ? 'true' : 'false'};
  var CONFIRM_DEVICE = ${opts.confirmDevice ? 'true' : 'false'};
  var WATCH_LEAVE = ${opts.watchLeave ? 'true' : 'false'};
  var POLL_MS = ${Number(opts.pollMs) > 0 ? Number(opts.pollMs) : 600};

  function pick(list) {
    for (var i = 0; i < list.length; i++) {
      var el = document.querySelector(list[i]);
      if (el) return el;
    }
    return null;
  }

  function clickable(el) {
    return el && !el.disabled && el.offsetParent !== null;
  }

  function store() {
    try {
      var talk = window.OCA && window.OCA.Talk && window.OCA.Talk.instance;
      return (talk && talk.$store) || null;
    } catch (e) { return null; }
  }

  function currentToken() {
    var s = store();
    if (s) {
      try { if (s.getters.getToken) { var t = s.getters.getToken(); if (t) return t; } } catch (e) {}
      try { var conv = s.getters.currentConversation; if (conv && conv.token) return conv.token; } catch (e) {}
    }
    var m = /\\/call\\/([A-Za-z0-9]+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function readState() {
    var token = currentToken();
    var s = store();
    if (s && token) {
      try {
        var flag = s.getters.isInCall;
        if (typeof flag === 'function') {
          return { inCall: !!flag(token), token: token, source: 'store' };
        }
      } catch (e) {}
    }
    return { inCall: !!pick(SELECTORS.inCall), token: token, source: 'dom' };
  }

  var last = null;
  function tick() {
    var state;
    try { state = readState(); } catch (e) { return; }
    var signature = state.inCall + '|' + state.token;
    if (signature === last) return;
    last = signature;
    document.dispatchEvent(new CustomEvent('nchub:call-state', {
      detail: { inCall: state.inCall, token: state.token, source: state.source, href: location.href }
    }));
  }

  setInterval(tick, POLL_MS);
  document.addEventListener('DOMContentLoaded', tick);
  tick();

  // --- Minimal call layout -------------------------------------------------

  function applyMinimalLayout() {
    if (!MINIMAL) return;
    if (document.getElementById('nchub-minimal-style')) return;
    var style = document.createElement('style');
    style.id = 'nchub-minimal-style';
    style.textContent = MINIMAL_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  if (MINIMAL) {
    applyMinimalLayout();
    document.addEventListener('DOMContentLoaded', applyMinimalLayout);
    var reapply = setInterval(applyMinimalLayout, 800);
    setTimeout(function () { clearInterval(reapply); }, 20000);
  }

  // Store-only: the sidebar toggle has no stable class, and matching its label
  // would tie us to one interface language.
  window.__nchubOpenChat = function () {
    var s = store();
    if (!s) return false;
    try { s.dispatch('showSidebar'); return true; } catch (e) {}
    try { s.commit('showSidebar'); return true; } catch (e) {}
    return false;
  };

  // --- Intercepting a call BEFORE Talk joins --------------------------------
  //
  // Reacting once a call is running is too late: Talk has created its
  // conversation session by then, and the popup joining the same conversation
  // collides with it ("Duplicate session"). So in the main window we stop the
  // join at the source and let the popup be the one that joins.

  var intentSent = 0;

  function emitIntent(token) {
    if (!token) token = currentToken();
    if (!token) return false;
    var now = Date.now();
    if (now - intentSent < 3000) return true;   // click and dispatch may both fire
    intentSent = now;
    document.dispatchEvent(new CustomEvent('nchub:call-intent', {
      detail: { token: token, href: location.href }
    }));
    return true;
  }

  function isJoinButton(el) {
    if (!el || !el.closest) return false;
    for (var i = 0; i < SELECTORS.joinAny.length; i++) {
      if (el.closest(SELECTORS.joinAny[i])) return true;
    }
    return false;
  }

  /**
   * Emitted the moment the user hangs up, rather than waiting for the polled
   * state to flip. Polling alone cost up to POLL_MS plus the debounce before
   * the window could close, which read as a lag.
   */
  function emitEnded(reason) {
    document.dispatchEvent(new CustomEvent('nchub:call-ended-now', {
      detail: { reason: reason, token: currentToken() }
    }));
  }

  // A single hook on the store serves both directions: blocking joins in the
  // main window, and noticing a hang-up immediately in the popup.
  if (INTERCEPT || WATCH_LEAVE) {
    var hookTimer = setInterval(function () {
      var s = store();
      if (!s || s.__nchubHooked) return;
      s.__nchubHooked = true;
      clearInterval(hookTimer);
      var original = s.dispatch.bind(s);
      s.dispatch = function (type, payload, options) {
        var name = typeof type === 'string' ? type : (type && type.type);

        if (INTERCEPT && name === 'joinCall') {
          var token = (payload && payload.token) || currentToken();
          if (emitIntent(token)) return Promise.resolve();
        }

        if (WATCH_LEAVE && (name === 'leaveCall' || name === 'leaveConversation')) {
          // Let the request go out first, then close: destroying the window
          // mid-flight would leave the session to time out server-side.
          var result = original(type, payload, options);
          setTimeout(function () { emitEnded('dispatch'); }, 250);
          return result;
        }

        return original(type, payload, options);
      };
    }, 400);
    setTimeout(function () { clearInterval(hookTimer); }, 30000);
  }

  if (INTERCEPT) {
    // Clicks on any join affordance, captured before Talk's handler runs.
    document.addEventListener('click', function (event) {
      var state;
      try { state = readState(); } catch (e) { return; }
      if (state.inCall) return;
      if (!isJoinButton(event.target)) return;
      if (!emitIntent(state.token)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  if (WATCH_LEAVE) {
    // Clicking hang-up is observed without blocking it, so the window can start
    // closing at the same moment Talk starts tearing the call down.
    document.addEventListener('click', function (event) {
      var el = event.target;
      if (!el || !el.closest) return;
      var hit = SELECTORS.leaveCall.some(function (sel) { return el.closest(sel); });
      if (!hit) return;
      setTimeout(function () { emitEnded('click'); }, 250);
    }, true);
  }

  // --- Advancing the popup to the device-check dialog -----------------------
  //
  // The popup opens on the conversation, so one click is still needed to reach
  // the device-check dialog. That click is automated. Starting the call itself
  // is left to the user, who confirms in the dialog -- unless CONFIRM_DEVICE is
  // on, in which case that button is clicked too.
  //
  // The store's joinCall action is deliberately NOT used here: it would skip
  // the device dialog entirely, which is the screen the user wants to land on.

  window.__nchubAdvanceToCall = function () {
    var confirm = pick(SELECTORS.joinConfirm);
    if (clickable(confirm)) {
      // Device dialog is up. Either finish the job or hand over to the user.
      if (CONFIRM_DEVICE) { confirm.click(); return 'confirmed'; }
      return 'awaiting-user';
    }
    var open = pick(SELECTORS.joinConversation);
    if (clickable(open)) { open.click(); return 'opening'; }
    return 'not-ready';
  };

  window.__nchubAutoJoin = function (attempts) {
    if (window.__nchubAutoJoinStarted) return;
    window.__nchubAutoJoinStarted = true;

    var remaining = attempts || 60;
    var timer = setInterval(function () {
      var joined = false;
      try { joined = readState().inCall; } catch (e) {}
      if (joined) {
        clearInterval(timer);
        setTimeout(function () { try { window.__nchubOpenChat(); } catch (e) {} }, 600);
        return;
      }

      var result;
      try { result = window.__nchubAdvanceToCall(); } catch (e) { result = 'error'; }

      // Reached the dialog and the user is meant to confirm: stop clicking.
      if (result === 'awaiting-user') { clearInterval(timer); return; }

      if (--remaining <= 0) clearInterval(timer);
    }, 500);
  };

  window.__nchubLeaveCall = function () {
    var s = store();
    var token = currentToken();
    if (s && token) {
      try {
        s.dispatch('leaveCall', {
          token: token,
          participantIdentifier: s.getters.getParticipantIdentifier
            ? s.getters.getParticipantIdentifier()
            : undefined
        });
        return true;
      } catch (e) {}
    }
    var btn = pick(SELECTORS.leaveCall);
    if (clickable(btn)) { btn.click(); return true; }
    return false;
  };

  if (AUTOJOIN) {
    window.__nchubAutoJoin(60);
    document.addEventListener('DOMContentLoaded', function () { window.__nchubAutoJoin(60); });
  }
})();`;
}

module.exports = { buildScript: buildScript, SELECTORS: SELECTORS, MINIMAL_CALL_CSS: MINIMAL_CALL_CSS };
