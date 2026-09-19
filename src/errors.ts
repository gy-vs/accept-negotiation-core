/**
 * Error hierarchy for the negotiation library.
 *
 * All errors thrown by this library extend {@link NegotiationError}, so
 * callers can distinguish library errors from unexpected runtime failures
 * with a single `instanceof` check.
 */
export class NegotiationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Thrown when a request header value or a candidate attribute string does
 * not conform to its grammar. `subject` identifies what was being parsed,
 * e.g. `"Accept"`, `"Accept-Language"` or `"candidates[2].mediaType"`.
 */
export class NegotiationSyntaxError extends NegotiationError {
  readonly subject: string;

  constructor(subject: string, message: string) {
    super(`invalid ${subject}: ${message}`);
    this.subject = subject;
  }
}

/** Thrown when a candidate entry is structurally invalid (not an object, missing mediaType, ...). */
export class CandidateError extends NegotiationError {}

/** Thrown when negotiation options (e.g. dimension weights) are invalid. */
export class ConfigurationError extends NegotiationError {}
