import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { ShimConnection } from "./daemon-socket.js";

/**
 * MCP Transport that pumps JSON-RPC messages over a shim ↔ daemon
 * Unix-socket connection. The shim already serialised stdio frames as
 * `mcp_in` envelopes; we parse the inner JSON-RPC payload for the
 * SDK's `onmessage`, and serialise outgoing JSON-RPC back as `mcp_out`.
 *
 * One transport per session — created in the daemon's onSession handler
 * and handed to a fresh `McpBridgeServer.connect()`.
 */
export class SocketServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  private connection: ShimConnection;
  private started = false;
  private closed = false;

  constructor(connection: ShimConnection, sessionId?: string) {
    this.connection = connection;
    this.sessionId = sessionId;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.connection.onMcpIn((data) => {
      // The shim forwards each MCP frame as a single line. Tolerate the
      // occasional trailing whitespace or lack of newline (the shim
      // strips the newline before forwarding).
      const trimmed = data.trim();
      if (!trimmed) return;
      let parsed: JSONRPCMessage;
      try {
        parsed = JSON.parse(trimmed) as JSONRPCMessage;
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.onmessage?.(parsed);
    });

    this.connection.onClose(() => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    });
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed) return;
    let serialised: string;
    try {
      serialised = JSON.stringify(message);
    } catch (err) {
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.connection.send({ type: "mcp_out", data: serialised });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.connection.close("transport_close");
    } catch {
      /* ignore */
    }
    this.onclose?.();
  }
}
