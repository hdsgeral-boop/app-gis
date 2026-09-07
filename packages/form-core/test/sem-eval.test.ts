import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Restrição inegociável 7 (ESPECIFICACAO.md §8): nada de `eval` na avaliação de
 * expressões. Este teste é o guarda automático — falha assim que alguém tentar
 * o atalho, em qualquer ficheiro do pacote.
 */
function ficheirosFonte(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return ficheirosFonte(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('restrição inegociável: sem eval', () => {
  const proibidos = [/\beval\s*\(/, /new\s+Function\s*\(/, /\bFunction\s*\(\s*['"`]/];

  it('nenhum ficheiro de src usa eval ou Function()', () => {
    const infractores: string[] = [];
    for (const file of ficheirosFonte(fileURLToPath(new URL('../src', import.meta.url)))) {
      const source = readFileSync(file, 'utf8');
      if (proibidos.some((p) => p.test(source))) infractores.push(file);
    }
    expect(infractores).toEqual([]);
  });
});
