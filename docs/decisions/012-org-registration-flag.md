# ADR-012: Instance-level org registration flag

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

data-api supports organisation-scoped documents and team membership. The system needs to decide how org creation is controlled — specifically, whether any authenticated user can create an org or whether an operator can lock down self-service registration.

The main alternatives considered were:

- **Always open** — any authenticated user can call `POST /orgs`. Simple, but unsuitable for personal deployments (year-planner, private todo) where org features exist in the code but should never be exercised.
- **Per-application flag** — each application config has its own `orgs.registerable` key. Flexible but creates a confusing matrix: the same user could create orgs in `year-planner` but not in `todo`, even though orgs are a cross-application concept.
- **Instance-level flag** — a single `orgs.registerable` boolean in the top-level server config controls whether `POST /orgs` is open for the entire instance.

## Decision

The `orgs.registerable` flag is an instance-level configuration option that defaults to `false`. When `false`, `POST /orgs` returns `403 Forbidden` with the message "Organisation registration is disabled on this instance." When `true`, any authenticated user may create an org.

Config shape:

```js
{
  applications: { ... },
  orgs: {
    registerable: true  // omit or set false to disable
  }
}
```

Personal deployments omit the `orgs` block entirely (or set `registerable: false`) and the org endpoints remain locked. Multi-tenant deployments that want self-service org creation set `registerable: true`.

Source: DECISIONS.md D003; `docs/data-model.md § 2 Operating Modes, Org-Enabled Mode`.

## Consequences

**Positive:**
- A single flag clearly expresses operator intent for the whole instance. No per-application matrix to reason about.
- The default (`false`) is safe: org creation is opt-in. Deployments that do not need orgs never expose the feature.
- Operator lockdown is enforced in the HTTP handler before any database operation, so there is no way for a client to trigger org creation on a locked instance.

**Negative:**
- The flag applies to all applications equally. There is no way to permit org creation only for `year-planner` while prohibiting it for `todo` using the current model.

**Risks:**
- If a future multi-tenant requirement needs per-application org control, the instance flag can be extended with a secondary per-application check. The instance flag would remain as the master switch (a disabled instance never creates orgs regardless of per-app config). This extension is backward-compatible. See DECISIONS.md D003.
