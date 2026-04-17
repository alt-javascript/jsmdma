/**
 * SchemaValidator.js — JSON Schema validation as a CDI cross-cutting concern.
 *
 * Reads JSON Schemas from the 'applications' config block (same property
 * injected into ApplicationRegistry).  For each application and collection,
 * a schema may be specified as:
 *
 *   applications:
 *     todo:
 *       collections:
 *         tasks:
 *           schemaPath: "./schemas/task.json"   ← loaded from disk at init
 *         notes:
 *           schema:                             ← inline JSON Schema block
 *             type: object
 *             required: [title]
 *             properties:
 *               title: { type: string }
 *
 * Priority: schemaPath > schema (when both present, schemaPath wins).
 * No schema configured for a given app+collection → validation always passes.
 *
 * Schema loading is lazy (on first validate call for a given key).  Disk reads
 * use synchronous fs.readFileSync so that SchemaValidator has no async
 * lifecycle dependency.
 *
 * CDI property injection:
 *   { name: 'applications', path: 'applications' }
 *
 * Public API:
 *   validate(application, collection, doc)
 *     → { valid: boolean, errors: Array<{ field: string, message: string }> }
 */
import Ajv from 'ajv';
import { readFileSync } from 'fs';
import { resolve } from 'path';

export default class SchemaValidator {
  constructor() {
    this.applications = null; // CDI property-injected
    this._ajv    = new Ajv({ allErrors: true, allowUnionTypes: true });
    this._cache  = new Map(); // "app:collection" → compiled ajv validate fn | false
  }

  /**
   * Look up and compile (or return cached) the ajv validate function for an
   * application+collection pair.  Returns false when no schema is configured.
   *
   * @param {string} application
   * @param {string} collection
   * @returns {Function|false}
   */
  _getValidator(application, collection) {
    const cacheKey = `${application}::${collection}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);

    const appConfig = this.applications?.[application];
    if (!appConfig) {
      this._cache.set(cacheKey, false);
      return false;
    }

    const colConfig = appConfig.collections?.[collection];
    if (!colConfig) {
      this._cache.set(cacheKey, false);
      return false;
    }

    let schema = null;

    if (colConfig.schemaPath) {
      // schemaPath wins over inline schema
      try {
        const absPath = resolve(colConfig.schemaPath);
        const raw     = readFileSync(absPath, 'utf-8');
        schema = JSON.parse(raw);
      } catch (err) {
        throw new Error(`SchemaValidator: failed to load schema from "${colConfig.schemaPath}": ${err.message}`);
      }
    } else if (colConfig.schema) {
      schema = colConfig.schema;
    }

    if (!schema) {
      this._cache.set(cacheKey, false);
      return false;
    }

    const validateFn = this._ajv.compile(schema);
    this._cache.set(cacheKey, validateFn);
    return validateFn;
  }

  /**
   * Validate a document against the configured schema for the given
   * application and collection.
   *
   * @param {string} application
   * @param {string} collection
   * @param {Object} doc
   * @returns {{ valid: boolean, errors: Array<{ field: string, message: string }> }}
   */
  validate(application, collection, doc) {
    const validateFn = this._getValidator(application, collection);

    if (!validateFn) {
      // No schema configured — pass through
      return { valid: true, errors: [] };
    }

    const valid = validateFn(doc);

    if (valid) return { valid: true, errors: [] };

    const errors = (validateFn.errors ?? []).map((err) => {
      // instancePath is '' for root-level errors; use 'field' of the schemaPath keyword
      const rawPath  = err.instancePath || err.params?.missingProperty || '';
      const field    = rawPath.replace(/^\//, '') || '(root)';
      const message  = err.message ?? 'validation error';
      return { field, message };
    });

    return { valid: false, errors };
  }
}
