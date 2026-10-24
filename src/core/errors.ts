export type PicklistErrorKind =
  'config' | 'network' | 'timeout' | 'http' | 'parse' | 'shape' | 'aborted';

/** An error whose message is written for the person using the form and is safe to display. */
export class PicklistError extends Error {
  readonly kind: PicklistErrorKind;
  readonly status: number | undefined;

  constructor(kind: PicklistErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'PicklistError';
    this.kind = kind;
    this.status = status;
  }
}

export function toUserMessage(error: unknown): string {
  return error instanceof PicklistError
    ? error.message
    : 'Something went wrong while loading the list.';
}
