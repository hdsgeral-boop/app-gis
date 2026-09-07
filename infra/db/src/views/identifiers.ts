/**
 * Identificadores SQL: saneamento, desambiguação e citação.
 *
 * O `name` de um campo vem de um humano e vai directo para o nome de uma
 * coluna. O JSON Schema já restringe `name` a `^[a-zA-Z_][a-zA-Z0-9_]{0,62}$` —
 * essa é a primeira linha de defesa. ISTO é a segunda, e existe porque uma só
 * linha de defesa é sempre a que falha (FORM-SPEC §5.1).
 *
 * A regra é dupla e as duas metades são precisas:
 *   1. sanear — reduzir a um conjunto de caracteres que não tem significado
 *      nenhum em SQL;
 *   2. citar — envolver em aspas duplas, duplicando as que existam.
 * Sanear sem citar deixa passar palavras reservadas. Citar sem sanear deixa
 * passar nomes que o Postgres trunca a 63 bytes e faz colidir em silêncio.
 */

/** Limite do Postgres para qualquer identificador, em bytes. */
export const MAX_IDENTIFIER_BYTES = 63;

/**
 * Reduz um texto qualquer a um identificador seguro em minúsculas.
 * Nunca devolve vazio: sem nada aproveitável, devolve o `fallback`.
 */
export function sanitizeIdentifier(raw: string, fallback = 'campo'): string {
  const semAcentos = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  const limpo = semAcentos
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  const comInicioValido = /^[0-9]/.test(limpo) ? `n_${limpo}` : limpo;
  const truncado = truncateToBytes(comInicioValido, MAX_IDENTIFIER_BYTES);
  return truncado === '' ? fallback : truncado;
}

/**
 * Cita um identificador para SQL. Depois de saneado não há aspas para escapar,
 * mas a duplicação fica na mesma: esta função também é usada em nomes que não
 * passam pelo saneamento, e uma defesa que só funciona no caminho feliz não é
 * uma defesa.
 */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** Cita um literal de texto para SQL. Usado só em UUID e nomes já validados. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Trunca respeitando bytes UTF-8, e não caracteres. */
export function truncateToBytes(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maxBytes) return value;
  let out = '';
  for (const char of value) {
    if (encoder.encode(out + char).length > maxBytes) break;
    out += char;
  }
  return out;
}

/**
 * Desambigua nomes que colidem depois de saneados ou truncados.
 *
 * A colisão é real e não é rara: `potência_contratada_kva` e
 * `potencia-contratada-kva` saneiam para o mesmo. Sem sufixo, a segunda coluna
 * apagava a primeira na vista, sem erro nenhum, e os dados de um campo
 * apareciam debaixo do nome de outro.
 */
export class IdentifierAllocator {
  private readonly usados = new Set<string>();

  constructor(reservados: readonly string[] = []) {
    for (const nome of reservados) this.usados.add(nome);
  }

  allocate(raw: string, fallback = 'campo'): string {
    const base = sanitizeIdentifier(raw, fallback);
    if (!this.usados.has(base)) {
      this.usados.add(base);
      return base;
    }
    for (let i = 2; ; i++) {
      const sufixo = `_${i}`;
      const candidato = truncateToBytes(base, MAX_IDENTIFIER_BYTES - sufixo.length) + sufixo;
      if (!this.usados.has(candidato)) {
        this.usados.add(candidato);
        return candidato;
      }
    }
  }

  has(nome: string): boolean {
    return this.usados.has(nome);
  }
}

/**
 * Nome de uma vista: `v_<projecto>_<formulario>[_<repetivel>]_v<n>`.
 *
 * O nome é o que o técnico de SIG vê na lista de camadas do QGIS, por isso é
 * legível. Se não couber nos 63 bytes, corta-se a parte do meio e acrescenta-se
 * um sufixo curto derivado do resto, para continuar único.
 */
export function viewName(parts: {
  project: string;
  form: string;
  repeatPath?: readonly string[];
  version: number | 'actual';
}): string {
  const segmentos = [
    'v',
    sanitizeIdentifier(parts.project, 'projecto'),
    sanitizeIdentifier(parts.form, 'formulario'),
    ...(parts.repeatPath ?? []).map((p) => sanitizeIdentifier(p, 'repeticao')),
    parts.version === 'actual' ? 'actual' : `v${parts.version}`,
  ];
  const completo = segmentos.join('_');
  if (new TextEncoder().encode(completo).length <= MAX_IDENTIFIER_BYTES) return completo;

  const sufixo = `_${shortHash(completo)}_${segmentos[segmentos.length - 1]}`;
  return truncateToBytes(completo, MAX_IDENTIFIER_BYTES - sufixo.length) + sufixo;
}

/**
 * Hash curto e estável, para desambiguar nomes truncados.
 *
 * Não é criptográfico e não precisa de ser: só tem de ser determinista, para
 * que republicar a mesma versão gere o mesmo nome de vista e o QGIS de quem
 * está a trabalhar não perca a camada.
 */
export function shortHash(value: string): string {
  let h = 2166136261; // FNV-1a de 32 bits
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 6);
}
