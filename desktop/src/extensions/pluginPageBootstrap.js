// Runs first in a plugin page's frame, before any of the page's own code.
// The host appends the call: (channel, { language, theme, data }).
//
// The frame has an opaque origin and a CSP with no network, so the page can
// reach nothing by itself. On Windows, wry also injects Tauri's `ipc`,
// `isTauri` and `__TAURI_INTERNALS__` into every child frame; their only
// transport left under this CSP is `chrome.webview`, removed here. If it
// cannot be removed the page never runs.
//
// This covers the page's own realm only. A child frame the page creates is a
// fresh realm where this script never ran and `chrome.webview` is intact; what
// refuses a command sent from there is Tauri's origin check on the native side
// (see docs/development-logic/chat-ui-plugins.md).
(function (channel, initial) {
  "use strict";
  var own = document.currentScript;
  if (own) own.remove();
  // frame -> the host's shell frame -> the app
  var host = window.parent.parent;
  var post = function (message) {
    message.channel = channel;
    host.postMessage(message, "*");
  };
  var hide = function (target, key) {
    try {
      Object.defineProperty(target, key, { value: undefined, writable: false, configurable: false });
    } catch (error) {
      /* Verified below. */
    }
  };
  ["__TAURI_INTERNALS__", "__TAURI__", "ipc", "isTauri", "webkit"].forEach(function (key) {
    hide(window, key);
  });
  if (window.chrome && window.chrome.webview !== undefined) hide(window.chrome, "webview");
  if (window.chrome && window.chrome.webview !== undefined) hide(window, "chrome");
  if (window.chrome && window.chrome.webview !== undefined) {
    post({ type: "error", message: "isolation" });
    window.stop();
    throw new Error("Native IPC isolation failed");
  }

  var state = { language: initial.language, theme: initial.theme, data: initial.data, files: initial.files || {} };
  var resolve = function (reference) {
    var parts = String(initial.page || "").split("/").slice(0, -1);
    String(reference).split("/").forEach(function (part) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    });
    return parts.join("/");
  };
  var listeners = { data: [], theme: [] };
  var pending = new Map();
  var sequence = 0;
  var applyTheme = function (theme) {
    var root = document.documentElement;
    if (!root || !theme) return;
    root.dataset.theme = theme.mode;
    root.style.colorScheme = theme.mode;
    Object.keys(theme.colors || {}).forEach(function (name) {
      root.style.setProperty("--somniq-" + name, theme.colors[name]);
    });
    if (theme.font) root.style.setProperty("--somniq-font", theme.font);
  };
  var emit = function (kind, value) {
    listeners[kind].slice().forEach(function (listener) {
      try {
        listener(value);
      } catch (error) {
        setTimeout(function () {
          throw error;
        });
      }
    });
  };
  var subscribe = function (kind, listener) {
    if (typeof listener !== "function") throw new TypeError("A listener must be a function");
    listeners[kind].push(listener);
    return function () {
      var index = listeners[kind].indexOf(listener);
      if (index >= 0) listeners[kind].splice(index, 1);
    };
  };
  var call = function (method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++sequence;
      pending.set(id, { resolve: resolve, reject: reject });
      post({ type: "call", id: id, method: method, args: args });
    });
  };
  window.addEventListener("message", function (event) {
    var message = event.data;
    if (event.source !== host || !message || message.channel !== channel) return;
    if (message.type === "result") {
      var task = pending.get(message.id);
      if (!task) return;
      pending.delete(message.id);
      if (message.ok) {
        state.data = message.value;
        task.resolve(message.value);
      } else task.reject(new Error(String(message.error)));
    } else if (message.type === "data") {
      state.data = message.data;
      emit("data", message.data);
    } else if (message.type === "theme") {
      state.theme = message.theme;
      applyTheme(message.theme);
      emit("theme", message.theme);
    }
  });
  applyTheme(state.theme);
  Object.defineProperty(window, "somniq", {
    value: Object.freeze({
      /** { language, theme, data }: what the page starts with. */
      ready: function () {
        return Promise.resolve({ language: state.language, theme: state.theme, data: state.data });
      },
      /** Re-read every declared widget's value. */
      data: function () {
        return call("data");
      },
      /** Save one declared widget's value; rejects with the reason it was refused. */
      set: function (widget, value) {
        return call("set", { widget: String(widget), value: value });
      },
      /** Called when the agent, or another view, changed the data. */
      onData: function (listener) {
        return subscribe("data", listener);
      },
      onTheme: function (listener) {
        return subscribe("theme", listener);
      },
      /** Put text in the Chat composer. The user sends it. */
      prompt: function (text) {
        post({ type: "prompt", text: String(text) });
      },
      /** A file of the package (an image, a font, data), by path relative to the page, as a data: URL. */
      asset: function (path) {
        var file = state.files[resolve(path)];
        if (!file) throw new Error("No such package file: " + path);
        return "data:" + file.mime + ";base64," + file.data;
      },
      /** A text file of the package (JSON, CSV, Markdown…), by path relative to the page. */
      text: function (path) {
        var file = state.files[resolve(path)];
        if (!file) throw new Error("No such package file: " + path);
        var binary = atob(file.data), bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder().decode(bytes);
      },
      /** Open a project-relative file beside the chat. */
      openFile: function (path) {
        post({ type: "open-file", path: String(path) });
      },
      /** Open another panel of this package that is a page in the navigation rail. */
      openPanel: function (id) {
        post({ type: "open-panel", panel: String(id) });
      },
      /** Ask for a frame this tall, in CSS pixels; only a glance in the project summary is sized by its page. */
      resize: function (height) {
        post({ type: "resize", height: Number(height) });
      },
    }),
  });
})
