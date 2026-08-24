import { gatewayEndpoint, RemoteProtocolError } from "./protocol";
import type { AuthorizedGatewaySocketFactory, GatewaySocket, GatewaySocketHandlers, GatewaySocketOpenInput } from "./transport";

const BROWSER_WEBSOCKET_SUBPROTOCOL = "somniq-remote-v1";
const MAX_TICKET_LENGTH = 128;

type BrowserWebSocketEndpoint = "signal" | "relay";

interface BrowserWebSocketTicketResponse {
  ticket: string;
  endpoint: BrowserWebSocketEndpoint;
  expires_at_unix_ms: number;
}

/**
 * Browser-safe gateway WebSocket adapter. It first obtains a short-lived,
 * single-use ticket through authenticated fetch, then offers that ticket only
 * in `Sec-WebSocket-Protocol`. The device bearer never appears in a URL.
 */
export class BrowserTicketedSocketFactory implements AuthorizedGatewaySocketFactory {
  async openSignal(input: GatewaySocketOpenInput): Promise<GatewaySocket> {
    return this.open(input, "signal");
  }

  async openRelay(input: GatewaySocketOpenInput): Promise<GatewaySocket> {
    return this.open(input, "relay");
  }

  private async open(input: GatewaySocketOpenInput, endpoint: BrowserWebSocketEndpoint): Promise<GatewaySocket> {
    const ticket = await createBrowserWebSocketTicket(input, endpoint);
    const path = endpoint === "signal" ? "/v1/browser-signal" : "/v1/browser-relay";
    const url = gatewayEndpoint(input.gatewayUrl, path, true);
    return openWebSocket(url, ticket.ticket);
  }
}

async function createBrowserWebSocketTicket(
  input: GatewaySocketOpenInput,
  endpoint: BrowserWebSocketEndpoint,
): Promise<BrowserWebSocketTicketResponse> {
  let response: Response;
  try {
    response = await fetch(gatewayEndpoint(input.gatewayUrl, "/v1/browser-ws-tickets"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ endpoint }),
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    throw new RemoteProtocolError("Cannot obtain a browser WebSocket ticket from the remote gateway.");
  }
  if (!response.ok) {
    throw new RemoteProtocolError("The remote gateway rejected the browser WebSocket ticket request.");
  }
  let ticket: unknown;
  try {
    ticket = await response.json();
  } catch {
    throw new RemoteProtocolError("The remote gateway returned an invalid browser WebSocket ticket.");
  }
  if (!isValidTicketResponse(ticket, endpoint)) {
    throw new RemoteProtocolError("The remote gateway returned an invalid browser WebSocket ticket.");
  }
  return ticket;
}

function openWebSocket(url: string, ticket: string): Promise<GatewaySocket> {
  if (typeof globalThis.WebSocket !== "function") {
    return Promise.reject(new RemoteProtocolError("This mobile platform does not provide WebSocket support."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, [BROWSER_WEBSOCKET_SUBPROTOCOL, ticket]);
    } catch {
      reject(new RemoteProtocolError("Cannot open the remote gateway WebSocket."));
      return;
    }
    socket.binaryType = "arraybuffer";
    const adapter = new BrowserGatewaySocket(socket);
    socket.onopen = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (socket.protocol !== BROWSER_WEBSOCKET_SUBPROTOCOL) {
        socket.close();
        reject(new RemoteProtocolError("The remote gateway did not negotiate the expected WebSocket protocol."));
        return;
      }
      resolve(adapter);
    };
    socket.onerror = () => {
      if (!settled) {
        settled = true;
        reject(new RemoteProtocolError("Cannot open the remote gateway WebSocket."));
      }
    };
    socket.onclose = () => {
      if (!settled) {
        settled = true;
        reject(new RemoteProtocolError("The remote gateway closed the WebSocket during connection."));
      }
    };
  });
}

class BrowserGatewaySocket implements GatewaySocket {
  private handlers: GatewaySocketHandlers | null = null;
  private readonly pending: Array<() => void> = [];

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      this.dispatch(() => {
        if (typeof event.data === "string") {
          this.handlers?.onText(event.data);
        } else {
          void toBytes(event.data).then(
            (bytes) => this.handlers?.onBinary(bytes),
            () => this.handlers?.onError(),
          );
        }
      });
    });
    // Use listeners rather than onclose/onerror properties: openWebSocket
    // owns the initial connection promise and replaces those properties while
    // this adapter must continue receiving post-open lifecycle events.
    socket.addEventListener("close", () => this.dispatch(() => this.handlers?.onClose()));
    socket.addEventListener("error", () => this.dispatch(() => this.handlers?.onError()));
  }

  setHandlers(handlers: GatewaySocketHandlers): void {
    this.handlers = handlers;
    while (this.pending.length > 0) {
      this.pending.shift()?.();
    }
  }

  sendText(text: string): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new RemoteProtocolError("The remote gateway WebSocket is not open.");
    }
    this.socket.send(text);
  }

  sendBinary(data: Uint8Array): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new RemoteProtocolError("The remote gateway WebSocket is not open.");
    }
    this.socket.send(data);
  }

  close(): void {
    this.socket.close();
  }

  private dispatch(callback: () => void): void {
    if (this.handlers) {
      callback();
      return;
    }
    this.pending.push(callback);
  }
}

function isValidTicketResponse(value: unknown, endpoint: BrowserWebSocketEndpoint): value is BrowserWebSocketTicketResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["ticket", "endpoint", "expires_at_unix_ms"].includes(key))
  ) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.ticket === "string" &&
    /^somniq-ticket-[A-Za-z0-9_-]+$/.test(candidate.ticket) &&
    candidate.ticket.length <= MAX_TICKET_LENGTH &&
    candidate.endpoint === endpoint &&
    typeof candidate.expires_at_unix_ms === "number" &&
    Number.isSafeInteger(candidate.expires_at_unix_ms) &&
    candidate.expires_at_unix_ms > Date.now()
  );
}

async function toBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new RemoteProtocolError("The remote gateway sent an invalid WebSocket frame.");
}
