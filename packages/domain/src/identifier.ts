import { domainError, type DomainError } from "./error.js";
import { err, ok, type Result } from "./result.js";

declare const entityIdBrand: unique symbol;

export type EntityId<Entity extends string> = string & {
  readonly [entityIdBrand]: Entity;
};

export type UserId = EntityId<"user">;
export type MatchId = EntityId<"match">;
export type RoundId = EntityId<"round">;
export type RulesetId = EntityId<"ruleset">;

export type InvalidIdentifierError<Entity extends string = string> =
  DomainError<
    "invalid_identifier",
    {
      readonly entity: Entity;
      readonly expected: "rfc9562_uuid";
    }
  >;

export const RFC_9562_UUID_PATTERN =
  "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$";

const UUID_PATTERN = new RegExp(RFC_9562_UUID_PATTERN);

export function parseEntityId<Entity extends string>(
  entity: Entity,
  value: string,
): Result<EntityId<Entity>, InvalidIdentifierError<Entity>> {
  const normalized = value.toLowerCase();

  if (!UUID_PATTERN.test(normalized)) {
    return err(
      domainError(
        "invalid_identifier",
        `${entity} identifier must be an RFC 9562 UUID`,
        { entity, expected: "rfc9562_uuid" },
      ),
    );
  }

  return ok(normalized as EntityId<Entity>);
}
