import { describe, expect, test } from "vitest";
import { getRedirectUriFromNgrokTunnels } from "../../src/auth/ngrok.ts";

const PORT = 53682;

/**
 * Builds an ngrok `/api/tunnels` style payload from tunnel descriptors.
 */
function tunnels(entries: { addr?: string; public_url: string }[]): {
  tunnels: unknown[];
} {
  return {
    tunnels: entries.map(({ addr, public_url }) => ({
      config: addr === undefined ? {} : { addr },
      public_url,
    })),
  };
}

describe("getRedirectUriFromNgrokTunnels", () => {
  test("returns null when the payload is not a tunnels object", () => {
    expect(getRedirectUriFromNgrokTunnels(null, PORT)).toBeNull();
    expect(getRedirectUriFromNgrokTunnels({}, PORT)).toBeNull();
    expect(
      getRedirectUriFromNgrokTunnels({ tunnels: "nope" }, PORT),
    ).toBeNull();
  });

  test("builds a callback URL from the tunnel whose addr matches the port", () => {
    const payload = tunnels([
      { addr: "localhost:1111", public_url: "https://other.ngrok.app" },
      { addr: "http://localhost:53682", public_url: "https://match.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://match.ngrok.app/callback",
    );
  });

  test("matches a bare port addr and strips a trailing slash", () => {
    const payload = tunnels([
      { addr: String(PORT), public_url: "https://match.ngrok.app/" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://match.ngrok.app/callback",
    );
  });

  test("falls back to the sole https tunnel when none match the port", () => {
    const payload = tunnels([
      { addr: "localhost:9999", public_url: "https://only.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://only.ngrok.app/callback",
    );
  });

  test("returns null when several tunnels exist but none match the port", () => {
    const payload = tunnels([
      { addr: "localhost:1111", public_url: "https://a.ngrok.app" },
      { addr: "localhost:2222", public_url: "https://b.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBeNull();
  });

  test("ignores non-https tunnels", () => {
    const payload = tunnels([
      { addr: `localhost:${PORT}`, public_url: "http://insecure.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBeNull();
  });

  test("ignores tunnels whose public url carries a port, query, or credentials", () => {
    const payload = tunnels([
      { addr: `localhost:${PORT}`, public_url: "https://a.ngrok.app:8443" },
      { addr: `localhost:${PORT}`, public_url: "https://b.ngrok.app?x=1" },
      { addr: `localhost:${PORT}`, public_url: "https://user:pw@c.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBeNull();
  });
});
