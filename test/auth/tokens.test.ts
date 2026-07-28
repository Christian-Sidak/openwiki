import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// tokens.ts loads/saves the OpenWiki env file at the edges; both are mocked so
// the tests drive behavior purely through process.env and never touch disk.
vi.mock("../../src/config/env.ts", () => ({
  loadOpenWikiEnv: vi.fn(() => Promise.resolve()),
  saveOpenWikiEnv: vi.fn(() => Promise.resolve()),
}));

import { saveOpenWikiEnv } from "../../src/config/env.ts";
import { getAuthProvider } from "../../src/auth/providers.ts";
import {
  getOAuthAccessToken,
  getOAuthProviderIdForAccessTokenEnvKey,
  isOAuthAccessTokenExpired,
} from "../../src/auth/tokens.ts";

const slack = getAuthProvider("slack");
const ACCESS_KEY = slack.tokenMapping.accessTokenEnvKey;
const EXPIRES_KEY = slack.tokenMapping.expiresAtEnvKey!;
const MANAGED = [ACCESS_KEY, EXPIRES_KEY];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of MANAGED) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of MANAGED) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe("getOAuthProviderIdForAccessTokenEnvKey", () => {
  test("maps a known access-token env key back to its provider", () => {
    expect(getOAuthProviderIdForAccessTokenEnvKey(ACCESS_KEY)).toBe("slack");
  });

  test("returns null for an unrecognized env key", () => {
    expect(
      getOAuthProviderIdForAccessTokenEnvKey("OPENWIKI_NOT_A_REAL_TOKEN"),
    ).toBeNull();
  });
});

describe("isOAuthAccessTokenExpired", () => {
  test("treats a missing expiry as not expired", () => {
    expect(isOAuthAccessTokenExpired("slack")).toBe(false);
  });

  test("treats an unparseable expiry as expired", () => {
    process.env[EXPIRES_KEY] = "not-a-date";
    expect(isOAuthAccessTokenExpired("slack")).toBe(true);
  });

  test("treats a comfortably future expiry as not expired", () => {
    process.env[EXPIRES_KEY] = new Date(Date.now() + 600_000).toISOString();
    expect(isOAuthAccessTokenExpired("slack")).toBe(false);
  });

  test("treats an already-past expiry as expired", () => {
    process.env[EXPIRES_KEY] = new Date(Date.now() - 1_000).toISOString();
    expect(isOAuthAccessTokenExpired("slack")).toBe(true);
  });

  test("treats an expiry inside the refresh skew window as expired", () => {
    // The refresh skew is 60s; 30s out is still considered expired.
    process.env[EXPIRES_KEY] = new Date(Date.now() + 30_000).toISOString();
    expect(isOAuthAccessTokenExpired("slack")).toBe(true);
  });
});

describe("getOAuthAccessToken", () => {
  test("returns the cached token without refreshing when it is still valid", async () => {
    process.env[ACCESS_KEY] = "cached-token";
    process.env[EXPIRES_KEY] = new Date(Date.now() + 600_000).toISOString();
    const fetchMock = vi.fn(() => {
      throw new Error("fetch should not be called for a valid cached token");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOAuthAccessToken("slack")).resolves.toBe("cached-token");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveOpenWikiEnv).not.toHaveBeenCalled();
  });
});
