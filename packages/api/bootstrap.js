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

  connect();
})();
