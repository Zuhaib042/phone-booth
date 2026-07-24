export interface DomainError<
  Code extends string = string,
  Details extends object = Readonly<Record<string, never>>,
> {
  readonly code: Code;
  readonly message: string;
  readonly details: Details;
}

export function domainError<Code extends string, Details extends object>(
  code: Code,
  message: string,
  details: Details,
): DomainError<Code, Details> {
  return { code, message, details };
}
