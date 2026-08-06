/**
 * Real-agent end-to-end head-to-head.
 *
 * Question: given the same realistic code change, does OpenWiki maintain the
 * wiki better WITH source-grounded freshness than WITHOUT it? Both arms invoke
 * the real update agent (`runOpenWikiAgent`) on an isolated throwaway copy of a
 * synthetic repository and its hand-authored wiki. The only variable between
 * the arms is whether recorded source-dependency sidecars exist:
 *
 * - WITHOUT: no sidecars, so freshness contributes nothing and the agent must
 *   infer which pages a change affects from the git diff alone.
 * - WITH: real sidecars recorded by the production recorder, so the update gate
 *   hands the agent an explicit "these pages must be revalidated" list.
 *
 * The git diff is identical and available to both arms, so any difference is
 * attributable to the source->page routing the recorded dependencies provide.
 *
 * The changes under test are deliberately *behavioral and architectural*, not
 * constant tweaks: an auth contract flip, a feature addition that spans the
 * system, a cross-cutting refactor that moves a responsibility between modules,
 * and a feature removal that makes old documentation actively wrong. The point
 * is to exercise the real maintenance problem, where the source->page impact is
 * not obvious from the diff and a page can be stale without textually quoting
 * the line that changed.
 *
 * Ground truth (which pages a change should affect, and a content marker a
 * correct update must remove or add) is hand-labeled per scenario, never taken
 * from the agent or the sidecars. Grading is a content oracle: a page is
 * correctly updated when its stale marker is gone and its required marker is
 * present; it still carries stale information otherwise. An edit to a
 * source-grounded page outside the expected set is an unnecessary update
 * (operational/generated pages are excluded via the production
 * `isSourceGroundedPage`, so they never distort the metric).
 *
 * Everything is contained in `os.tmpdir()` throwaway git repos and removed
 * afterwards; the real repository is never touched. Mutated source is only ever
 * written and read as bytes, never executed.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { runOpenWikiAgent } from "../../src/agent/index.js";
import { OPEN_WIKI_DIR } from "../../src/constants.js";
import { recordSourceDependencies } from "../../src/staleness/recorder.js";
import { writeSidecarAtomic } from "../../src/staleness/storage.js";
import { isSourceGroundedPage } from "../../src/staleness/storage.js";
import { git, sharedResolver, withTempGitRepo } from "../freshness/harness.js";
import { FileSystemSourceReader } from "../../src/staleness/freshness.js";

/**
 * One source dependency a wiki page is grounded in, for sidecar recording.
 */
export interface Grounding {
  /**
   * Repository-relative POSIX path of the page (under `openwiki/`).
   */
  page: string;

  /**
   * Repository-relative POSIX path of the source file the page cites.
   */
  path: string;

  /**
   * Qualified symbol the page depends on.
   *
   * @default undefined - track the whole file instead of a single definition.
   */
  symbol?: string;
}

/**
 * A hand-labeled expectation for one wiki page a scenario's change should touch.
 * At least one of `staleMarker` / `requiredMarker` must be set.
 */
export interface ExpectedPage {
  /**
   * Repository-relative POSIX path of the page (under `openwiki/`).
   */
  page: string;

  /**
   * A substring present in the baseline page that a correct update must remove
   * or replace. Its continued presence after the run means the page still
   * carries stale information. Matched case-sensitively.
   *
   * @default undefined - the page has nothing to unlearn (a pure addition).
   */
  staleMarker?: string;

  /**
   * A substring that a correct update must introduce, for changes where the
   * page must now describe new behavior rather than merely drop old text. Its
   * absence after the run means the page failed to pick up the change. Matched
   * case-insensitively so `Middleware` satisfies `middleware`.
   *
   * @default undefined - the page has nothing new to state (a pure removal).
   */
  requiredMarker?: string;
}

/**
 * A head-to-head scenario: a synthetic repo + wiki baseline, one realistic
 * change, and the pages that change should affect.
 */
export interface Scenario {
  /**
   * Stable identifier, usable as a `--scenario` filter.
   */
  name: string;

  /**
   * Which kind of realistic change this scenario exercises.
   */
  kind:
    | "behavioral"
    | "feature-add"
    | "refactor"
    | "feature-remove"
    | "durability";

  /**
   * One-line description of the change under test.
   */
  description: string;

  /**
   * Baseline source files, repo-relative POSIX path to file bytes.
   */
  sources: Record<string, string>;

  /**
   * Baseline wiki pages, repo-relative POSIX path (under `openwiki/`) to bytes.
   */
  pages: Record<string, string>;

  /**
   * The source dependencies each page is grounded in, recorded as sidecars in
   * the WITH arm only.
   */
  grounding: Grounding[];

  /**
   * The realistic code change, applied as byte-level file writes to the seeded
   * worktree. Returns nothing; mutating source on disk is the whole effect.
   */
  applyChange: (cwd: string) => Promise<void>;

  /**
   * Pages the change should cause the agent to update, hand-labeled.
   */
  expected: ExpectedPage[];

  /**
   * When true, the applied change is committed and the update cursor
   * (`openwiki/.last-update.json` gitHead) is advanced past it, so `git diff`
   * reports nothing. This isolates the durability path: the only signal that a
   * page is stale is the recorded sidecar, which exists in the WITH arm only.
   *
   * @default undefined - leave the change as an uncommitted worktree edit, so
   * git sees it in both arms and both arms run.
   */
  behindCursor?: boolean;
}

/**
 * The grade for one arm of one scenario.
 */
export interface ArmResult {
  /**
   * Expected pages whose stale marker was removed and required marker added
   * (correctly updated).
   */
  correctlyUpdated: string[];

  /**
   * Expected pages that failed the oracle (still stale or missing new content).
   */
  stillStale: string[];

  /**
   * Source-grounded pages outside the expected set whose bytes changed
   * (unnecessary updates). Operational/generated pages are excluded.
   */
  unnecessary: string[];

  /**
   * Wall-clock milliseconds spent inside the agent run.
   */
  wallMs: number;

  /**
   * Whether the run threw (recorded so a provider failure is visible, not
   * silently graded as an all-miss).
   */
  errored: boolean;
}

/**
 * The paired arms for one scenario.
 */
export interface ScenarioResult {
  scenario: string;
  kind: Scenario["kind"];
  description: string;
  expectedCount: number;
  without: ArmResult;
  with: ArmResult;
}

/**
 * The shared synthetic library the scenarios mutate: a small but
 * architecturally real HTTP client. Config resolution, a pluggable auth
 * strategy, retry/backoff, a transport, and a client that wires them together
 * each live in their own module, so a realistic change touches real functions
 * and classes across files rather than a single constant.
 */
function baseSources(): Record<string, string> {
  return {
    "src/types.ts": [
      "export interface RequestOptions {",
      '  method: "GET" | "POST" | "PUT" | "DELETE";',
      "  path: string;",
      "  headers: Record<string, string>;",
      "  body?: string;",
      "}",
      "",
      "export interface FluxResponse {",
      "  status: number;",
      "  body: string;",
      "}",
      "",
      "export interface AuthStrategy {",
      "  /** Apply auth to the outgoing headers in place, synchronously. */",
      "  apply(headers: Record<string, string>): void;",
      "}",
      "",
      "export interface RetryPolicy {",
      "  maxRetries: number;",
      "  baseDelayMs: number;",
      "}",
      "",
    ].join("\n"),
    "src/config.ts": [
      'import type { RetryPolicy } from "./types.js";',
      "",
      "export interface FluxConfig {",
      "  baseUrl: string;",
      "  maxRetries: number;",
      "  timeoutMs: number;",
      "  authToken: string;",
      "}",
      "",
      "const DEFAULTS = { maxRetries: 3, timeoutMs: 5000 };",
      "",
      "/**",
      " * Resolve the effective client configuration. Precedence, highest first:",
      " * explicit overrides, then environment variables, then built-in defaults.",
      " */",
      "export function resolveConfig(overrides: Partial<FluxConfig>): FluxConfig {",
      "  const fromEnv: Partial<FluxConfig> = {};",
      "  if (process.env.FLUX_BASE_URL) fromEnv.baseUrl = process.env.FLUX_BASE_URL;",
      "  if (process.env.FLUX_MAX_RETRIES) fromEnv.maxRetries = Number(process.env.FLUX_MAX_RETRIES);",
      "  if (process.env.FLUX_TIMEOUT_MS) fromEnv.timeoutMs = Number(process.env.FLUX_TIMEOUT_MS);",
      "  if (process.env.FLUX_AUTH_TOKEN) fromEnv.authToken = process.env.FLUX_AUTH_TOKEN;",
      "",
      "  return {",
      '    baseUrl: "https://api.flux.dev",',
      '    authToken: "",',
      "    ...DEFAULTS,",
      "    ...fromEnv,",
      "    ...overrides,",
      "  };",
      "}",
      "",
      "export function retryPolicy(config: FluxConfig): RetryPolicy {",
      "  return { maxRetries: config.maxRetries, baseDelayMs: 200 };",
      "}",
      "",
    ].join("\n"),
    "src/auth.ts": [
      'import type { AuthStrategy } from "./types.js";',
      "",
      "/**",
      " * Bearer-token authentication: adds a static `Authorization: Bearer <token>`",
      " * header to every request, synchronously.",
      " */",
      "export class BearerAuth implements AuthStrategy {",
      "  constructor(private readonly token: string) {}",
      "",
      "  apply(headers: Record<string, string>): void {",
      '    headers["Authorization"] = `Bearer ${this.token}`;',
      "  }",
      "}",
      "",
    ].join("\n"),
    "src/retry.ts": [
      'import type { RetryPolicy } from "./types.js";',
      "",
      "/**",
      " * Exponential backoff: attempt n waits `baseDelayMs * 2 ** n`.",
      " */",
      "export function nextDelayMs(attempt: number, policy: RetryPolicy): number {",
      "  return policy.baseDelayMs * 2 ** attempt;",
      "}",
      "",
      "/**",
      " * Retry only on server errors (HTTP 5xx), up to the policy's maxRetries.",
      " */",
      "export function shouldRetry(status: number, attempt: number, policy: RetryPolicy): boolean {",
      "  return attempt < policy.maxRetries && status >= 500;",
      "}",
      "",
    ].join("\n"),
    "src/transport.ts": [
      'import type { RequestOptions, FluxResponse } from "./types.js";',
      "",
      "/**",
      " * Send a single request over the wire. This is the only layer that performs",
      " * network IO, and it does not retry.",
      " */",
      "export async function send(",
      "  baseUrl: string,",
      "  options: RequestOptions,",
      "  timeoutMs: number,",
      "): Promise<FluxResponse> {",
      "  void timeoutMs;",
      "  return { status: 200, body: `${options.method} ${baseUrl}${options.path}` };",
      "}",
      "",
    ].join("\n"),
    "src/errors.ts": [
      "/** Base class for all Flux client errors. */",
      "export class FluxError extends Error {}",
      "",
      "/** Raised when a request exceeds its configured timeout. */",
      "export class TimeoutError extends FluxError {}",
      "",
      "/** Raised for a non-retryable error status. Carries the HTTP status. */",
      "export class RequestError extends FluxError {",
      "  constructor(readonly status: number, message: string) {",
      "    super(message);",
      "  }",
      "}",
      "",
    ].join("\n"),
    "src/client.ts": [
      'import { resolveConfig, retryPolicy, type FluxConfig } from "./config.js";',
      'import { BearerAuth } from "./auth.js";',
      'import type { AuthStrategy, RequestOptions, FluxResponse } from "./types.js";',
      'import { nextDelayMs, shouldRetry } from "./retry.js";',
      'import { send } from "./transport.js";',
      'import { RequestError } from "./errors.js";',
      "",
      "/**",
      " * The Flux HTTP client. Owns the request lifecycle: it applies authentication,",
      " * sends the request through the transport, and retries failed attempts",
      " * according to the configured retry policy.",
      " */",
      "export class HttpClient {",
      "  constructor(",
      "    private readonly config: FluxConfig,",
      "    private readonly auth: AuthStrategy,",
      "  ) {}",
      "",
      "  /** Execute a request, applying auth and retrying transient failures. */",
      "  async request(options: RequestOptions): Promise<FluxResponse> {",
      "    const headers = { ...options.headers };",
      "    this.auth.apply(headers);",
      "",
      "    const policy = retryPolicy(this.config);",
      "    let attempt = 0;",
      "    for (;;) {",
      "      const response = await send(",
      "        this.config.baseUrl,",
      "        { ...options, headers },",
      "        this.config.timeoutMs,",
      "      );",
      "      if (!shouldRetry(response.status, attempt, policy)) {",
      "        if (response.status >= 400) {",
      '          throw new RequestError(response.status, "request failed");',
      "        }",
      "        return response;",
      "      }",
      "      void nextDelayMs(attempt, policy);",
      "      attempt += 1;",
      "    }",
      "  }",
      "",
      "  get(path: string): Promise<FluxResponse> {",
      '    return this.request({ method: "GET", path, headers: {} });',
      "  }",
      "}",
      "",
      "/**",
      " * Create a client from partial overrides, resolving configuration and wiring",
      " * the default Bearer authentication strategy.",
      " */",
      "export function createClient(overrides: Partial<FluxConfig> = {}): HttpClient {",
      "  const config = resolveConfig(overrides);",
      "  return new HttpClient(config, new BearerAuth(config.authToken));",
      "}",
      "",
    ].join("\n"),
    "src/index.ts": [
      'export { createClient, HttpClient } from "./client.js";',
      'export { resolveConfig, retryPolicy, type FluxConfig } from "./config.js";',
      'export { BearerAuth } from "./auth.js";',
      'export { nextDelayMs, shouldRetry } from "./retry.js";',
      'export { send } from "./transport.js";',
      'export * from "./types.js";',
      'export * from "./errors.js";',
      "",
    ].join("\n"),
  };
}

/**
 * The shared baseline wiki: conceptual pages, each grounded in real symbols
 * above, so a behavioral or architectural change makes exactly the right
 * page(s) stale without any page trivially quoting the changed source line.
 */
function basePages(): Record<string, string> {
  return {
    "openwiki/quickstart.md": [
      "# Flux Quickstart",
      "",
      "Flux is a small HTTP client. Create a client with `createClient` and make",
      "requests:",
      "",
      "```ts",
      'const client = createClient({ baseUrl: "https://api.example.com", authToken: "t" });',
      'const res = await client.get("/health");',
      "```",
      "",
      "Configuration can also come from `FLUX_*` environment variables. See",
      "[configuration](configuration.md), [authentication](authentication.md),",
      "[retries](retries.md), and [architecture](architecture.md).",
      "",
    ].join("\n"),
    "openwiki/architecture.md": [
      "# Architecture",
      "",
      "A request flows through four layers:",
      "",
      "1. **Client** (`HttpClient`) owns the request lifecycle and the retry loop.",
      "2. **Auth** (`AuthStrategy`) applies credentials to the outgoing headers",
      "   synchronously via `apply`.",
      "3. **Retry** (`shouldRetry` / `nextDelayMs`) decides whether to re-send and",
      "   how long to wait, using exponential backoff.",
      "4. **Transport** (`send`) performs the single network call and never retries.",
      "",
      "The client applies auth, then loops: send through the transport and retry on",
      "5xx responses until the policy's `maxRetries` is exhausted.",
      "",
    ].join("\n"),
    "openwiki/configuration.md": [
      "# Configuration",
      "",
      "`resolveConfig` builds the effective `FluxConfig`. Values are resolved with",
      "the following precedence, highest first:",
      "",
      "1. Explicit overrides passed to `createClient`.",
      "2. Environment variables: `FLUX_BASE_URL`, `FLUX_MAX_RETRIES`,",
      "   `FLUX_TIMEOUT_MS`, and `FLUX_AUTH_TOKEN`.",
      "3. Built-in defaults (`maxRetries` 3, `timeoutMs` 5000).",
      "",
      "So an explicit override always wins over the environment, and the",
      "environment wins over the defaults.",
      "",
    ].join("\n"),
    "openwiki/authentication.md": [
      "# Authentication",
      "",
      "Authentication is pluggable through the `AuthStrategy` interface. The",
      "default strategy is `BearerAuth`, which adds a static",
      "`Authorization: Bearer <token>` header to every request.",
      "",
      "`AuthStrategy.apply` is synchronous: it mutates the outgoing headers in",
      "place and returns nothing. The client calls it once per request before",
      "handing the request to the transport.",
      "",
    ].join("\n"),
    "openwiki/retries.md": [
      "# Retries",
      "",
      "The client retries failed requests. `shouldRetry` returns true only for",
      "server errors (HTTP 5xx) and only while the attempt count is below the",
      "policy's `maxRetries` (default 3).",
      "",
      "Between attempts the client waits `nextDelayMs`, which grows exponentially:",
      "attempt n waits `baseDelayMs * 2 ** n`. Retries are orchestrated by the",
      "client's `request` method, not by the transport.",
      "",
    ].join("\n"),
    "openwiki/client.md": [
      "# HTTP Client",
      "",
      "`HttpClient.request` is the core entry point. It:",
      "",
      "1. Clones the request headers and applies auth via `AuthStrategy.apply`.",
      "2. Sends the request through `send` and inspects the status.",
      "3. Retries 5xx responses using the retry policy, waiting between attempts.",
      "",
      "`createClient` is the usual constructor: it resolves configuration and wires",
      "a `BearerAuth` strategy. `HttpClient.get` is a convenience wrapper over",
      "`request`.",
      "",
    ].join("\n"),
    "openwiki/errors.md": [
      "# Errors",
      "",
      "All Flux errors extend `FluxError`. `TimeoutError` is raised when a request",
      "exceeds `timeoutMs`. `RequestError` carries the HTTP `status` and is thrown",
      "for non-retryable responses.",
      "",
    ].join("\n"),
  };
}

/**
 * The dependency grounding shared by every scenario, since they share the same
 * baseline source and wiki. Each page is anchored on at least one function or
 * class that the scenarios actually change, so its sidecar drifts when the
 * change lands (rather than relying on interface-only anchors).
 */
const BASE_GROUNDING: Grounding[] = [
  { page: "openwiki/configuration.md", path: "src/config.ts", symbol: "resolveConfig" },
  { page: "openwiki/authentication.md", path: "src/auth.ts", symbol: "BearerAuth" },
  { page: "openwiki/authentication.md", path: "src/client.ts", symbol: "HttpClient" },
  { page: "openwiki/retries.md", path: "src/retry.ts", symbol: "shouldRetry" },
  { page: "openwiki/retries.md", path: "src/retry.ts", symbol: "nextDelayMs" },
  { page: "openwiki/retries.md", path: "src/client.ts", symbol: "HttpClient" },
  { page: "openwiki/client.md", path: "src/client.ts", symbol: "HttpClient" },
  { page: "openwiki/client.md", path: "src/client.ts", symbol: "createClient" },
  { page: "openwiki/architecture.md", path: "src/client.ts", symbol: "HttpClient" },
  { page: "openwiki/architecture.md", path: "src/auth.ts", symbol: "BearerAuth" },
  { page: "openwiki/architecture.md", path: "src/transport.ts", symbol: "send" },
  { page: "openwiki/quickstart.md", path: "src/client.ts", symbol: "createClient" },
  { page: "openwiki/quickstart.md", path: "src/config.ts", symbol: "resolveConfig" },
  { page: "openwiki/errors.md", path: "src/errors.ts", symbol: "FluxError" },
];

/**
 * Overwrite one file under the throwaway repo, creating parent directories.
 * `relativePath` is always a literal scenario constant, never external input.
 */
async function writeSource(
  cwd: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const absolute = path.join(cwd, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

/**
 * Rewrite `src/auth.ts` and its call sites so authentication becomes an async
 * request-signing contract instead of a synchronous Bearer header. Touches the
 * auth module, the shared interface, the client that calls it, and the barrel.
 */
async function applyAuthAsync(cwd: string): Promise<void> {
  await writeSource(
    cwd,
    "src/types.ts",
    baseSources()["src/types.ts"].replace(
      [
        "export interface AuthStrategy {",
        "  /** Apply auth to the outgoing headers in place, synchronously. */",
        "  apply(headers: Record<string, string>): void;",
        "}",
      ].join("\n"),
      [
        "export interface AuthStrategy {",
        "  /** Sign the request asynchronously, mutating its headers in place. */",
        "  authenticate(request: RequestOptions): Promise<void>;",
        "}",
      ].join("\n"),
    ),
  );
  await writeSource(
    cwd,
    "src/auth.ts",
    [
      'import type { AuthStrategy, RequestOptions } from "./types.js";',
      'import { createHmac } from "node:crypto";',
      "",
      "/**",
      " * Signature authentication: computes an HMAC-SHA256 signature over the",
      " * request method and path and attaches it, along with a timestamp header.",
      " */",
      "export class SignatureAuth implements AuthStrategy {",
      "  constructor(private readonly token: string) {}",
      "",
      "  async authenticate(request: RequestOptions): Promise<void> {",
      "    const timestamp = String(Date.now());",
      '    const payload = `${request.method} ${request.path} ${timestamp}`;',
      '    const signature = createHmac("sha256", this.token).update(payload).digest("hex");',
      '    request.headers["X-Flux-Timestamp"] = timestamp;',
      '    request.headers["Authorization"] = `Flux-HMAC ${signature}`;',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await writeSource(
    cwd,
    "src/client.ts",
    baseSources()
      ["src/client.ts"].replace(
        'import { BearerAuth } from "./auth.js";',
        'import { SignatureAuth } from "./auth.js";',
      )
      .replace(
        [
          "    const headers = { ...options.headers };",
          "    this.auth.apply(headers);",
        ].join("\n"),
        [
          "    const headers = { ...options.headers };",
          "    await this.auth.authenticate({ ...options, headers });",
        ].join("\n"),
      )
      .replace(
        "  return new HttpClient(config, new BearerAuth(config.authToken));",
        "  return new HttpClient(config, new SignatureAuth(config.authToken));",
      ),
  );
  await writeSource(
    cwd,
    "src/index.ts",
    baseSources()["src/index.ts"].replace(
      'export { BearerAuth } from "./auth.js";',
      'export { SignatureAuth } from "./auth.js";',
    ),
  );
}

/**
 * Add a request/response middleware (interceptor) layer as a coherent feature:
 * a new middleware module with built-ins, a config option carrying the chain,
 * the client running the chain around each send, a barrel export, and a test.
 */
async function applyAddMiddleware(cwd: string): Promise<void> {
  await writeSource(
    cwd,
    "src/middleware/types.ts",
    [
      'import type { RequestOptions, FluxResponse } from "../types.js";',
      "",
      "/**",
      " * A request/response interceptor. `onRequest` runs before the request is",
      " * sent; `onResponse` runs after a response is received.",
      " */",
      "export interface Middleware {",
      "  onRequest?(request: RequestOptions): void;",
      "  onResponse?(response: FluxResponse): void;",
      "}",
      "",
    ].join("\n"),
  );
  await writeSource(
    cwd,
    "src/middleware/logging.ts",
    [
      'import type { Middleware } from "./types.js";',
      "",
      "/** Logs each request and response to the console. */",
      "export const loggingMiddleware: Middleware = {",
      "  onRequest(request) {",
      "    console.log(`-> ${request.method} ${request.path}`);",
      "  },",
      "  onResponse(response) {",
      "    console.log(`<- ${response.status}`);",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  await writeSource(
    cwd,
    "src/middleware/retryAfter.ts",
    [
      'import type { Middleware } from "./types.js";',
      "",
      "/** Records a server-provided Retry-After hint on 429 responses. */",
      "export const retryAfterMiddleware: Middleware = {",
      "  onResponse(response) {",
      "    if (response.status === 429) {",
      "      console.warn(\"server asked us to back off\");",
      "    }",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  await writeSource(
    cwd,
    "src/middleware/compose.ts",
    [
      'import type { Middleware } from "./types.js";',
      'import type { RequestOptions, FluxResponse } from "../types.js";',
      "",
      "/** Run every middleware's onRequest hook, in order. */",
      "export function runOnRequest(chain: Middleware[], request: RequestOptions): void {",
      "  for (const middleware of chain) middleware.onRequest?.(request);",
      "}",
      "",
      "/** Run every middleware's onResponse hook, in order. */",
      "export function runOnResponse(chain: Middleware[], response: FluxResponse): void {",
      "  for (const middleware of chain) middleware.onResponse?.(response);",
      "}",
      "",
    ].join("\n"),
  );
  await writeSource(
    cwd,
    "src/middleware/index.ts",
    [
      'export type { Middleware } from "./types.js";',
      'export { loggingMiddleware } from "./logging.js";',
      'export { retryAfterMiddleware } from "./retryAfter.js";',
      'export { runOnRequest, runOnResponse } from "./compose.js";',
      "",
    ].join("\n"),
  );
  await writeSource(
    cwd,
    "src/config.ts",
    baseSources()
      ["src/config.ts"].replace(
        'import type { RetryPolicy } from "./types.js";',
        [
          'import type { RetryPolicy } from "./types.js";',
          'import type { Middleware } from "./middleware/index.js";',
        ].join("\n"),
      )
      .replace(
        "  authToken: string;\n}",
        "  authToken: string;\n  middleware: Middleware[];\n}",
      )
      .replace(
        '    authToken: "",',
        '    authToken: "",\n    middleware: [],',
      ),
  );
  await writeSource(
    cwd,
    "src/client.ts",
    baseSources()
      ["src/client.ts"].replace(
        'import { RequestError } from "./errors.js";',
        [
          'import { RequestError } from "./errors.js";',
          'import { runOnRequest, runOnResponse } from "./middleware/index.js";',
        ].join("\n"),
      )
      .replace(
        [
          "    const headers = { ...options.headers };",
          "    this.auth.apply(headers);",
        ].join("\n"),
        [
          "    const headers = { ...options.headers };",
          "    this.auth.apply(headers);",
          "    const request = { ...options, headers };",
          "    runOnRequest(this.config.middleware, request);",
        ].join("\n"),
      )
      .replace(
        [
          "      const response = await send(",
          "        this.config.baseUrl,",
          "        { ...options, headers },",
          "        this.config.timeoutMs,",
          "      );",
        ].join("\n"),
        [
          "      const response = await send(",
          "        this.config.baseUrl,",
          "        request,",
          "        this.config.timeoutMs,",
          "      );",
          "      runOnResponse(this.config.middleware, response);",
        ].join("\n"),
      ),
  );
  await writeSource(
    cwd,
    "src/index.ts",
    baseSources()["src/index.ts"].replace(
      'export * from "./errors.js";',
      [
        'export * from "./errors.js";',
        'export * from "./middleware/index.js";',
      ].join("\n"),
    ),
  );
  await writeSource(
    cwd,
    "test/middleware.test.ts",
    [
      'import { describe, expect, it } from "vitest";',
      'import { runOnRequest, loggingMiddleware } from "../src/middleware/index.js";',
      "",
      'describe("middleware", () => {',
      '  it("invokes onRequest hooks in order", () => {',
      "    const seen: string[] = [];",
      "    runOnRequest(",
      "      [{ onRequest: () => seen.push(\"a\") }, loggingMiddleware],",
      '      { method: "GET", path: "/x", headers: {} },',
      "    );",
      '    expect(seen).toEqual(["a"]);',
      "  });",
      "});",
      "",
    ].join("\n"),
  );
}

/**
 * Move the retry responsibility out of the client and into a dedicated
 * retrying-transport layer. The client stops owning the loop; a new module
 * orchestrates send + backoff. Cross-cutting: client, transport wrapper, and
 * the docs describing where retries live all have to move together.
 */
async function applyMoveRetries(cwd: string): Promise<void> {
  await writeSource(
    cwd,
    "src/retryingTransport.ts",
    [
      'import type { FluxConfig } from "./config.js";',
      'import { retryPolicy } from "./config.js";',
      'import type { RequestOptions, FluxResponse } from "./types.js";',
      'import { nextDelayMs, shouldRetry } from "./retry.js";',
      'import { send } from "./transport.js";',
      "",
      "/**",
      " * Send a request and retry transient (5xx) failures. Retries now live here,",
      " * in the transport layer, rather than in the client.",
      " */",
      "export async function sendWithRetry(",
      "  config: FluxConfig,",
      "  request: RequestOptions,",
      "): Promise<FluxResponse> {",
      "  const policy = retryPolicy(config);",
      "  let attempt = 0;",
      "  for (;;) {",
      "    const response = await send(config.baseUrl, request, config.timeoutMs);",
      "    if (!shouldRetry(response.status, attempt, policy)) return response;",
      "    void nextDelayMs(attempt, policy);",
      "    attempt += 1;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await writeSource(
    cwd,
    "src/client.ts",
    [
      'import { resolveConfig, type FluxConfig } from "./config.js";',
      'import { BearerAuth } from "./auth.js";',
      'import type { AuthStrategy, RequestOptions, FluxResponse } from "./types.js";',
      'import { sendWithRetry } from "./retryingTransport.js";',
      'import { RequestError } from "./errors.js";',
      "",
      "/**",
      " * The Flux HTTP client. Applies authentication and delegates sending, and",
      " * now retrying, to the retrying transport. The client no longer owns the",
      " * retry loop.",
      " */",
      "export class HttpClient {",
      "  constructor(",
      "    private readonly config: FluxConfig,",
      "    private readonly auth: AuthStrategy,",
      "  ) {}",
      "",
      "  /** Execute a request; the transport handles retries. */",
      "  async request(options: RequestOptions): Promise<FluxResponse> {",
      "    const headers = { ...options.headers };",
      "    this.auth.apply(headers);",
      "    const response = await sendWithRetry(this.config, { ...options, headers });",
      "    if (response.status >= 400) {",
      '      throw new RequestError(response.status, "request failed");',
      "    }",
      "    return response;",
      "  }",
      "",
      "  get(path: string): Promise<FluxResponse> {",
      '    return this.request({ method: "GET", path, headers: {} });',
      "  }",
      "}",
      "",
      "/**",
      " * Create a client from partial overrides, resolving configuration and wiring",
      " * the default Bearer authentication strategy.",
      " */",
      "export function createClient(overrides: Partial<FluxConfig> = {}): HttpClient {",
      "  const config = resolveConfig(overrides);",
      "  return new HttpClient(config, new BearerAuth(config.authToken));",
      "}",
      "",
    ].join("\n"),
  );
  await writeSource(
    cwd,
    "src/index.ts",
    baseSources()["src/index.ts"].replace(
      'export { send } from "./transport.js";',
      [
        'export { send } from "./transport.js";',
        'export { sendWithRetry } from "./retryingTransport.js";',
      ].join("\n"),
    ),
  );
}

/**
 * Remove environment-variable configuration entirely, so `resolveConfig` only
 * merges defaults and explicit overrides. Documentation that describes the
 * `FLUX_*` env vars and the override-over-environment precedence becomes
 * actively wrong and must be forgotten.
 */
async function applyRemoveEnvConfig(cwd: string): Promise<void> {
  await writeSource(
    cwd,
    "src/config.ts",
    [
      'import type { RetryPolicy } from "./types.js";',
      "",
      "export interface FluxConfig {",
      "  baseUrl: string;",
      "  maxRetries: number;",
      "  timeoutMs: number;",
      "  authToken: string;",
      "}",
      "",
      "const DEFAULTS = { maxRetries: 3, timeoutMs: 5000 };",
      "",
      "/**",
      " * Resolve the effective client configuration by merging the caller's",
      " * explicit overrides onto the built-in defaults. Configuration comes only",
      " * from the overrides passed to `createClient`.",
      " */",
      "export function resolveConfig(overrides: Partial<FluxConfig>): FluxConfig {",
      "  return {",
      '    baseUrl: "https://api.flux.dev",',
      '    authToken: "",',
      "    ...DEFAULTS,",
      "    ...overrides,",
      "  };",
      "}",
      "",
      "export function retryPolicy(config: FluxConfig): RetryPolicy {",
      "  return { maxRetries: config.maxRetries, baseDelayMs: 200 };",
      "}",
      "",
    ].join("\n"),
  );
}

/**
 * Change `shouldRetry` to also retry rate-limit (HTTP 429) responses, not only
 * 5xx. A small but genuine behavioral change, used behind the git cursor to
 * prove durability: once committed and the cursor advanced, only a recorded
 * sidecar can still tell the agent that `retries.md` is stale.
 */
async function applyRetryOn429(cwd: string): Promise<void> {
  await writeSource(
    cwd,
    "src/retry.ts",
    baseSources()["src/retry.ts"].replace(
      "  return attempt < policy.maxRetries && status >= 500;",
      "  return attempt < policy.maxRetries && (status >= 500 || status === 429);",
    ),
  );
}

/**
 * The scenarios. `behind-cursor` runs first because it is the cheapest smoke
 * (its WITHOUT arm skips the agent entirely), followed by the four realistic
 * in-range changes in increasing scope.
 */
export const SCENARIOS: Scenario[] = [
  {
    name: "behind-cursor",
    kind: "durability",
    description:
      "shouldRetry now also retries HTTP 429, committed with the cursor advanced past it so git diff is empty",
    sources: baseSources(),
    pages: basePages(),
    grounding: BASE_GROUNDING,
    applyChange: applyRetryOn429,
    expected: [
      {
        page: "openwiki/retries.md",
        requiredMarker: "429",
      },
    ],
    behindCursor: true,
  },
  {
    name: "auth-async",
    kind: "behavioral",
    description:
      "Auth contract flips from synchronous Bearer header (apply) to async request signing (authenticate)",
    sources: baseSources(),
    pages: basePages(),
    grounding: BASE_GROUNDING,
    applyChange: applyAuthAsync,
    expected: [
      {
        page: "openwiki/authentication.md",
        staleMarker: "`Authorization: Bearer <token>`",
      },
      { page: "openwiki/client.md", staleMarker: "AuthStrategy.apply" },
      { page: "openwiki/architecture.md", staleMarker: "synchronously via `apply`" },
    ],
  },
  {
    name: "add-middleware",
    kind: "feature-add",
    description:
      "Add a request/response middleware layer spanning types, config, client, a new module, barrel, and a test",
    sources: baseSources(),
    pages: basePages(),
    grounding: BASE_GROUNDING,
    applyChange: applyAddMiddleware,
    expected: [
      { page: "openwiki/architecture.md", requiredMarker: "middleware" },
      { page: "openwiki/client.md", requiredMarker: "middleware" },
      { page: "openwiki/configuration.md", requiredMarker: "middleware" },
    ],
  },
  {
    name: "move-retries",
    kind: "refactor",
    description:
      "Move the retry responsibility from HttpClient into a dedicated retrying-transport module",
    sources: baseSources(),
    pages: basePages(),
    grounding: BASE_GROUNDING,
    applyChange: applyMoveRetries,
    expected: [
      {
        page: "openwiki/architecture.md",
        staleMarker: "owns the request lifecycle and the retry loop",
      },
      {
        page: "openwiki/retries.md",
        staleMarker: "not by the transport",
      },
      {
        page: "openwiki/client.md",
        staleMarker: "Retries 5xx responses using the retry policy",
      },
    ],
  },
  {
    name: "remove-env-config",
    kind: "feature-remove",
    description:
      "Remove FLUX_* environment-variable configuration; docs describing env precedence become wrong",
    sources: baseSources(),
    pages: basePages(),
    grounding: BASE_GROUNDING,
    applyChange: applyRemoveEnvConfig,
    expected: [
      {
        page: "openwiki/configuration.md",
        staleMarker: "Environment variables: `FLUX_BASE_URL`",
      },
      {
        page: "openwiki/quickstart.md",
        staleMarker: "can also come from `FLUX_*` environment variables",
      },
    ],
  },
];

/**
 * Read every wiki page (`*.md`, excluding the temporary plan file) under the
 * repo's `openwiki/` directory into a path -> bytes map.
 */
async function snapshotWiki(cwd: string): Promise<Map<string, string>> {
  const root = path.join(cwd, OPEN_WIKI_DIR);
  const snapshot = new Map<string, string>();

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "_plan.md") {
        continue;
      }
      const relative = path.relative(cwd, absolute).split(path.sep).join("/");
      snapshot.set(relative, await readFile(absolute, "utf8"));
    }
  }

  await walk(root);
  return snapshot;
}

/**
 * Write `openwiki/.last-update.json` so the update gate treats `gitHead` as the
 * commit the wiki was last synchronized against. Static serialization of a
 * literal object; the head is a git-produced hash, never untrusted input.
 */
async function writeCursor(cwd: string, gitHead: string): Promise<void> {
  await writeFile(
    path.join(cwd, OPEN_WIKI_DIR, ".last-update.json"),
    `${JSON.stringify({
      updatedAt: "2020-01-01T00:00:00.000Z",
      command: "update",
      gitHead,
      model: "eval",
      status: "complete",
    })}\n`,
    "utf8",
  );
}

/**
 * Seed a throwaway repo with the scenario baseline, optionally recording real
 * sidecars, and commit it so a later worktree edit is what the update sees.
 */
async function seed(
  cwd: string,
  scenario: Scenario,
  withSidecars: boolean,
): Promise<void> {
  for (const [relativePath, contents] of Object.entries(scenario.sources)) {
    await writeSource(cwd, relativePath, contents);
  }
  for (const [relativePath, contents] of Object.entries(scenario.pages)) {
    await writeSource(cwd, relativePath, contents);
  }

  await git(cwd, ["init"]);
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", "baseline"]);

  if (withSidecars) {
    const reader = new FileSystemSourceReader(cwd);
    const byPage = new Map<string, Grounding[]>();
    for (const grounding of scenario.grounding) {
      const list = byPage.get(grounding.page) ?? [];
      list.push(grounding);
      byPage.set(grounding.page, list);
    }
    for (const [page, groundings] of byPage) {
      const pageBytes = scenario.pages[page];
      const { sidecar } = await recordSourceDependencies({
        page,
        pageBytes,
        requests: groundings.map((grounding) => ({
          path: grounding.path,
          symbol: grounding.symbol,
        })),
        resolver: sharedResolver,
        reader,
      });
      await writeSidecarAtomic(cwd, sidecar);
    }
    // Commit the sidecars so only the applied change is an uncommitted edit.
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "record source dependencies"]);
  }

  await writeCursor(cwd, await git(cwd, ["rev-parse", "HEAD"]));
}

/**
 * Grade one wiki snapshot against the scenario's hand-labeled expectations.
 */
function grade(
  scenario: Scenario,
  before: Map<string, string>,
  after: Map<string, string>,
  wallMs: number,
  errored: boolean,
): ArmResult {
  const expectedPages = new Set(scenario.expected.map((page) => page.page));
  const correctlyUpdated: string[] = [];
  const stillStale: string[] = [];

  for (const expected of scenario.expected) {
    const content = after.get(expected.page) ?? "";
    const staleGone =
      expected.staleMarker === undefined || !content.includes(expected.staleMarker);
    const requiredPresent =
      expected.requiredMarker === undefined ||
      content.toLowerCase().includes(expected.requiredMarker.toLowerCase());
    if (staleGone && requiredPresent) {
      correctlyUpdated.push(expected.page);
    } else {
      stillStale.push(expected.page);
    }
  }

  const unnecessary: string[] = [];
  for (const [page, content] of after) {
    if (expectedPages.has(page)) {
      continue;
    }
    // Only source-grounded pages count: generated navigation and operational
    // files (index.md, log.md, ...) are not part of freshness tracking and must
    // not distort the metric.
    if (!isSourceGroundedPage(page)) {
      continue;
    }
    const original = before.get(page);
    if (original === undefined || original !== content) {
      unnecessary.push(page);
    }
  }

  return {
    correctlyUpdated: correctlyUpdated.sort(),
    stillStale: stillStale.sort(),
    unnecessary: unnecessary.sort(),
    wallMs,
    errored,
  };
}

/**
 * Run one arm: seed, snapshot the baseline, apply the change, invoke the real
 * agent, snapshot again, and grade.
 */
async function runArm(
  scenario: Scenario,
  withSidecars: boolean,
): Promise<ArmResult> {
  return withTempGitRepo(async (cwd) => {
    await seed(cwd, scenario, withSidecars);
    const before = await snapshotWiki(cwd);
    await scenario.applyChange(cwd);

    if (scenario.behindCursor) {
      // Commit the change and advance the cursor past it, so `git diff` is empty
      // and the only remaining stale signal is the recorded sidecar.
      await git(cwd, ["add", "."]);
      await git(cwd, ["commit", "-m", "apply change"]);
      await writeCursor(cwd, await git(cwd, ["rev-parse", "HEAD"]));
    }

    const start = Date.now();
    let errored = false;
    try {
      await runOpenWikiAgent("update", cwd, { outputMode: "repository" });
    } catch (error) {
      errored = true;
      process.stderr.write(
        `agent run failed (${withSidecars ? "with" : "without"} freshness) for ${scenario.name}: ${String(error)}\n`,
      );
    }
    const wallMs = Date.now() - start;

    const after = await snapshotWiki(cwd);
    return grade(scenario, before, after, wallMs, errored);
  });
}

/**
 * Run both arms of one scenario. The WITHOUT arm runs first so a shared
 * failure surfaces before the more expensive WITH arm.
 */
export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const without = await runArm(scenario, false);
  const withFreshness = await runArm(scenario, true);
  return {
    scenario: scenario.name,
    kind: scenario.kind,
    description: scenario.description,
    expectedCount: scenario.expected.length,
    without,
    with: withFreshness,
  };
}
