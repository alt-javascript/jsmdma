import { assert } from 'chai';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_PATH = resolve(__dirname, '../run.js');

describe('run.js canonical starter source contract (packages/example-auth)', () => {
  it('uses jsmdmaHonoStarter auth-only composition and forbids manual assembly imports', async () => {
    const source = await readFile(RUN_PATH, 'utf8');

    assert.match(
      source,
      /import\s*\{\s*jsmdmaHonoStarter\s*\}\s*from\s*['"]@alt-javascript\/jsmdma-hono['"];/,
    );

    assert.match(
      source,
      /\.\.\.jsmdmaHonoStarter\(\{[\s\S]*features:\s*\{[\s\S]*sync:\s*false,[\s\S]*appSyncController:\s*false,[\s\S]*\}[\s\S]*\}\)\s*,/,
    );

    assert.notMatch(source, /from\s+['"]@alt-javascript\/boot-hono['"]/);
    assert.notMatch(source, /from\s+['"]@alt-javascript\/boot-jsnosqlc['"]/);
    assert.notMatch(source, /from\s+['"]@alt-javascript\/boot-oauth-jsnosqlc['"]/);
    assert.notMatch(source, /from\s+['"]@alt-javascript\/jsmdma-auth-hono['"]/);

    assert.notMatch(source, /\.\.\.honoStarter\(/);
    assert.notMatch(source, /\.\.\.jsnosqlcAutoConfiguration\(/);
    assert.notMatch(source, /\.\.\.oauthJsnosqlcStarter\(/);
    assert.notMatch(source, /\.\.\.authHonoStarter\(/);
  });
});
