// Injected into every frame of the app's windows before the frame's own
// scripts. A frame whose origin is opaque ("null") is a sandboxed plugin page
// or a frame such a page created (a srcdoc child is a fresh realm the page's
// bootstrap never runs in). It gets no WebRTC: the one network path its CSP
// cannot close, because Chromium does not enforce `webrtc 'block'` and STUN /
// TURN traffic is not a `connect-src` request. Frames with an origin of their
// own (the app, an embedded web panel) are left alone.
(function () {
  "use strict";
  var opaque;
  try {
    opaque = self.origin === "null";
  } catch (error) {
    opaque = true;
  }
  if (!opaque) return;
  ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCIceTransport", "RTCSctpTransport", "RTCDtlsTransport", "RTCDataChannel"].forEach(function (name) {
    try {
      Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false });
    } catch (error) {
      /* Already fixed by an earlier script. */
    }
  });
})();
