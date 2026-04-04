# ADR-013: Org names are unique instance-wide

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

Organisations have human-readable names (e.g. "Acme Corp"). The system needs to decide the scope of name uniqueness — per-application, per-tenant, or instance-wide — and the enforcement mechanism.

The main alternatives considered were:

- **No uniqueness constraint** — multiple orgs can share the same name. Simple, but opens the door to impersonation: a malicious user creates "Acme Corp" to confuse members into joining the wrong org.
- **Per-application uniqueness** — names are unique within each application. Reduces the namespace collision space, but "acme-corp" could exist in `year-planner` and a different entity in `todo`, creating cross-application confusion for shared users.
- **Instance-wide uniqueness via a reservation index** — org names are unique across the entire instance, enforced by an `orgNames` collection that maps `{name}` → `{orgId}`.

## Decision

Org names are unique across the entire instance. Uniqueness is enforced by an `orgNames` index collection (key: the org name string; value: `{ orgId }`). Before creating an org, `OrgRepository` checks whether the name key exists in `orgNames`. If it does, the create request is rejected. On successful creation, the name is reserved in `orgNames`. On org deletion, the `orgNames` entry is released.

The `orgNames` collection provides an O(1) lookup by name without scanning all org records.

Source: DECISIONS.md D006; `docs/data-model.md § 5 OrgNameIndex`, `§ 9 Org Deletion`.

## Consequences

**Positive:**
- Org names act as instance-wide reserved handles (analogous to GitHub org names). Users searching for "Acme Corp" always reach the same entity regardless of which application they are using.
- The `orgNames` index enables O(1) name lookups — no full-table scan of `orgs` required.
- Releasing the name on org deletion allows the name to be reclaimed, but only once the original org is fully gone.

**Negative:**
- Instance-wide uniqueness creates a global namespace. A legitimate "Acme Corp" in one country cannot coexist with another "Acme Corp" on the same instance.
- Org renaming (not currently implemented) would need to handle `orgNames` reservation atomically.

**Risks:**
- This decision is marked **non-revisable**: relaxing uniqueness later would enable handle squatting (creating a duplicate of an existing org name after it is released) and would require a migration to remove the constraint from existing data.
