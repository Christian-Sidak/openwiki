import { describe, expect, test } from "vitest";
import { EvidenceResourceError } from "../../../../src/claims/core/errors.ts";
import {
  parseRepositoryEvidenceResource,
  REPOSITORY_EVIDENCE_PREFIX,
} from "../../../../src/claims/evidence/repository/resource.ts";

describe("parseRepositoryEvidenceResource", () => {
  test("parses whole-file and symbol resources", () => {
    expect(parseRepositoryEvidenceResource("repo://src/config.ts")).toEqual({
      path: "src/config.ts",
    });
    expect(
      parseRepositoryEvidenceResource(
        "repo://src/config.ts#Config.DEFAULT_PROVIDER",
      ),
    ).toEqual({
      path: "src/config.ts",
      symbol: "Config.DEFAULT_PROVIDER",
    });
  });

  test("decodes escaped delimiters and canonicalizes separators", () => {
    expect(
      parseRepositoryEvidenceResource(
        "repo://src\\feature%23flags.ts#Feature%23enabled",
      ),
    ).toEqual({
      path: "src/feature#flags.ts",
      symbol: "Feature#enabled",
    });
  });

  test("exports the stable repository namespace", () => {
    expect(REPOSITORY_EVIDENCE_PREFIX).toBe("repo://");
  });

  test.each([
    "file://src/config.ts",
    "repo://",
    "repo://.",
    "repo://../secret.ts",
    "repo://src/../../secret.ts",
    "repo:///etc/passwd",
    "repo://C%3A%5Csecrets%5Ctoken.ts",
    "repo://.git/config",
    "repo://.GIT/config",
    "repo://openwiki/page.md",
    "repo://OpenWiki/page.md",
    "repo://src/config.ts#",
    "repo://src/config.ts#first#second",
    "repo://src/%00config.ts",
    "repo://src/config.ts#bad%0Asymbol",
    "repo://src/%E0%A4%A.ts",
  ])("rejects unsafe or malformed resource %s", (resource) => {
    expect(() => parseRepositoryEvidenceResource(resource)).toThrow(
      EvidenceResourceError,
    );
  });
});
