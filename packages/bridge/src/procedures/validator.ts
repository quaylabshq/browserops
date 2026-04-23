/**
 * Ajv-based validator for procedure YAML documents (schema_version 1).
 *
 * The validator is compiled ONCE at module load time (not per-call) to avoid
 * the schema-compilation overhead on every request.
 *
 * Callers are responsible for parsing YAML → object before calling
 * `validateProcedure`; this module only validates the parsed object.
 */
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { PROCEDURE_SCHEMA } from "@browserops/shared";

// ---------------------------------------------------------------------------
// Normalise CJS-default interop (same pattern as mcp-server.ts)
// ---------------------------------------------------------------------------

type AjvCtor = new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};
type AddFormatsFn = (ajv: unknown) => unknown;

const Ajv: AjvCtor =
  (AjvModule as unknown as { default?: AjvCtor }).default ??
  (AjvModule as unknown as AjvCtor);

const addFormats: AddFormatsFn =
  (addFormatsModule as unknown as { default?: AddFormatsFn }).default ??
  (addFormatsModule as unknown as AddFormatsFn);

// ---------------------------------------------------------------------------
// Compile validator once at module load
// ---------------------------------------------------------------------------

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

const _validate: ValidateFunction = ajv.compile(PROCEDURE_SCHEMA);

// ---------------------------------------------------------------------------
// Error cap
// ---------------------------------------------------------------------------

const MAX_ERRORS = 10;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates a parsed procedure object against the procedure JSON-Schema.
 *
 * Returns `{ valid: true }` on success, or
 * `{ valid: false, errors: string[] }` on failure.
 *
 * Error strings are formatted as `"${instancePath} ${message}"`.
 * At most {@link MAX_ERRORS} errors are returned to avoid log spam.
 */
export function validateProcedure(obj: unknown): {
  valid: boolean;
  errors?: string[];
} {
  const ok = _validate(obj) as boolean;

  if (ok) {
    return { valid: true };
  }

  const rawErrors = _validate.errors ?? [];
  const limited = rawErrors.slice(0, MAX_ERRORS);

  const errors = limited.map((e) => {
    const path = e.instancePath || "(root)";
    return `${path} ${e.message ?? "invalid"}`;
  });

  return { valid: false, errors };
}
