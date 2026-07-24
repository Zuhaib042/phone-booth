# Configuration schemas

`@project-booth/config` owns versioned, framework-independent configuration
schemas.

Ruleset schema version 1 contains:

- roster and readiness limits;
- phase durations and their ordering relationships;
- communication limits;
- symbolic economy references;
- immutable competitive-spending and betrayal rules.

Economy references are namespaced keys such as
`economy.match_outflow_cap.standard`. Actual coin quantities are resolved by a
separate versioned economy configuration after economy design. No launch coin
amount belongs in a ruleset document or fixture.
