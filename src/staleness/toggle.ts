/**
 * Runtime switch for source-grounded freshness.
 *
 * Freshness is a first-class update signal and is enabled by default:
 * production never sets the override, so shipped behavior is unchanged. The
 * `OPENWIKI_DISABLE_SOURCE_FRESHNESS` environment override exists so the
 * source-freshness benchmark can run a genuine control arm in which the whole
 * mechanism is inert: no preflight scan, no stale-page injection into the agent
 * prompt, no `record_source_dependencies` tool, and no grounding instructions.
 *
 * This module is the single source of truth for that decision. Every
 * integration point consults it rather than reading the environment directly,
 * so freshness is either wholly on or wholly off within a run.
 */

/**
 * Environment override that disables source-grounded freshness when set to
 * exactly `"1"`. Any other value, or an unset variable, leaves freshness on.
 */
export const DISABLE_SOURCE_FRESHNESS_ENV_KEY =
  "OPENWIKI_DISABLE_SOURCE_FRESHNESS";

/**
 * Whether source-grounded freshness participates in the current process.
 *
 * Read at call time and never cached, so a test or benchmark can flip the arm
 * between sequential in-process runs by mutating the environment variable.
 *
 * @returns `true` when freshness should run, `false` for the disabled control
 *   arm.
 */
export function isSourceFreshnessEnabled(): boolean {
  return process.env[DISABLE_SOURCE_FRESHNESS_ENV_KEY] !== "1";
}
