/**
 * Gera `src/schema/form-definition.schema.json` a partir do `.ts`, que é a
 * fonte única da verdade. O `.json` serve consumidores externos (validadores
 * noutras linguagens, documentação, clientes terceiros).
 *
 * `--check` não escreve nada: falha se o ficheiro no disco estiver
 * dessincronizado. É o que o CI corre.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const tsPath = resolve(here, '../src/schema/form-definition.schema.ts');
const jsonPath = resolve(here, '../src/schema/form-definition.schema.json');

const source = await readFile(tsPath, 'utf8');
const start = source.indexOf('export const formDefinitionSchema =');
if (start === -1) {
  throw new Error('não encontrei `export const formDefinitionSchema` em ' + tsPath);
}
const literalStart = source.indexOf('{', start);
const literalEnd = source.lastIndexOf('} as const;');
if (literalStart === -1 || literalEnd === -1) {
  throw new Error('não consegui delimitar o literal do schema em ' + tsPath);
}
const literal = source.slice(literalStart, literalEnd + 1);
const schema = JSON.parse(literal);
const rendered = JSON.stringify(schema, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = await readFile(jsonPath, 'utf8').catch(() => '');
  if (current !== rendered) {
    console.error(
      'form-definition.schema.json está dessincronizado do .ts.\n' +
        'Corre: pnpm --filter @cvforms/form-core schema:emit',
    );
    process.exit(1);
  }
  console.log('schema JSON sincronizado.');
} else {
  await writeFile(jsonPath, rendered);
  console.log('escrito ' + jsonPath);
}
