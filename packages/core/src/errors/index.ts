/**
 * CulGate error hierarchy.
 *
 * Errors never carry credentials. `details` is for redacted, non-sensitive
 * diagnostic context only; adapters are responsible for not placing secrets,
 * authorization headers, or full payment/customer payloads in it.
 */

export interface PaymentSDKErrorOptions {
  /** Stable machine-readable CulGate error code. */
  code?: string;
  provider?: string;
  accountId?: string;
  /** Whether repeating the same call may succeed. Defaults to `false`. */
  retryable?: boolean;
  cause?: unknown;
  details?: Readonly<Record<string, unknown>>;
}

export class PaymentSDKError extends Error {
  override name = 'PaymentSDKError';
  readonly code: string;
  readonly provider?: string;
  readonly accountId?: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(message: string, options: PaymentSDKErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code ?? 'sdk_error';
    this.retryable = options.retryable ?? false;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.accountId !== undefined) this.accountId = options.accountId;
    if (options.details !== undefined) this.details = options.details;
  }

  /** Safe, serializable view. Deliberately omits `cause` and the stack. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      provider: this.provider,
      accountId: this.accountId,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

/** Invalid or missing SDK/account configuration. */
export class ConfigurationError extends PaymentSDKError {
  override name = 'ConfigurationError';
  constructor(message: string, options: PaymentSDKErrorOptions = {}) {
    super(message, { code: 'configuration_error', ...options });
  }
}

export interface ValidationIssue {
  /** Dotted path of the offending input field, e.g. `amount.value`. */
  path: string;
  message: string;
}

/** Caller input rejected before any network call. */
export class ValidationError extends PaymentSDKError {
  override name = 'ValidationError';
  readonly issues: readonly ValidationIssue[];
  constructor(
    message: string,
    options: PaymentSDKErrorOptions & { issues?: readonly ValidationIssue[] } = {},
  ) {
    super(message, { code: 'validation_error', ...options });
    this.issues = options.issues ?? [];
  }
  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), issues: this.issues };
  }
}

/** The selected provider/account does not support the requested operation. */
export class UnsupportedOperationError extends PaymentSDKError {
  override name = 'UnsupportedOperationError';
  readonly operation: string;
  readonly reason: string;
  constructor(operation: string, reason: string, options: PaymentSDKErrorOptions = {}) {
    super(`Operation "${operation}" is not supported: ${reason}`, {
      code: 'unsupported_operation',
      ...options,
    });
    this.operation = operation;
    this.reason = reason;
  }
  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), operation: this.operation, reason: this.reason };
  }
}

export interface ProviderErrorOptions extends PaymentSDKErrorOptions {
  httpStatus?: number;
  /** Provider's own error code/type, verbatim. */
  providerCode?: string;
  /** Provider request/correlation ID, when present. */
  requestId?: string;
}

/** The provider returned an error response. */
export class ProviderError extends PaymentSDKError {
  override name = 'ProviderError';
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly requestId?: string;
  constructor(message: string, options: ProviderErrorOptions = {}) {
    super(message, { code: 'provider_error', ...options });
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options.providerCode !== undefined) this.providerCode = options.providerCode;
    if (options.requestId !== undefined) this.requestId = options.requestId;
  }
  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      httpStatus: this.httpStatus,
      providerCode: this.providerCode,
      requestId: this.requestId,
    };
  }
}

/** The provider rejected the account's credentials. */
export class AuthenticationError extends ProviderError {
  override name = 'AuthenticationError';
  constructor(message: string, options: ProviderErrorOptions = {}) {
    super(message, { code: 'authentication_error', ...options });
  }
}

export class RateLimitError extends ProviderError {
  override name = 'RateLimitError';
  /** Provider-advised wait before retrying, when documented and present. */
  readonly retryAfterMs?: number;
  constructor(message: string, options: ProviderErrorOptions & { retryAfterMs?: number } = {}) {
    super(message, { code: 'rate_limited', retryable: true, ...options });
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), retryAfterMs: this.retryAfterMs };
  }
}

export class PaymentNotFoundError extends ProviderError {
  override name = 'PaymentNotFoundError';
  constructor(message: string, options: ProviderErrorOptions = {}) {
    super(message, { code: 'payment_not_found', ...options });
  }
}

export class RefundError extends ProviderError {
  override name = 'RefundError';
  constructor(message: string, options: ProviderErrorOptions = {}) {
    super(message, { code: 'refund_error', ...options });
  }
}

/**
 * The request did not produce a provider response. For non-idempotent
 * operations the outcome is UNKNOWN: reconcile before retrying.
 */
export class NetworkError extends PaymentSDKError {
  override name = 'NetworkError';
  constructor(message: string, options: PaymentSDKErrorOptions = {}) {
    super(message, { code: 'network_error', ...options });
  }
}

export class TimeoutError extends NetworkError {
  override name = 'TimeoutError';
  constructor(message: string, options: PaymentSDKErrorOptions = {}) {
    super(message, { code: 'timeout', ...options });
  }
}

export class WebhookVerificationError extends PaymentSDKError {
  override name = 'WebhookVerificationError';
  constructor(message: string, options: PaymentSDKErrorOptions = {}) {
    super(message, { code: 'webhook_verification_failed', ...options });
  }
}
