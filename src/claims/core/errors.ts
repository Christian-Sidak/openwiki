/**
 * Base error for deterministic Grounded Claims failures.
 */
export class ClaimsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimsError";
  }
}

/**
 * Reports invalid or unsafe claim persistence state.
 */
export class ClaimsPersistenceError extends ClaimsError {
  constructor(message: string) {
    super(message);
    this.name = "ClaimsPersistenceError";
  }
}

/**
 * Reports a malformed or unsafe evidence resource.
 */
export class EvidenceResourceError extends ClaimsError {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceResourceError";
  }
}

/**
 * Reports an operational failure while resolving otherwise valid evidence.
 */
export class EvidenceResolutionError extends ClaimsError {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceResolutionError";
  }
}

/**
 * Reports an invalid claim mutation or authoring-order violation.
 */
export class ClaimSessionError extends ClaimsError {
  constructor(message: string) {
    super(message);
    this.name = "ClaimSessionError";
  }
}
