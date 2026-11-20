/**
 * Errors. Every error the API answers with has a stable `code`, a `requestId` to quote to support, and a `docsUrl`
 * that points at the code's entry in the docs. The subclasses group them by what you would do about them.
 */

export interface ErrorBody {
  error?: string;
  code?: string;
  request_id?: string;
  docs_url?: string;
  retry_after_ms?: number;
  [key: string]: unknown;
}

export class FibreError extends Error {
  /** The HTTP status of the answer, or 0 when no answer came. */
  readonly status: number;
  /** A stable name for the error, safe to match on. */
  readonly code: string;
  readonly requestId: string | undefined;
  readonly docsUrl: string | undefined;
  /** The whole error answer, including fields some errors add (`details`, `limit`, …). */
  readonly body: ErrorBody;

  constructor(message: string, o: { status?: number; code?: string; body?: ErrorBody } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = o.status ?? 0;
    this.code = o.code ?? o.body?.code ?? "unknown";
    this.body = o.body ?? {};
    this.requestId = this.body.request_id;
    this.docsUrl = this.body.docs_url;
  }
}

/** The request was malformed or failed validation (400). `body.details` says which fields. */
export class ValidationError extends FibreError {}
/** No API key, or one that is not valid (401). */
export class AuthenticationError extends FibreError {}
/** The account's plan or balance does not allow this (402). */
export class PaymentRequiredError extends FibreError {}
/** The key may not do this (403). */
export class PermissionDeniedError extends FibreError {}
/** No such sandbox, command, file or template (404). */
export class NotFoundError extends FibreError {}
/** The request conflicts with the current state (409), e.g. a need the chosen runtime cannot meet. */
export class ConflictError extends FibreError {}
/** Too many requests, or a limit of the plan reached (429). `retryAfter` is in seconds when the API says. */
export class RateLimitError extends FibreError {
  readonly retryAfter: number | undefined;
  constructor(message: string, o: { status?: number; code?: string; body?: ErrorBody } = {}) {
    super(message, o);
    this.retryAfter = typeof this.body.retry_after_ms === "number" ? this.body.retry_after_ms / 1000 : undefined;
  }
}
/** The platform could not do it right now (5xx), e.g. no capacity to start a sandbox. Retrying later may work. */
export class ServerError extends FibreError {}
/** The API could not be reached. */
export class ConnectionError extends FibreError {}
/** A request, or a command run with a timeout, took longer than allowed. */
export class TimeoutError extends FibreError {}

const BY_STATUS: Record<number, typeof FibreError> = {
  400: ValidationError,
  401: AuthenticationError,
  402: PaymentRequiredError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  429: RateLimitError,
};

/** The error for an API answer with an error status. */
export function errorFromAnswer(status: number, body: ErrorBody): FibreError {
  const Kind = BY_STATUS[status] ?? (status >= 500 ? ServerError : FibreError);
  // some errors carry the cause behind a general `error` in `message`
  const detail = typeof body.message === "string" && body.message !== body.error ? body.message : undefined;
  const text = body.error ?? `request failed with status ${status}`;
  return new Kind(detail ? `${text}: ${detail}` : text, { status, body });
}
