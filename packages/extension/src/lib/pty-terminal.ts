/**
 * Embedded terminal pane — an xterm.js bound to the bridge's /chat/pty
 * WebSocket. Raw pty output (the live interactive Claude TUI) is written into the
 * terminal; keystrokes and resize go back as JSON frames. The SAME pty also feeds
 * the clean chat view via the transcript tailer, so a turn typed here also shows
 * up in the chat bubbles.
 *
 * This module statically imports xterm (~250KB), so the panel dynamically
 * imports THIS module only when the user actually opens the terminal.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ptyInputFrame, ptyResizeFrame, ptyUrl } from "./chat-client.js";

export interface EmbeddedTerminal {
  /** Re-fit to the container (call after the pane becomes visible / resizes). */
  fit(): void;
  /** Close the socket + dispose the terminal. */
  dispose(): void;
}

export function mountTerminal(opts: {
  container: HTMLElement;
  token: string;
  sessionId: string;
}): EmbeddedTerminal {
  const term = new Terminal({
    fontSize: 12,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    cursorBlink: true,
    convertEol: false,
    // Match the .terminal chrome tokens (--color-term-bg / --color-term-text).
    theme: { background: "#1a191d", foreground: "#f3f3f5" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(opts.container);
  const tryFit = (): void => {
    try {
      fit.fit();
    } catch {
      /* container not laid out yet */
    }
  };
  tryFit();

  const ws = new WebSocket(ptyUrl(opts.token, opts.sessionId));
  const sendResize = (): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(ptyResizeFrame(term.cols, term.rows));
  };
  ws.onmessage = (e: MessageEvent): void => {
    if (typeof e.data === "string") term.write(e.data);
  };
  ws.onopen = (): void => {
    tryFit();
    sendResize();
  };

  const dataSub = term.onData((d) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(ptyInputFrame(d));
  });
  const resizeSub = term.onResize(() => sendResize());
  const onWindowResize = (): void => tryFit();
  window.addEventListener("resize", onWindowResize);

  return {
    fit: tryFit,
    dispose: () => {
      window.removeEventListener("resize", onWindowResize);
      dataSub.dispose();
      resizeSub.dispose();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
    },
  };
}
