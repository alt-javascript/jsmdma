# ADR-019: Non-owner DocIndex access returns 404, not 403

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

`DocIndex` entries are keyed by the document owner's `userId`. When a non-owner calls a DocIndex endpoint (GET, PATCH, share-token mint, share-token revoke) for a document they do not own, the server must decide whether to return `403 Forbidden` or `404 Not Found`.

The main alternatives considered were:

- **Return 403** — the server performs a two-phase lookup: first check whether the `docIndex` entry exists (regardless of owner), then check whether the caller is the owner. If the entry exists but the caller is not the owner, return `403`. This explicitly confirms that the document exists but the caller is not allowed to access it — an existence oracle that enables enumeration attacks.
- **Return 404** — the compound storage key `docIndex:{userId}:{app}:{docKey}` uses the requesting user's `sub` as the owner segment. A non-owner's `sub` is not in the key, so the entry is genuinely not found from the perspective of that caller. No special non-owner check is needed; the storage lookup naturally returns nothing.

## Decision

Non-owner requests to DocIndex management endpoints return `404 Not Found`. This is a consequence of the storage key design: `DocIndexRepository.get(userId, app, docKey)` constructs the key using the requesting user's `sub`. A non-owner's `sub` does not match the document owner's `sub` in the key, so the entry is genuinely not found — no phantom entry is returned.

This behaviour:
1. Avoids confirming whether a document exists for a given key (no existence oracle).
2. Prevents enumeration attacks: an attacker cannot distinguish "document does not exist" from "document exists but I am not the owner."
3. Requires no special non-owner detection code — the storage abstraction handles it naturally.

Source: DECISIONS.md D008; DocIndex key structure in `docs/data-model.md § 6 Storage Key Reference`.

## Consequences

**Positive:**
- Better security posture than `403`: a caller learns nothing about whether a document exists at a given key unless they are the owner.
- No additional code path for non-owner detection — the key-based lookup naturally returns nothing for the wrong `sub`.
- Consistent with REST conventions where `404` means "the resource was not found at this URL for this caller."

**Negative:**
- An authorised user who has been granted access to a document via `sharedWith` cannot directly manage the `DocIndex` entry (e.g. change visibility) because management endpoints key by owner `sub`. This is by design — only the owner manages the ACL entry.
- A UI that needs to distinguish "document not found" from "document found but you are not the owner" cannot do so from the HTTP status code alone.

**Risks:**
- If an explicit `403` feedback is needed for UX — for example, a share-token feature that needs to acknowledge the document exists but the token is invalid — the handler can be updated to perform a two-phase lookup for that specific endpoint only. The default remains `404` for all DocIndex management operations. See DECISIONS.md D008.
