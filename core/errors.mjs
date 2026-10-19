// @ts-check
// core/errors.mjs - the refusal error and short text for caught errors.

/** A refusal: the run stops before changing anything, exit code 2. */
export class SafetyError extends Error {}

/**
 * Error code of a caught error, if any.
 * @param {unknown} err  anything a `catch` received
 * @returns {string | undefined} the code, e.g. "ENOENT"
 */
export const errorCode = (err) => /** @type {NodeJS.ErrnoException} */ (err)?.code;

/**
 * Short text for a caught error: its code when it has one, else its message.
 * @param {unknown} err  anything a `catch` received
 * @returns {string} text for the output and the log
 */
export const errorText = (err) => errorCode(err) ?? (err instanceof Error ? err.message : String(err));
