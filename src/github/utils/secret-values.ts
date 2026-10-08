import { BASH_ENV_ALLOWLIST } from "../../runner/env-allowlist";

/**
 * Redaction by value (ADR-0002): keys of providers whose format is unknown
 * (OpenCode, for example) and secrets the workflow sets under its own names
 * cannot be matched by pattern, so every environment value outside the bash
 * env allowlist, of at least MIN_SECRET_LENGTH characters, is treated as a
 * secret and replaced wherever it turns up, raw, base64 or URL-encoded.
 */
const MIN_SECRET_LENGTH = 16;

export const REDACTED = "[REDACTED]";

/** The forms to replace, longest first so no form is left half-replaced. */
let secretForms: string[] = [];

/**
 * A value's base64 forms: on its own, then inside a larger blob at each of
 * the 3 offsets from a 3-byte group boundary. Inside a blob only the
 * characters made purely of the value's bits are fixed, so the characters
 * that mix in neighbouring bytes are left out.
 */
function base64Forms(value: string): string[] {
  const bytes = Buffer.from(value);
  const forms = [bytes.toString("base64")];
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString(
      "base64",
    );
    // The first character holding none of the offset bytes' bits, and the
    // end of the last character holding only the value's bits.
    const start = Math.ceil((offset * 8) / 6);
    const end = Math.floor(((offset + bytes.length) * 8) / 6);
    forms.push(encoded.slice(start, end));
  }
  return forms;
}

/**
 * Collect the secret values from the environment, replacing any collected
 * before. Called once at startup, before the action changes its environment.
 * A value that an allowlisted variable also holds (PWD and GITHUB_WORKSPACE,
 * for example) is not a secret.
 */
export function collectSecretValues(env: NodeJS.ProcessEnv): void {
  const allowlisted = new Set(
    BASH_ENV_ALLOWLIST.map((name) => env[name]).filter(Boolean),
  );
  const values = Object.entries(env)
    .filter(([name]) => !BASH_ENV_ALLOWLIST.includes(name))
    .map(([, value]) => value)
    .filter(
      (value): value is string =>
        value !== undefined &&
        value.length >= MIN_SECRET_LENGTH &&
        !allowlisted.has(value),
    );
  const forms = new Set(
    values.flatMap((value) => [
      value,
      encodeURIComponent(value),
      ...base64Forms(value),
    ]),
  );
  secretForms = [...forms].sort((a, b) => b.length - a.length);
}

/** Replace every form of the collected secret values with [REDACTED]. */
export function redactSecretValues(content: string): string {
  for (const form of secretForms) {
    content = content.replaceAll(form, REDACTED);
  }
  return content;
}
