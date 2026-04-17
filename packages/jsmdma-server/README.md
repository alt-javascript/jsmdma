# @alt-javascript/jsmdma-server

[![Language](https://img.shields.io/badge/language-JavaScript-yellow.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![npm version](https://img.shields.io/npm/v/%40alt-javascript%2Fjsmdma-server)](https://www.npmjs.com/package/@alt-javascript/jsmdma-server)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Server-side sync service and repository for jsmdma. CDI-managed, framework-agnostic — wire it into any boot-hono application or consume the service layer directly.

**Part of the [@alt-javascript/jsmdma](https://github.com/alt-javascript/jsmdma) monorepo.**

## Install

```bash
npm install @alt-javascript/jsmdma-server
```

## Exports

| Class | Role |
|---|---|
| `SyncRepository` | Low-level NoSQL read/write for sync documents. |
| `SyncService` | Orchestrates field-level merge, conflict resolution, and ACL fan-out. |
| `ApplicationRegistry` | Validates incoming application names against config. Returns 404 for unknown apps. |
| `SchemaValidator` | Per-collection JSON Schema validation via ajv. |
| `DocumentIndexRepository` | Stores per-document visibility and sharing metadata (DocIndex). |
| `SearchService` | Filter-AST search across personal and ACL-accessible documents. |
| `ExportService` | Bulk export of personal or org-scoped data in JSON and CSV. |
| `DeletionService` | Hard-delete protocol: tombstoning, purge, account and org deletion. |
| `namespaceKey(userId, app, collection)` | Produces the storage key `{userId}:{app}:{collection}` with percent-encoding. |

## CDI Assembly

```js
import {
  SyncRepository, SyncService,
  ApplicationRegistry, SchemaValidator,
} from '@alt-javascript/jsmdma-server';

const context = new Context([
  ...honoStarter(),
  ...jsnosqlcAutoConfiguration(),
  { Reference: SyncRepository,      name: 'syncRepository',      scope: 'singleton' },
  { Reference: SyncService,         name: 'syncService',         scope: 'singleton' },
  { Reference: ApplicationRegistry, name: 'applicationRegistry', scope: 'singleton',
    properties: [{ name: 'applications', path: 'applications' }] },
  { Reference: SchemaValidator,     name: 'schemaValidator',     scope: 'singleton',
    properties: [{ name: 'applications', path: 'applications' }] },
]);
```

## Further Reading

- [Data Model](../../docs/data-model.md)
- [Sync Protocol Reference](../../docs/sync-protocol.md)
- [Search](../../docs/search.md)
- [Export](../../docs/export.md)
- [Deletion](../../docs/deletion.md)

## License

MIT
