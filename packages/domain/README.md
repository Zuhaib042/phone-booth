# Domain foundations

`@project-booth/domain` contains framework-independent primitives shared by
future domain packages.

- Entity IDs are RFC 9562 UUID strings. Parsers accept upper- or lowercase
  hexadecimal input and emit lowercase canonical values.
- Timestamps use the canonical RFC 3339 subset
  `YYYY-MM-DDTHH:mm:ss.sssZ`: UTC only, exactly three fractional digits, and a
  valid calendar instant.
- Expected validation failures use serializable `DomainError` values and
  discriminated `Result` values rather than thrown exceptions.
- `Clock` and `RandomSource` are injected ports. This package intentionally
  provides no wall-clock or global-random implementation.

The backend or another platform adapter may implement these ports. Pure game
logic receives them through explicit dependencies.
