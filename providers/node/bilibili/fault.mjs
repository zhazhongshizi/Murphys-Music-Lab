// Never include upstream text, URLs, credentials or response bodies in errors.
export class ProviderFault extends Error {
  constructor(code, retryable = false, retryAfterMs) {
    super(code); this.code = code; this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}
export function fail(code, retryable = false) { throw new ProviderFault(code, retryable); }
