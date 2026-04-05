# ADR-007: ESM bundle strategy — local asset initially, jsDelivr CDN after npm publish

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

`year-planner` is a no-bundler PWA (plain HTML/CSS/JS, no Webpack or Vite). It imports `HLC`, `merge`, `textMerge`, and `flatten` from `jsmdma-core`. The browser cannot resolve bare npm specifiers (`import ... from '@alt-javascript/jsmdma-core'`) without a bundler or import map. Options:

1. **Publish to npm and serve via jsDelivr CDN** — Clean long-term solution. The CDN URL `https://cdn.jsdelivr.net/npm/@alt-javascript/jsmdma-core@x.y.z/dist/jsmdma-core.esm.js` works as an ES module import. Requires npm publish first.

2. **Commit a built bundle as a local asset** — Unblocks year-planner development immediately, without waiting for npm publish. The bundle is a single ESM file with zero external dependencies. It is a build artifact in source control — not ideal, but temporary.

3. **Use an import map** — Maps bare specifiers to CDN URLs in the HTML. Cleaner than option 2, but still requires npm publish for the CDN URL to exist.

## Decision

Build `dist/jsmdma-core.esm.js` from `packages/core/index.js` using esbuild:

```sh
esbuild index.js --bundle --format=esm --outfile=dist/jsmdma-core.esm.js
```

**Build configuration:**
- **Tool:** esbuild v0.25.0 (devDependency in packages/core).
- **Entry point:** `packages/core/index.js` — exports HLC, merge, textMerge, flatten, unflatten, SyncClient, fieldDiff.
- **Format:** ESM (`--format=esm`).
- **Output:** `packages/core/dist/jsmdma-core.esm.js`.
- **Target bundle size:** < 30 kB. Actual output: approximately 16.9 kB (all 7 exports included, no external dependencies to tree-shake).
- **No config file** required — single esbuild command sufficient.

**Initial deployment:** The built bundle is committed to `year-planner` as a local asset at `js/vendor/jsmdma-core.esm.js`. The import in year-planner HTML is:

```html
<script type="module">
  import HLC from './js/vendor/jsmdma-core.esm.js';
  ...
</script>
```

**After npm publish:** Replace the local asset path with the jsDelivr CDN URL — a one-line change in year-planner. The committed bundle is then removed from source control.

## Consequences

**Positive:**
- Unblocks year-planner development immediately, without a dependency on npm publish or CDN availability.
- Build step is trivial: single command, no config file, reproducible output.
- Bundle is < 30 kB — negligible impact on year-planner load time.
- The substitution to CDN URL after publish is a one-line change.

**Negative:**
- A compiled bundle is a build artifact in source control. It can drift from source if the build is not re-run after core changes. This is a temporary state — the bundle is replaced by a CDN reference before public release.
- Developers must remember to rebuild the bundle and update the committed file when `packages/core` changes during the local-asset phase.

**Risks:**
- If the build is forgotten and year-planner ships with a stale bundle, it may run against an older version of the merge or HLC logic. Mitigated by adding the build step to the year-planner release checklist and, later, by switching to the CDN URL which always reflects the published version.
