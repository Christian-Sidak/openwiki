import { describe, expect, test } from "vitest";

import { createDefaultRegistry } from "../../src/staleness/languages/registry.ts";
import {
  fingerprintForSymbol,
  SourceResolver,
} from "../../src/staleness/resolver.ts";

const resolver = new SourceResolver(createDefaultRegistry());

/**
 * Parse `source` and return the `tree-sitter-v1` fingerprint of the named
 * symbol's definition.
 */
async function fingerprintOf(
  path: string,
  source: string,
  symbol: string,
): Promise<string> {
  const parsed = await resolver.parseFile(path, source);
  const resolved = fingerprintForSymbol(parsed, symbol);
  if (!resolved) {
    throw new Error(`symbol ${symbol} not found`);
  }
  return resolved.fingerprint.value;
}

describe("canonical definition fingerprints", () => {
  const base = [
    "class AuthService {",
    "  authenticate(user) {",
    "    // check the user",
    "    return user.token;",
    "  }",
    "}",
  ].join("\n");

  test("whitespace and comment changes do not change the fingerprint", async () => {
    const reformatted =
      "class AuthService{authenticate( user ){\n\n  /* different */\n  return   user.token ;}}";

    expect(
      await fingerprintOf("a.ts", reformatted, "AuthService.authenticate"),
    ).toBe(await fingerprintOf("a.ts", base, "AuthService.authenticate"));
  });

  test("a changed member access changes the fingerprint", async () => {
    const semantic = base.replace("user.token", "user.session");

    expect(
      await fingerprintOf("a.ts", semantic, "AuthService.authenticate"),
    ).not.toBe(await fingerprintOf("a.ts", base, "AuthService.authenticate"));
  });

  test("a changed parameter name changes the fingerprint", async () => {
    const renamed = base
      .replace("authenticate(user)", "authenticate(account)")
      .replace("user.token", "account.token");

    expect(
      await fingerprintOf("a.ts", renamed, "AuthService.authenticate"),
    ).not.toBe(await fingerprintOf("a.ts", base, "AuthService.authenticate"));
  });

  test("fingerprints are isolated per definition", async () => {
    // Adding an unrelated method must not change authenticate's fingerprint.
    const withExtra = base.replace("}\n}", "}\n  logout() { return null; }\n}");

    expect(
      await fingerprintOf("a.ts", withExtra, "AuthService.authenticate"),
    ).toBe(await fingerprintOf("a.ts", base, "AuthService.authenticate"));
  });
});

describe("SourceResolver.parseFile capability reporting", () => {
  test("reports unsupported languages without throwing", async () => {
    const parsed = await resolver.parseFile("main.rs", "fn main() {}");
    expect(parsed.supported).toBe(false);
    expect(parsed.parsed).toBe(false);
    expect(parsed.definitions.size).toBe(0);
    // A file-bytes fingerprint is always available for coarse tracking.
    expect(parsed.fileBytes.algorithm).toBe("file-bytes-v1");
  });
});
