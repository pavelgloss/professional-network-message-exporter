export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_CHALLENGE'
  | 'READ_POLICY_BLOCK'
  | 'PARSER_NO_DATA'
  | 'PARTIAL_EXPORT'
  | 'VALIDATION_FAILED'
  | 'CONFIG_INVALID';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

