import type { ErrorCode, TeachScope } from "@browserops/shared";
import type { Router } from "../router.js";
import type { TeachRecorder } from "../teach-recorder.js";

interface TeachHandlersOpts {
  recorder: TeachRecorder;
}

function makeError(code: ErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function parseScope(raw: unknown): TeachScope {
  if (raw === undefined) return "all_tabs";
  if (raw !== "active_tab" && raw !== "all_tabs") {
    throw makeError("INVALID_PARAMS", "scope must be 'active_tab' or 'all_tabs'");
  }
  return raw;
}

export function registerTeachHandlers(router: Router, opts: TeachHandlersOpts): void {
  const { recorder } = opts;

  router.register("teach_start", async (params) => {
    const scope = parseScope(params["scope"]);
    const hintRaw = params["narration_hint"];
    const narrationHint = typeof hintRaw === "string" && hintRaw !== "" ? hintRaw : undefined;
    return recorder.start(scope, narrationHint);
  });

  router.register("teach_stop", async () => {
    const result = await recorder.stop();
    if (result === null) {
      throw makeError("INVALID_STATE", "no active teach session");
    }
    return result;
  });

  router.register("teach_status", async () => {
    return recorder.status();
  });

  router.register("teach_marker", async (params) => {
    const labelRaw = params["label"];
    const label = typeof labelRaw === "string" ? labelRaw : undefined;
    if (!recorder.isActive()) {
      throw makeError("INVALID_STATE", "no active teach session");
    }
    recorder.recordMarker(label);
    return { ok: true };
  });

  router.register("teach_narration", async (params) => {
    const textRaw = params["text"];
    if (typeof textRaw !== "string" || textRaw === "") {
      throw makeError("INVALID_PARAMS", "text:string required");
    }
    if (!recorder.isActive()) {
      throw makeError("INVALID_STATE", "no active teach session");
    }
    recorder.recordNarration(textRaw);
    return { ok: true };
  });
}
