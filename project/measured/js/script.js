(function () {
  var scriptEl = document.currentScript;
  if (!scriptEl) return;

  var siteId = scriptEl.getAttribute("data-site-id");

  var apiUrlAttr = scriptEl.getAttribute("data-api-url") || "/api/session";

  var allowLocalhost = scriptEl.getAttribute("data-allow-localhost") === "true";
  var allowFileProtocol =
    scriptEl.getAttribute("data-allow-file-protocol") === "true";
  var debug = scriptEl.getAttribute("data-debug") === "true";
  var silenceLogs = scriptEl.getAttribute("data-disable-console") === "true";

  // ====== UTIL ======
  function log(level, msg, extra) {
    if (silenceLogs) return;
    if (!debug && level === "info") return;

    var prefix = "[Analytics]";
    if (extra !== undefined) {
      console[level === "error" ? "error" : "log"](prefix, msg, extra);
    } else {
      console[level === "error" ? "error" : "log"](prefix, msg);
    }
  }

  function isLocalhostHost(host) {
    if (!host) return false;
    var h = host.toLowerCase();
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "::1" ||
      h.endsWith(".localhost") ||
      h.endsWith(".local")
    );
  }

  function isBotLike() {
    try {
      var nav = window.navigator;

      if (nav.webdriver) return true;
      var ua = (nav.userAgent || "").toLowerCase();
      if (!ua || ua.length < 5) return true;

      var botSnippets = [
        "headlesschrome",
        "phantomjs",
        "selenium",
        "webdriver",
        "puppeteer",
        "playwright",
        "python",
        "curl",
        "wget",
        "postman",
      ];
      for (var i = 0; i < botSnippets.length; i++) {
        if (ua.indexOf(botSnippets[i]) !== -1) return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  function generateId(prefix) {
    var template = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";
    var id = template.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
    return prefix ? prefix + "_" + id : id;
  }

  // ====== VISITOR / SESSION IDS ======

  function getVisitorId() {
    try {
      var key = "analytics_visitor_id";
      var existing = localStorage.getItem(key);
      if (existing) return existing;
      var created = generateId("vis");
      localStorage.setItem(key, created);
      return created;
    } catch (e) {
      return null;
    }
  }

  function getSessionId() {
    try {
      var key = "analytics_session_id";
      var existing = sessionStorage.getItem(key);
      if (existing) return existing;
      var created = generateId("sess");
      sessionStorage.setItem(key, created);
      return created;
    } catch (e) {
      return null;
    }
  }

  // ====== ENDPOINT RESOLUTION ======

  var endpoint;
  if (apiUrlAttr) {
    try {
      endpoint = new URL(apiUrlAttr, window.location.origin).href;
    } catch (e) {
      endpoint = new URL("/api/session", window.location.origin).href;
      log("error", "Invalid data-api-url, falling back to /api/session");
    }
  } else {
    endpoint = new URL("/api/session", window.location.origin).href;
  }

  // ====== DISABLE CONDITIONS ======
  var disabledReason = "";
  var enabled = true;

  if (!siteId) {
    enabled = false;
    disabledReason = "Missing data-site-id";
  }

  if (enabled && window !== window.parent && !debug) {
    enabled = false;
    disabledReason = "Disabled in iframe";
  }

  if (enabled && isBotLike()) {
    enabled = false;
    disabledReason = "Bot-like environment detected";
  }

  var host = window.location.hostname;
  var protocol = window.location.protocol;

  if (enabled && isLocalhostHost(host) && !allowLocalhost) {
    enabled = false;
    disabledReason =
      "Running on localhost; pass data-allow-localhost='true' to enable";
  }

  if (enabled && protocol === "file:" && !allowFileProtocol) {
    enabled = false;
    disabledReason =
      "Running on file:///; pass data-allow-file-protocol='true' to enable";
  }

  if (!enabled) {
    log("info", "Analytics disabled: " + disabledReason);
  }

  // ====== PAYLOAD BUILDER ======

  function buildBasePayload() {
    var channel = null;
    var rawDocRef = document.referrer || null;
    if (rawDocRef) {
      try {
        var refUrl = new URL(rawDocRef);
        channel = refUrl.hostname.replace(/^www\./, "");
      } catch (e) {
        // if not a valid URL, just send raw referrer string
        channel = rawDocRef;
      }
    }

    var refParam = null;
    try {
      var currentUrl = new URL(window.location.href);
      refParam = currentUrl.searchParams.get("ref");
    } catch (e) {
      refParam = null;
    }

    return {
      siteId: siteId,
      type: null, // set later
      sessionId: getSessionId(),
      visitorId: getVisitorId(),
      url: window.location.href,

      channel: channel,
      referrer: refParam || null,

      title: document.title || null,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      language: navigator.language || null,
      timezone:
        (Intl.DateTimeFormat &&
          Intl.DateTimeFormat().resolvedOptions().timeZone) ||
        null,
      eventName: null,
      eventData: null,
      occurredAt: new Date().toISOString(),
    };
  }

  // ====== BATCHING ======

  var eventQueue = [];
  var flushTimeout = null;
  var FLUSH_INTERVAL_MS = 10000;
  var MAX_BATCH_SIZE = 20;

  function flushEventQueue() {
    if (!enabled) {
      eventQueue = [];
      if (flushTimeout) {
        clearTimeout(flushTimeout);
        flushTimeout = null;
      }
      return;
    }

    if (!eventQueue.length) {
      if (flushTimeout) {
        clearTimeout(flushTimeout);
        flushTimeout = null;
      }
      return;
    }

    var batch = eventQueue.slice();
    eventQueue = [];
    if (flushTimeout) {
      clearTimeout(flushTimeout);
      flushTimeout = null;
    }

    try {
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: batch }),
        keepalive: true,
      })
        .then(function (res) {
          if (debug) {
            log("info", "Batch sent", {
              size: batch.length,
              status: res.status,
            });
          }
        })
        .catch(function (err) {
          log("error", "Failed to send analytics batch", err);
        });
    } catch (e) {
      log("error", "Unexpected error sending analytics batch", e);
    }
  }

  function queueEvent(payload) {
    if (!enabled) {
      log("info", "Event ignored: " + disabledReason, payload);
      return;
    }

    eventQueue.push(payload);

    if (eventQueue.length >= MAX_BATCH_SIZE) {
      flushEventQueue();
      return;
    }

    if (!flushTimeout) {
      flushTimeout = setTimeout(flushEventQueue, FLUSH_INTERVAL_MS);
    }
  }

  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", function () {
      try {
        flushEventQueue();
      } catch (e) {}
    });
  }

  // ====== SEND FUNCTION (BATCHED) ======

  function sendEvent(payload, cb) {
    queueEvent(payload);
    if (cb) {
      cb({ status: 200, batched: true });
    }
  }

  // ====== PAGEVIEW TRACKING ======

  var lastPageviewUrl = null;
  var lastPageviewTime = 0;
  var PAGEVIEW_THROTTLE_MS = 60 * 1000;

  function trackPageview() {
    var now = Date.now();
    var currentUrl = window.location.href;

    if (
      lastPageviewUrl === currentUrl &&
      now - lastPageviewTime < PAGEVIEW_THROTTLE_MS
    ) {
      log("info", "Pageview ignored (throttled)");
      return;
    }

    lastPageviewUrl = currentUrl;
    lastPageviewTime = now;

    var payload = buildBasePayload();
    payload.type = "pageview";

    sendEvent(payload);
  }

  // ====== HEARTBEATS (LIVE VISITORS / BETTER SESSION TIME) ======

  var HEARTBEAT_INTERVAL_MS = 15000; // 15s
  var heartbeatTimer = null;

  function sendHeartbeat() {
    var payload = buildBasePayload();
    payload.type = "heartbeat";
    payload.eventName = null;
    payload.eventData = null;
    sendEvent(payload);
  }

  function startHeartbeat() {
    if (!enabled) return;
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    log("info", "Heartbeat started");
  }

  function stopHeartbeat() {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    log("info", "Heartbeat stopped");
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "visible") {
      startHeartbeat();
    } else {
      stopHeartbeat();
    }
  }

  // ====== PUBLIC API (CUSTOM EVENTS) ======

  function trackCustomEvent(name, data) {
    if (!name || typeof name !== "string") {
      log("error", "Custom event requires a string name");
      return;
    }

    var payload = buildBasePayload();
    payload.type = "event";
    payload.eventName = name;
    payload.eventData = data || null;

    sendEvent(payload);
  }

  window.measured = window.measured || {};
  window.measured.track = trackCustomEvent;

  // ====== INITIAL PAGEVIEW + SPA SUPPORT ======

  function handleRouteChange() {
    trackPageview();
  }

  function installSpaListeners() {
    var lastPath = window.location.pathname;
    var origPushState = window.history.pushState;

    if (origPushState) {
      window.history.pushState = function () {
        origPushState.apply(window.history, arguments);
        if (window.location.pathname !== lastPath) {
          lastPath = window.location.pathname;
          handleRouteChange();
        }
      };
    }

    window.addEventListener("popstate", function () {
      if (window.location.pathname !== lastPath) {
        lastPath = window.location.pathname;
        handleRouteChange();
      }
    });
  }

  function onDomReady(fn) {
    if (
      document.readyState === "complete" ||
      document.readyState === "interactive"
    ) {
      fn();
    } else {
      document.addEventListener("DOMContentLoaded", fn);
    }
  }

  onDomReady(function () {
    handleRouteChange();
    installSpaListeners();

    // Heartbeats only when tab is visible
    document.addEventListener("visibilitychange", handleVisibilityChange);
    if (document.visibilityState === "visible") {
      startHeartbeat();
    }
  });
})();
