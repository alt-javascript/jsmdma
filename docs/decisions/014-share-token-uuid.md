# ADR-014: Share token is a UUID (JWT as future direction)

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

data-api supports direct-link document sharing: the document owner mints a token and distributes it. Anyone with the token can access the document without being in `sharedWith`. The system needs to decide the token format.

The main alternatives considered were:

- **UUID token stored in docIndex** — a random UUID is minted on request, stored as `docIndex.shareToken`, and returned to the caller. Simple and opaque. Requires a database lookup on every token-gated access to verify the token is valid and retrieve the document coordinates.
- **Deterministic JWT** — `sign({ docKey, app, userId }, instanceSecret)`. No storage required: the token contains all the information needed to locate and authorise the document. Stable for the document lifetime. Can be verified without a database lookup.
- **Opaque random token with a separate lookup table** — similar to UUID but stored in a dedicated `shareTokens` collection rather than inline on `DocIndex`. Adds an extra collection with no benefit at current scale.

## Decision

Implement UUID share tokens for the current milestone. The token is a `crypto.randomUUID()` value stored as `docIndex.shareToken`. `null` means share-token access is not enabled. The token is minted by `POST /:application/docs/:docKey/share-token` and returned to the caller. Token access is validated by looking up the `docIndex` entry and comparing `shareToken` values.

The deterministic JWT approach is the documented preferred future direction:

```js
sign({ docKey, app, userId }, instanceSecret)
```

This JWT would require no storage, remain stable for the document lifetime, and allow token verification without a database lookup.

Source: DECISIONS.md D004; `docs/data-model.md § 7 Sharing Model, Share Token`.

## Consequences

**Positive:**
- UUID tokens are simple to implement, test, and reason about. No cryptographic dependencies required for minting.
- Revocation is straightforward: set `docIndex.shareToken = null`. The token immediately stops working because the stored value no longer matches.
- The upgrade path to deterministic JWT is a well-defined one-way migration: mint new JWTs, update `shareToken` fields or remove them, update the validation handler.

**Negative:**
- Every token-gated access requires a `docIndex` lookup to validate the token. With a remote NoSQL store, this adds a round-trip on every share-token request.
- UUID tokens cannot be verified offline or independently of the database.

**Risks:**
- UUID token storage means revocation is stateful — if the `docIndex` entry is corrupted or missing, the token cannot be verified. The deterministic JWT upgrade eliminates this dependency. See DECISIONS.md D004.
