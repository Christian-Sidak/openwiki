import { describe, expect, test } from "vitest";
import {
  ClaimsError,
  ClaimsPersistenceError,
  ClaimSessionError,
  EvidenceResolutionError,
  EvidenceResourceError,
} from "../../../src/claims/core/errors.ts";

describe("Claims errors", () => {
  test.each([
    {
      ErrorType: ClaimsPersistenceError,
      expectedName: "ClaimsPersistenceError",
    },
    { ErrorType: ClaimSessionError, expectedName: "ClaimSessionError" },
    {
      ErrorType: EvidenceResolutionError,
      expectedName: "EvidenceResolutionError",
    },
    { ErrorType: EvidenceResourceError, expectedName: "EvidenceResourceError" },
  ])(
    "$expectedName retains the ClaimsError family",
    ({ ErrorType, expectedName }) => {
      const error = new ErrorType("detail");

      expect(error).toBeInstanceOf(ClaimsError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(expectedName);
      expect(error.message).toBe("detail");
    },
  );
});
