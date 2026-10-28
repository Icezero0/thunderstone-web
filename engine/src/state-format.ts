import {RuleError} from './types.js';

/** Persisted state contract, independent of the build hash used by live previews.
 * Bump only for incompatible state/continuation changes and add a migration here.
 * Existing unmarked TypeScript saves use this same first format.
 */
export const STATE_FORMAT_VERSION = 1;
export function validateStateFormat(state: {state_format_version?: unknown}): void {
  if (state.state_format_version !== undefined && state.state_format_version !== STATE_FORMAT_VERSION)
    throw new RuleError('unsupported saved game state format');
}
