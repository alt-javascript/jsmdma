# ADR-016: public visibility appears in search; share-token-only does not

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

jsmdma has two distinct mechanisms for making a document accessible beyond the owner:

1. **`visibility: 'public'`** — the document is visible to any authenticated user.
2. **Share token** — a UUID token that grants direct-link access to a specific document. The document's visibility may be `private` or `shared`, not `public`.

The system needs to decide which of these mechanisms causes a document to appear in open search results (`POST /:application/search`).

The main alternatives considered were:

- **Both public and share-token documents appear in search** — any document with a non-null `shareToken` is discoverable. This would mean minting a share token implicitly opts the document into public discoverability — contrary to the expectation that "share with link" is a targeted share, not a broadcast.
- **Neither appears by default; a separate flag controls search visibility** — adds a third visibility axis and requires callers to set two flags. Increases API surface area with no identified use case that requires the separation.
- **`public` appears; share-token-only does not** — search is a discovery mechanism. `visibility: 'public'` is an explicit opt-in to discoverability. A share token is for direct-link sharing ("anyone with the link") — implicitly private unless the owner also sets `visibility: 'public'`.

## Decision

Documents with `visibility: 'public'` appear in `POST /:application/search` results for any authenticated user. Documents that are accessible only via a share token (where `visibility` is not `'public'`) do **not** appear in search results.

The ACL gate in `SearchService` uses `listAccessibleDocs()`, which includes `public` documents in the accessible set regardless of share token presence. Share-token-only entries are not added to the accessible set for search purposes — they are only accessible via the share-token endpoint.

Source: DECISIONS.md D013; `docs/data-model.md § 7 Sharing Model, Visibility Levels`.

## Consequences

**Positive:**
- The sharing model is unambiguous: `visibility: 'public'` means discoverable; everything else means not discoverable unless explicitly shared.
- Users who mint a share token for a private document have a clear mental model — the link is targeted, not a public broadcast.
- The search ACL gate is simple: check `listAccessibleDocs()` — no special share-token logic required in the search path.

**Negative:**
- A document accessible via share token is not findable via search. Users who want both share-token access and search discoverability must set `visibility: 'public'`.

**Risks:**
- This decision is marked **non-revisable**: conflating share-token access with search discoverability would be a breaking change to the sharing model semantics and could violate users' privacy expectations for documents they chose to share only via direct link. See DECISIONS.md D013.
