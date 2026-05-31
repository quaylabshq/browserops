/**
 * Ajv-based validator for playbook YAML documents (schema_version 1).
 *
 * Mirrors procedures/validator.ts. Compiled once at module load.
 */
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { PLAYBOOK_SCHEMA } from "@browserops/shared";

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

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

const _validate: ValidateFunction = ajv.compile(PLAYBOOK_SCHEMA);

const MAX_ERRORS = 10;

/**
 * Validates a parsed playbook object against PLAYBOOK_SCHEMA.
 *
 * Returns `{valid: true}` on success or `{valid: false, errors}` on
 * failure. Error strings are formatted as `"${instancePath} ${message}"`.
 */
export function validatePlaybook(obj: unknown): {
  valid: boolean;
  errors?: string[];
} {
  const ok = _validate(obj) as boolean;
  if (ok) return { valid: true };

  const rawErrors = _validate.errors ?? [];
  const limited = rawErrors.slice(0, MAX_ERRORS);

  const errors = limited.map((e) => {
    const path = e.instancePath || "(root)";
    return `${path} ${e.message ?? "invalid"}`;
  });

  return { valid: false, errors };
}
