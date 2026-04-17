import { assert } from 'chai';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import SchemaValidator from '../../jsmdma-server/SchemaValidator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_SCHEMAS_DIR = resolve(__dirname, '../schemas');
const SERVER_SCHEMAS_DIR = resolve(__dirname, '../../jsmdma-server/schemas');

const PLANNER_SCHEMA_PATH = resolve(EXAMPLE_SCHEMAS_DIR, 'planner.json');
const APP_PREFERENCES_SCHEMA_PATH = resolve(EXAMPLE_SCHEMAS_DIR, 'planner-preferences.json');
const GENERIC_PREFERENCES_SCHEMA_PATH = resolve(SERVER_SCHEMAS_DIR, 'preferences.json');

function makeValidator(applications) {
  const validator = new SchemaValidator();
  validator.applications = applications;
  return validator;
}

function makeYearPlannerValidator(overrides = {}) {
  return makeValidator({
    'year-planner': {
      collections: {
        planners: {
          schemaPath: PLANNER_SCHEMA_PATH,
        },
        preferences: {
          schemaPath: GENERIC_PREFERENCES_SCHEMA_PATH,
        },
        'planner-preferences': {
          schemaPath: APP_PREFERENCES_SCHEMA_PATH,
        },
        ...overrides,
      },
    },
  });
}

describe('Schema ownership contracts (example package)', () => {
  describe('planner schema is app-owned', () => {
    it('validates minimal planner against packages/example/schemas/planner.json', () => {
      const validator = makeYearPlannerValidator();
      const result = validator.validate('year-planner', 'planners', {
        meta: { name: 'My Planner', year: 2026 },
      });

      assert.isTrue(result.valid, `Expected valid planner; got ${JSON.stringify(result.errors)}`);
      assert.isEmpty(result.errors);
    });

    it('rejects planner missing required meta.name', () => {
      const validator = makeYearPlannerValidator();
      const result = validator.validate('year-planner', 'planners', {
        meta: { year: 2026 },
      });

      assert.isFalse(result.valid);
      assert.isAtLeast(result.errors.length, 1);
      const fields = result.errors.map((e) => e.field);
      assert.isTrue(
        fields.includes('name') || fields.includes('meta'),
        `Expected missing-name field context; got ${JSON.stringify(result.errors)}`,
      );
    });
  });

  describe('dual preferences ownership boundary', () => {
    it('keeps generic preferences permissive (empty object is valid)', () => {
      const validator = makeYearPlannerValidator();
      const result = validator.validate('year-planner', 'preferences', {});

      assert.isTrue(result.valid, `Expected generic preferences to accept {}; got ${JSON.stringify(result.errors)}`);
      assert.isEmpty(result.errors);
    });

    it('keeps generic preferences permissive (opaque nested payload remains valid)', () => {
      const validator = makeYearPlannerValidator();
      const result = validator.validate('year-planner', 'preferences', {
        widgetState: {
          filters: {
            calendar: ['work', 'personal'],
            score: 999999999,
          },
        },
        arbitraryFlag: true,
        maxBlob: 'x'.repeat(5000),
      });

      assert.isTrue(result.valid, `Expected generic preferences to be permissive; got ${JSON.stringify(result.errors)}`);
      assert.isEmpty(result.errors);
    });

    it('accepts the minimal valid app-specific planner-preferences document', () => {
      const validator = makeYearPlannerValidator();
      const result = validator.validate('year-planner', 'planner-preferences', {
        defaultView: 'year',
        weekStartsOn: 'monday',
        timezone: 'Australia/Sydney',
        showWeekNumbers: true,
      });

      assert.isTrue(result.valid, `Expected strict planner-preferences minimum payload to pass; got ${JSON.stringify(result.errors)}`);
      assert.isEmpty(result.errors);
    });

    it('rejects missing required fields in app-specific planner-preferences', () => {
      const validator = makeYearPlannerValidator();
      const result = validator.validate('year-planner', 'planner-preferences', {
        defaultView: 'year',
        weekStartsOn: 'monday',
      });

      assert.isFalse(result.valid);
      const fields = result.errors.map((e) => e.field);
      assert.include(fields, 'timezone');
      assert.include(fields, 'showWeekNumbers');
    });

    it('rejects wrong enum and wrong type values in app-specific planner-preferences', () => {
      const validator = makeYearPlannerValidator();
      const result = validator.validate('year-planner', 'planner-preferences', {
        defaultView: 'agenda',
        weekStartsOn: 'friday',
        timezone: 'Australia/Sydney',
        showWeekNumbers: 'yes',
      });

      assert.isFalse(result.valid);
      const fields = result.errors.map((e) => e.field);
      assert.include(fields, 'defaultView');
      assert.include(fields, 'weekStartsOn');
      assert.include(fields, 'showWeekNumbers');
    });

    it('rejects additional unknown properties in app-specific planner-preferences', () => {
      const validator = makeYearPlannerValidator();
      const result = validator.validate('year-planner', 'planner-preferences', {
        defaultView: 'month',
        weekStartsOn: 'sunday',
        timezone: 'UTC',
        showWeekNumbers: false,
        unexpected: 'nope',
      });

      assert.isFalse(result.valid);
      assert.isTrue(
        result.errors.some((e) => e.message.includes('additional properties')),
        `Expected additionalProperties failure; got ${JSON.stringify(result.errors)}`,
      );
    });

    it('rejects oversized constrained fields in app-specific planner-preferences', () => {
      const validator = makeYearPlannerValidator();
      const result = validator.validate('year-planner', 'planner-preferences', {
        defaultView: 'month',
        weekStartsOn: 'sunday',
        timezone: 'x'.repeat(65),
        showWeekNumbers: false,
      });

      assert.isFalse(result.valid);
      assert.include(result.errors.map((e) => e.field), 'timezone');
    });
  });

  describe('schema path failure handling', () => {
    it('throws deterministic path errors for missing schema files', () => {
      const missingPath = resolve(__dirname, '../schemas/does-not-exist.json');
      const validator = makeYearPlannerValidator({
        'planner-preferences': { schemaPath: missingPath },
      });

      assert.throws(
        () => validator.validate('year-planner', 'planner-preferences', {}),
        `SchemaValidator: failed to load schema from "${missingPath}"`,
      );
    });

    it('fails fast for malformed schema JSON files', () => {
      const malformedPath = resolve(tmpdir(), `planner-preferences-malformed-${Date.now()}.json`);
      writeFileSync(malformedPath, '{ this is not json }', 'utf8');

      const validator = makeYearPlannerValidator({
        'planner-preferences': { schemaPath: malformedPath },
      });

      assert.throws(
        () => validator.validate('year-planner', 'planner-preferences', {}),
        `SchemaValidator: failed to load schema from "${malformedPath}"`,
      );
    });
  });
});
