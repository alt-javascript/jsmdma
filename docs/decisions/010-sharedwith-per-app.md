# ADR-010: sharedWith is scoped per application

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

When a document owner shares a document with another user, the system needs to decide what scope that share covers. A user exists as a single identity across all applications registered on the instance. The question is whether sharing a document implicitly grants access to the recipient's view of all that user's data, or only to the specific application and document being shared.

The main alternatives considered were:

- **Global share by userId only** — `sharedWith` is `[userId, ...]`. Simple, but sharing a `year-planner` document with a colleague also implicitly grants them access to that owner's `todo` items in the same instance — cross-app bleed with no explicit opt-in.
- **Per-document share with docKey filter** — `sharedWith` is `[{userId, docKey}]`. Correct granularity but couples the sharing model to the document key, making it difficult to express "share all my year-planner docs with this user."
- **Per-app share with `{userId, app}` pairs** — `sharedWith` is `[{userId, app}]`. Sharing is scoped to a specific application namespace; a recipient gets access to the shared doc within that app only.

## Decision

The `sharedWith` field on `DocIndex` is an array of `{userId, app}` pairs. Each entry scopes the share to a specific application:

```json
"sharedWith": [
  { "userId": "uuid", "app": "year-planner" }
]
```

A recipient is granted access to the document in the `year-planner` namespace only. Sharing this document does not affect their ability to access any other application's documents. To share a document in a different app, a separate `{userId, app}` entry is added.

This is enforced in `listAccessibleDocs()`: when evaluating `shared` visibility, the server checks whether the requesting user's `{userId, app}` pair is present in `sharedWith`.

Source: DECISIONS.md D002; `docs/data-model.md § 7 Sharing Model, sharedWith Shape`.

## Consequences

**Positive:**
- Cross-app share bleed is impossible by construction. A user sharing a planner document can never accidentally expose their todo items to the recipient.
- The model is explicit and auditable — each `{userId, app}` entry represents a deliberate access grant.
- Per-app scoping aligns with how users think about application data: "I'm sharing this planner with Alice" does not imply "Alice can see my tasks."

**Negative:**
- Sharing the same document across multiple apps requires multiple `{userId, app}` entries — slightly more verbose than a single userId grant.
- The `sharedWith` schema is not backward-compatible with a plain userId array: migration required if upgrading from a hypothetical global-share model.

**Risks:**
- This decision is marked **non-revisable** because changing the `sharedWith` shape would require a migration of all existing `docIndex` entries.
