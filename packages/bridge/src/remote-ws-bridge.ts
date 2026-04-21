import type { ControlClient } from "./control-client.js";
import type { WSBridgeLike } from "./mcp-server.js";
import type { ConfirmationChannel } from "./safety.js";

class CodedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Secondary-side adapter exposing a WSBridge-shaped API backed by a
 * {@link ControlClient} connection to the primary bridge.
 */
export class RemoteWSBridge implements WSBridgeLike {
  readonly confirmation: ConfirmationChannel;

  constructor(private readonly client: ControlClient) {
    this.confirmation = {
      awaitConfirmation: async (input) => {
        const res = await this.client.call<{ decision_id?: unknown; allow?: unknown }>(
          "safety_prompt",
          { ...input },
          input.timeout_ms,
        );
        if (
          res &&
          typeof res === "object" &&
          res.decision_id === input.decision_id &&
          typeof res.allow === "boolean"
        ) {
          return { allow: res.allow };
        }
        throw new CodedError("INTERNAL", "safety_prompt returned malformed result");
      },
    };
  }

  isConnected(): boolean {
    return this.client.isConnected();
  }

  callExtension<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.client.call<T>(method, params, timeoutMs, signal);
  }
}
