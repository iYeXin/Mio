/*
 * Mio bootstrap bridge.
 *
 * This file is intentionally dependency-free and runs as a classic script.
 * The runtime injects window.__MIO_BOOT__ before it; dev mode reads the same
 * values from the page query string. It is the only implementation of the
 * WebSocket/JSON-RPC transport.
 */
(function () {
  "use strict";

  if (window.Mio && window.Mio.__mio) return;

  function readBoot() {
    if (window.__MIO_BOOT__) return window.__MIO_BOOT__;
    try {
      var params = new URLSearchParams(window.location.search);
      var port = params.get("__mio_port");
      var token = params.get("__mio_token");
      if (!port || !token) return null;
      return {
        port: Number(port),
        token: token,
        platform: params.get("__mio_platform") || "web",
        apiVersion: "1.0.0",
        theme: params.get("__mio_theme") || undefined,
        app: {
          id: params.get("__mio_app_id") || "dev.mio.app",
          name: params.get("__mio_app_name") || "Mio App",
          version: params.get("__mio_app_version") || "0.0.0"
        }
      };
    } catch (error) {
      return null;
    }
  }

  var boot = readBoot();
  if (!boot || !boot.port || !boot.token) {
    console.error("[Mio] bootstrap data is missing; the bridge was not started");
    return;
  }

  // Set before the bridge itself, so @iyexin/mio-api and app code can tell
  // whether they are inside the shell: outside Mio this file returns above and
  // the flag stays undefined.
  window.__MIO__ = {
    platform: boot.platform || "web",
    apiVersion: boot.apiVersion || "1.0.0",
    theme: boot.theme && boot.theme !== "system" ? boot.theme : undefined,
    app: boot.app || {}
  };

  function MioError(code, message, data) {
    var error = new Error(message);
    error.name = "MioError";
    error.code = code;
    error.data = data;
    return error;
  }

  var nextId = 1;
  var pending = new Map();
  var listeners = new Map();
  var outgoing = [];
  var socket = null;
  var reconnectTimer = null;
  var reconnectDelay = 250;
  var closedByApp = false;
  var opened = false;
  var state = "connecting";
  var heartbeat = null;
  var HEARTBEAT_INTERVAL = 5000;
  var HEARTBEAT_TIMEOUT = 4000;

  function setState(next) {
    if (state === next) return;
    state = next;
    dispatch("bridge.state", { state: next });
  }

  var resolveReady;
  var rejectReady;
  var ready = new Promise(function (resolve, reject) {
    resolveReady = resolve;
    rejectReady = reject;
  });
  var readyTimer = setTimeout(function () {
    if (!opened) {
      rejectReady(MioError("MIO_TIMEOUT", "Mio bridge did not connect in time"));
    }
  }, 15000);

  function endpoint() {
    return (
      "ws://127.0.0.1:" +
      boot.port +
      "/__mio__/rpc?token=" +
      encodeURIComponent(boot.token)
    );
  }

  function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    socket = new WebSocket(endpoint());

    socket.onopen = function () {
      opened = true;
      reconnectDelay = 250;
      clearTimeout(readyTimer);
      setState("open");
      startHeartbeat();
      resolveReady({
        apiVersion: boot.apiVersion || "1.0.0",
        platform: boot.platform || "web",
        app: boot.app || {}
      });
      window.dispatchEvent(new CustomEvent("mio:ready", { detail: boot.app || {} }));
      var queue = outgoing;
      outgoing = [];
      for (var i = 0; i < queue.length; i++) {
        socket.send(queue[i]);
      }
    };

    socket.onmessage = function (event) {
      var message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        console.error("[Mio] invalid bridge message", error);
        return;
      }
      if (message.method === "event" && message.params) {
        dispatch(message.params.name, message.params.data);
        return;
      }
      if (message.id === undefined || message.id === null) return;
      var request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) {
        // `mioCode` is the stable symbolic code (FS_FORBIDDEN, ...); the JSON-RPC
        // `code` is an integer and stays available as `rpcCode`.
        var symbol = message.error.mioCode != null ? message.error.mioCode : message.error.code;
        var failure = MioError(
          symbol,
          message.error.message || "Mio call failed",
          message.error.data
        );
        if (typeof message.error.code === "number") {
          failure.rpcCode = message.error.code;
        }
        request.reject(failure);
      } else {
        request.resolve(message.result);
      }
    };

    socket.onerror = function () {
      // onclose will schedule reconnect
    };

    socket.onclose = function () {
      socket = null;
      stopHeartbeat();
      if (closedByApp) return;
      setState("closed");
      for (var entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(MioError("MIO_DISCONNECTED", "Mio bridge disconnected"));
      }
      pending.clear();
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        reconnectDelay = Math.min(reconnectDelay * 2, 10000);
        setState("connecting");
        connect();
      }, reconnectDelay);
    };
  }

  /*
   * A half-open socket looks alive forever: the OS only notices after minutes.
   * A ping every few seconds turns "the shell froze or died" into a fast
   * disconnect instead of a 30 second timeout on the next real call.
   */
  function startHeartbeat() {
    stopHeartbeat();
    heartbeat = setInterval(function () {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      request("ping", {}, HEARTBEAT_TIMEOUT).catch(function () {
        if (!socket) return;
        try {
          socket.close();
        } catch (error) {
          // onclose handles the reconnect.
        }
      });
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat() {
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = null;
  }

  function request(method, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (typeof method !== "string" || method.length === 0) {
        reject(MioError("MIO_BAD_REQUEST", "method must be a non-empty string"));
        return;
      }
      var id = nextId++;
      var payload = JSON.stringify({
        jsonrpc: "2.0",
        id: id,
        method: method,
        params: params || {}
      });
      var timer = setTimeout(function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(MioError("MIO_TIMEOUT", "Mio call timed out: " + method));
      }, timeoutMs || 30000);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });

      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      } else {
        outgoing.push(payload);
        connect();
      }
    });
  }

  function invoke(method, params) {
    return request(method, params, 30000);
  }

  function blobUrl(path) {
    return (
      "http://127.0.0.1:" +
      boot.port +
      "/__mio__/blob?token=" +
      encodeURIComponent(boot.token) +
      "&path=" +
      encodeURIComponent(path)
    );
  }

  function errorFromResponse(response, detail) {
    return MioError("FS_ERROR", detail || "HTTP " + response.status, {
      status: response.status
    });
  }

  async function readBlob(path) {
    var response;
    try {
      response = await fetch(blobUrl(path));
    } catch (error) {
      throw MioError("MIO_DISCONNECTED", "Blob request failed: " + path);
    }
    if (!response.ok) {
      var body = "";
      try {
        body = await response.text();
      } catch (error) {
        body = "";
      }
      throw errorFromResponse(response, body || undefined);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async function writeBlob(path, data) {
    var isBytes =
      data instanceof ArrayBuffer ||
      (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(data));
    if (!isBytes) {
      throw MioError(
        "MIO_BAD_REQUEST",
        "writeBlob expects an ArrayBuffer or typed array"
      );
    }
    var response;
    try {
      response = await fetch(blobUrl(path), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: data
      });
    } catch (error) {
      throw MioError("MIO_DISCONNECTED", "Blob request failed: " + path);
    }
    if (!response.ok) {
      var body = "";
      try {
        body = await response.text();
      } catch (error) {
        body = "";
      }
      throw errorFromResponse(response, body || undefined);
    }
  }

  function on(name, handler) {
    if (typeof handler !== "function") {
      throw new TypeError("Mio.on requires a handler function");
    }
    var bucket = listeners.get(name);
    if (!bucket) {
      bucket = new Set();
      listeners.set(name, bucket);
    }
    bucket.add(handler);
    return function () {
      bucket.delete(handler);
      if (bucket.size === 0) listeners.delete(name);
    };
  }

  function off(name, handler) {
    var bucket = listeners.get(name);
    if (!bucket) return;
    bucket.delete(handler);
    if (bucket.size === 0) listeners.delete(name);
  }

  function once(name, handler) {
    var unsubscribe = on(name, function (data) {
      unsubscribe();
      handler(data);
    });
    return unsubscribe;
  }

  function dispatch(name, data) {
    var bucket = listeners.get(name);
    if (!bucket) return;
    for (var handler of Array.from(bucket)) {
      try {
        handler(data);
      } catch (error) {
        console.error("[Mio] event handler failed", name, error);
      }
    }
  }

  // Console output and uncaught errors go to logs/mio.log: release builds have
  // no devtools, and this is the only place a user can look afterwards.
  function installDiagnostics() {
    if (window.__MIO_DIAGNOSTICS__) return;
    window.__MIO_DIAGNOSTICS__ = true;

    var queue = [];
    var flushTimer = 0;

    function format(args) {
      return args
        .map(function (value) {
          if (typeof value === "string") return value;
          if (value instanceof Error) return value.stack || value.message;
          try {
            return JSON.stringify(value);
          } catch (_) {
            return String(value);
          }
        })
        .join(" ");
    }

    function flush() {
      if (!queue.length) return;
      var text = queue.join("\n").slice(0, 8000);
      queue = [];
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = 0;
      }
      invoke("app.log", { level: "info", message: text }).catch(function () {});
    }

    // Batch lines: one RPC and one append per burst instead of one per console
    // call. Apps that log during startup would otherwise pay a round trip and
    // a disk write for every message while the page is still painting.
    function forward(level, args) {
      queue.push("[" + level + "] " + format(args).slice(0, 2000));
      if (queue.length >= 40) {
        flush();
        return;
      }
      if (!flushTimer) flushTimer = setTimeout(flush, 250);
    }

    ["log", "info", "warn", "error", "debug"].forEach(function (level) {
      var original = console[level];
      if (typeof original !== "function") return;
      console[level] = function () {
        forward(
          level === "warn"
            ? "warn"
            : level === "error"
              ? "error"
              : level === "debug"
                ? "debug"
                : "info",
          Array.prototype.slice.call(arguments),
        );
        return original.apply(console, arguments);
      };
    });

    window.addEventListener("error", function (event) {
      forward("error", ["uncaught " + (event.message || "error"), event.filename + ":" + event.lineno]);
    });
    window.addEventListener("unhandledrejection", function (event) {
      var reason = event.reason;
      forward("error", ["unhandled rejection", reason && (reason.stack || reason.message) || String(reason)]);
    });
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") flush();
    });
  }

  // The WebView fills the window; pages that want safe margins read these
  // variables (or call platform.insets()). Updates on rotation/cutout changes.
  var root = document.documentElement;

  function setVar(name, value) {
    // Re-writing an unchanged custom property still invalidates style and
    // layout, and the IME dispatches a metrics snapshot on every frame.
    if (root.style.getPropertyValue(name) === value) return;
    root.style.setProperty(name, value);
  }

  /**
   * Layout contract between the shell and the page.
   *
   * One snapshot carries everything a page needs to lay itself out: the visible
   * size, the safe areas and the IME height. The variables below are the derived
   * numbers, so pages do not repeat the "keyboard minus navigation bar" arithmetic
   * that is easy to get wrong:
   *
   *   --mio-inset-*        safe areas (cutout, status bar, navigation bar)
   *   --mio-ime-height     keyboard height, 0 when closed
   *   --mio-ime-lift       how far a bottom-fixed element must move up when its
   *                        own padding already covers the navigation bar
   *   --mio-safe-bottom    everything the system covers at the bottom
   *   --mio-viewport-*     visible size, IME excluded
   */
  function installViewport() {
    if (window.__MIO_VIEWPORT__) return;
    window.__MIO_VIEWPORT__ = true;
    root.classList.add("mio-viewport");

    // Coalesce to one write per frame: the IME dispatches a snapshot per frame
    // while it animates, and a custom property write on <html> invalidates the
    // style of the whole tree.
    var queued = null;
    var frame = 0;
    function apply(viewport) {
      if (!viewport) return;
      queued = viewport;
      if (frame) return;
      frame = requestAnimationFrame(function () {
        frame = 0;
        var next = queued;
        queued = null;
        write(next);
      });
    }

    function write(viewport) {
      if (!viewport) return;
      var insets = viewport.insets || {};
      var ime = viewport.ime || {};
      var sides = ["top", "right", "bottom", "left"];
      var bottom = typeof insets.bottom === "number" && insets.bottom > 0 ? insets.bottom : 0;
      var imeHeight = typeof ime.height === "number" && ime.height > 0 ? ime.height : 0;
      for (var i = 0; i < sides.length; i++) {
        var value = insets[sides[i]];
        setVar("--mio-inset-" + sides[i], (typeof value === "number" && value > 0 ? value : 0) + "px");
      }
      setVar("--mio-ime-height", imeHeight + "px");
      setVar("--mio-ime-lift", Math.max(0, imeHeight - bottom) + "px");
      setVar("--mio-safe-bottom", Math.max(imeHeight, bottom) + "px");
      if (typeof viewport.width === "number") {
        setVar("--mio-viewport-width", viewport.width + "px");
      }
      if (typeof viewport.height === "number") {
        setVar("--mio-viewport-height", viewport.height + "px");
      }
    }

    function refresh() {
      invoke("platform.viewport").then(apply).catch(installBrowserViewport);
    }

    refresh();
    ready.then(refresh).catch(function () {});
    on("app.viewport", apply);
  }

  /**
   * Fallback for real browsers and for shells older than `platform.viewport`.
   *
   * Safe-area insets cannot be read from JS there, so the `--mio-inset-*`
   * variables keep their `env()` fallback at the point of use; the IME and the
   * visible height still work through `visualViewport`, which is exactly what a
   * desktop browser and an adjustResize WebView provide.
   */
  var browserViewportInstalled = false;
  function installBrowserViewport() {
    if (browserViewportInstalled) return;
    browserViewportInstalled = true;
    var viewport = window.visualViewport;
    if (!viewport) return;
    function update() {
      var ime = Math.max(0, window.innerHeight - viewport.height);
      setVar("--mio-ime-height", ime.toFixed(2) + "px");
      setVar("--mio-ime-lift", ime.toFixed(2) + "px");
      setVar("--mio-safe-bottom", ime.toFixed(2) + "px");
      setVar("--mio-viewport-height", viewport.height.toFixed(2) + "px");
      setVar("--mio-viewport-width", viewport.width.toFixed(2) + "px");
    }
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
  }

  window.Mio = {
    __mio: true,
    apiVersion: boot.apiVersion || "1.0.0",
    platform: boot.platform || "web",
    app: boot.app || {},
    ready: ready,
    get state() {
      return state;
    },
    invoke: invoke,
    on: on,
    off: off,
    once: once,
    blobUrl: blobUrl,
    readBlob: readBlob,
    writeBlob: writeBlob
  };

  installDiagnostics();
  installViewport();
  connect();
})();
