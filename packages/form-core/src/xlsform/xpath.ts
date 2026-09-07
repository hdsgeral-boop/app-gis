import type { Expression, ExpressionArg } from '../types/index.js';

/**
 * Conversão entre o XPath do XLSForm e a AST do Consul Colect, nos dois sentidos.
 *
 * Um analisador escrito à mão, com precedência explícita. Não há `eval` nem
 * `new Function` em lado nenhum (restrição inegociável 7) — e é essa a razão
 * de existir este ficheiro em vez de três linhas de tradução para JavaScript.
 *
 * A conversão TEM PERDAS, e é assumido: `indexed-repeat`, `pulldata`,
 * `instance()`, a aritmética de datas e as funções de agregação que o formato
 * não tem não convertem. Nesses casos falha com a expressão exacta em vez de a
 * descartar em silêncio — descartar em silêncio seria publicar um formulário
 * que valida menos do que o autor julga.
 */

export interface XPathContext {
  /**
   * Resolve `${nome}` no `id` do campo e no `id` do repetível que o contém.
   * O importador dá esta função porque só ele conhece a árvore já construída.
   */
  resolve(name: string): { id: string; repeatId?: string } | undefined;
  /** `id` do repetível que contém este campo, se algum. */
  repeatOf(id: string): string | undefined;
  /** O `id` é de um campo do tipo `repeat`? */
  isRepeat(id: string): boolean;
}

export interface XPathConversionError {
  expression: string;
  reason: string;
  /** Posição, em caracteres, dentro da expressão. */
  position: number;
}

export type XPathResult =
  { ok: true; ast: Expression } | { ok: false; error: XPathConversionError };

// ─────────────────────────────────────────────────────────────────────────────
// Análise léxica
// ─────────────────────────────────────────────────────────────────────────────

type TokenType = 'number' | 'string' | 'ref' | 'name' | 'op' | 'punct' | 'dot' | 'end';

interface Token {
  type: TokenType;
  value: string;
  position: number;
}

const OPERATOR_WORDS = new Set(['and', 'or', 'div', 'mod']);

class LexError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
  }
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const char = input[i]!;

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    if (char === '$' && input[i + 1] === '{') {
      const end = input.indexOf('}', i + 2);
      if (end === -1) throw new LexError('referência ${...} não fechada', i);
      tokens.push({ type: 'ref', value: input.slice(i + 2, end), position: i });
      i = end + 1;
      continue;
    }

    if (char === "'" || char === '"') {
      const end = input.indexOf(char, i + 1);
      if (end === -1) throw new LexError('texto não fechado', i);
      tokens.push({ type: 'string', value: input.slice(i + 1, end), position: i });
      i = end + 1;
      continue;
    }

    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(input[i + 1] ?? ''))) {
      const match = /^[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?/.exec(input.slice(i));
      if (!match) throw new LexError('número mal formado', i);
      tokens.push({ type: 'number', value: match[0], position: i });
      i += match[0].length;
      continue;
    }

    // Nomes de função podem ter hífenes e dois pontos: `starts-with`, `jr:choice-name`.
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_:.-]*/.exec(input.slice(i));
      const word = match![0];
      tokens.push({
        type: OPERATOR_WORDS.has(word) ? 'op' : 'name',
        value: word,
        position: i,
      });
      i += word.length;
      continue;
    }

    const twoChar = input.slice(i, i + 2);
    if (twoChar === '!=' || twoChar === '<=' || twoChar === '>=') {
      tokens.push({ type: 'op', value: twoChar, position: i });
      i += 2;
      continue;
    }

    if ('=<>+-*'.includes(char)) {
      tokens.push({ type: 'op', value: char, position: i });
      i++;
      continue;
    }

    if ('(),'.includes(char)) {
      tokens.push({ type: 'punct', value: char, position: i });
      i++;
      continue;
    }

    if (char === '.') {
      tokens.push({ type: 'dot', value: '.', position: i });
      i++;
      continue;
    }

    throw new LexError(`carácter inesperado "${char}"`, i);
  }

  tokens.push({ type: 'end', value: '', position: input.length });
  return tokens;
}

// ─────────────────────────────────────────────────────────────────────────────
// Análise sintáctica
// ─────────────────────────────────────────────────────────────────────────────

/** Funções do XLSForm com correspondência directa. */
const DIRECT_FUNCTIONS: Record<string, { op: string; arity: [number, number] }> = {
  selected: { op: 'selected', arity: [2, 2] },
  'count-selected': { op: 'count_selected', arity: [1, 1] },
  count: { op: 'count', arity: [1, 1] },
  if: { op: 'if', arity: [3, 3] },
  not: { op: 'not', arity: [1, 1] },
  regex: { op: 'matches', arity: [2, 2] },
  'string-length': { op: 'length', arity: [1, 1] },
  concat: { op: 'concat', arity: [2, 64] },
  'starts-with': { op: 'starts_with', arity: [2, 2] },
  'ends-with': { op: 'ends_with', arity: [2, 2] },
  contains: { op: 'contains', arity: [2, 2] },
  today: { op: 'today', arity: [0, 0] },
  now: { op: 'now', arity: [0, 0] },
  round: { op: 'round', arity: [1, 2] },
  coalesce: { op: 'coalesce', arity: [2, 64] },
  upper: { op: 'upper', arity: [1, 1] },
  'upper-case': { op: 'upper', arity: [1, 1] },
  lower: { op: 'lower', arity: [1, 1] },
  'lower-case': { op: 'lower', arity: [1, 1] },
  normalize_space: { op: 'trim', arity: [1, 1] },
  'normalize-space': { op: 'trim', arity: [1, 1] },
};

/** Funções conhecidas que NÃO convertem. A mensagem diz porquê. */
const UNSUPPORTED_FUNCTIONS: Record<string, string> = {
  'indexed-repeat': 'não há forma de indexar uma instância concreta de um repetível na AST',
  pulldata: 'depende de ficheiros CSV externos, que o formato trata pelo manifesto',
  instance: 'instâncias externas não existem no formato',
  'jr:choice-name': 'o rótulo de uma opção resolve-se na app, não numa expressão',
  'decimal-date-time': 'aritmética de datas em fracções de dia não existe no formato',
  'format-date': 'formatação de datas é apresentação, não expressão',
  date: 'conversão explícita de datas não existe: as datas são texto ISO',
  int: 'truncatura não existe; usa round',
  uuid: 'não é determinista e não faz sentido numa expressão gravada',
  position: 'a posição de uma instância não é acessível na AST',
  once: 'once() depende do histórico de preenchimento, que a AST não tem',
  'boolean-from-string': 'não existe conversão explícita para booleano',
  min: 'não existe operador de mínimo na versão 1 do formato',
  max: 'não existe operador de máximo na versão 1 do formato',
  'selected-at': 'não existe acesso por índice a uma escolha múltipla',
};

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly context: XPathContext,
  ) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expect(value: string): Token {
    const token = this.next();
    if (token.value !== value) {
      throw new LexError(
        `esperava "${value}" e encontrei "${token.value || 'fim'}"`,
        token.position,
      );
    }
    return token;
  }

  parse(): ExpressionArg {
    const expr = this.parseOr();
    const token = this.peek();
    if (token.type !== 'end') {
      throw new LexError(`sobra "${token.value}" depois do fim da expressão`, token.position);
    }
    return expr;
  }

  private parseOr(): ExpressionArg {
    let left = this.parseAnd();
    while (this.peek().value === 'or') {
      this.next();
      left = { op: 'or', args: [left, this.parseAnd()] } as Expression;
    }
    return left;
  }

  private parseAnd(): ExpressionArg {
    let left = this.parseEquality();
    while (this.peek().value === 'and') {
      this.next();
      left = { op: 'and', args: [left, this.parseEquality()] } as Expression;
    }
    return left;
  }

  private parseEquality(): ExpressionArg {
    let left = this.parseRelational();
    while (this.peek().value === '=' || this.peek().value === '!=') {
      const op = this.next().value === '=' ? '==' : '!=';
      left = { op, args: [left, this.parseRelational()] } as Expression;
    }
    return left;
  }

  private parseRelational(): ExpressionArg {
    let left = this.parseAdditive();
    while (['<', '<=', '>', '>='].includes(this.peek().value)) {
      const op = this.next().value;
      left = { op, args: [left, this.parseAdditive()] } as Expression;
    }
    return left;
  }

  private parseAdditive(): ExpressionArg {
    let left = this.parseMultiplicative();
    while (this.peek().value === '+' || this.peek().value === '-') {
      const op = this.next().value;
      left = { op, args: [left, this.parseMultiplicative()] } as Expression;
    }
    return left;
  }

  private parseMultiplicative(): ExpressionArg {
    let left = this.parseUnary();
    for (;;) {
      const value = this.peek().value;
      if (value === '*' || value === 'div') {
        const token = this.next();
        left = {
          op: token.value === 'div' ? '/' : '*',
          args: [left, this.parseUnary()],
        } as Expression;
      } else if (value === 'mod') {
        throw new LexError(
          'o operador mod não existe na versão 1 do formato',
          this.peek().position,
        );
      } else {
        return left;
      }
    }
  }

  private parseUnary(): ExpressionArg {
    if (this.peek().value === '-') {
      const token = this.next();
      const operand = this.parseUnary();
      if (typeof operand === 'number') return -operand;
      return { op: '-', args: [0, operand] } as Expression;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExpressionArg {
    const token = this.next();

    if (token.type === 'number') return Number(token.value);
    if (token.type === 'string') return token.value;
    if (token.type === 'dot') return '$self';

    if (token.type === 'ref') {
      const resolved = this.context.resolve(token.value);
      if (!resolved) {
        throw new LexError(
          `a referência \${${token.value}} não corresponde a nenhum campo`,
          token.position,
        );
      }
      return `$${resolved.id}`;
    }

    if (token.value === '(') {
      const inner = this.parseOr();
      this.expect(')');
      return inner;
    }

    if (token.type === 'name') {
      // `true()` e `false()` são funções em XPath, não literais.
      if (token.value === 'true' || token.value === 'false') {
        this.expect('(');
        this.expect(')');
        return token.value === 'true';
      }
      return this.parseFunction(token);
    }

    throw new LexError(
      `não sei o que fazer com "${token.value || 'fim de expressão'}"`,
      token.position,
    );
  }

  private parseFunction(name: Token): ExpressionArg {
    this.expect('(');
    const args: ExpressionArg[] = [];
    if (this.peek().value !== ')') {
      args.push(this.parseOr());
      while (this.peek().value === ',') {
        this.next();
        args.push(this.parseOr());
      }
    }
    this.expect(')');

    const unsupported = UNSUPPORTED_FUNCTIONS[name.value];
    if (unsupported) {
      throw new LexError(`${name.value}() não converte: ${unsupported}`, name.position);
    }

    // `sum(${leitura})` soma um campo em todas as instâncias do repetível que o
    // contém. O formato exige que o repetível seja explícito, e é o importador
    // que sabe qual é.
    if (name.value === 'sum') {
      return this.parseSum(name, args);
    }

    const direct = DIRECT_FUNCTIONS[name.value];
    if (!direct) {
      throw new LexError(
        `a função ${name.value}() não existe na versão 1 do formato`,
        name.position,
      );
    }
    if (args.length < direct.arity[0] || args.length > direct.arity[1]) {
      throw new LexError(
        `${name.value}() recebeu ${args.length} argumentos e não é uma aridade válida`,
        name.position,
      );
    }
    // `concat` com um argumento só é legal em XPath e ilegal aqui: junta-se
    // uma string vazia para o resultado ser o mesmo.
    if (direct.op === 'concat' && args.length === 1) args.push('');
    return { op: direct.op, args } as Expression;
  }

  private parseSum(name: Token, args: ExpressionArg[]): ExpressionArg {
    const first = args[0];
    if (args.length !== 1 || typeof first !== 'string' || !first.startsWith('$')) {
      throw new LexError('sum() só converte na forma sum(${campo})', name.position);
    }
    // Nesta altura o `${nome}` já foi resolvido em `$id` pelo parsePrimary.
    const id = first.slice(1);
    if (this.context.isRepeat(id)) {
      throw new LexError('sum() sobre um repetível inteiro não tem significado', name.position);
    }
    const repeatId = this.context.repeatOf(id);
    if (!repeatId) {
      throw new LexError(
        `sum() precisa que o campo somado esteja dentro de um repetível`,
        name.position,
      );
    }
    return { op: 'sum', args: [`$${repeatId}`, id] } as Expression;
  }
}

/** Converte uma expressão XPath do XLSForm na AST do formato. */
export function xpathToAst(expression: string, context: XPathContext): XPathResult {
  const trimmed = expression.trim();
  try {
    const ast = new Parser(tokenize(trimmed), context).parse();
    if (typeof ast === 'object' && ast !== null && !Array.isArray(ast)) {
      return { ok: true, ast: ast as Expression };
    }
    // Uma expressão que é só um literal ou uma referência ainda tem de ser uma
    // expressão: embrulha-se num coalesce, que preserva o valor.
    return { ok: true, ast: { op: 'coalesce', args: [ast, null] } as Expression };
  } catch (error) {
    if (error instanceof LexError) {
      return {
        ok: false,
        error: { expression: trimmed, reason: error.message, position: error.position },
      };
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentido inverso: AST → XPath
// ─────────────────────────────────────────────────────────────────────────────

export interface AstToXPathContext {
  /** Nome do campo, para escrever `${nome}`. */
  nameOf(id: string): string | undefined;
}

export interface AstToXPathResult {
  /** `undefined` quando a expressão não tem equivalente em XPath. */
  xpath?: string;
  /** O que se perdeu, em português, para o exportador comunicar. */
  losses: string[];
}

const BINARY: Record<string, string> = {
  '==': '=',
  '!=': '!=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  '+': '+',
  '-': '-',
  '*': '*',
  '/': ' div ',
  and: ' and ',
  or: ' or ',
};

const CALL: Record<string, string> = {
  selected: 'selected',
  count_selected: 'count-selected',
  count: 'count',
  if: 'if',
  not: 'not',
  matches: 'regex',
  length: 'string-length',
  concat: 'concat',
  starts_with: 'starts-with',
  ends_with: 'ends-with',
  contains: 'contains',
  today: 'today',
  now: 'now',
  round: 'round',
  coalesce: 'coalesce',
  upper: 'upper-case',
  lower: 'lower-case',
  trim: 'normalize-space',
};

export function astToXPath(node: ExpressionArg, context: AstToXPathContext): AstToXPathResult {
  const losses: string[] = [];
  const rendered = render(node, context, losses);
  return rendered === undefined ? { losses } : { xpath: rendered, losses };
}

function render(
  node: ExpressionArg,
  context: AstToXPathContext,
  losses: string[],
): string | undefined {
  if (node === null) return "''";
  if (typeof node === 'number') return String(node);
  if (typeof node === 'boolean') return node ? 'true()' : 'false()';
  if (Array.isArray(node)) {
    losses.push('uma lista literal não tem equivalente directo em XPath');
    return undefined;
  }
  if (typeof node === 'string') {
    if (node === '$self') return '.';
    if (node.startsWith('$..')) {
      const name = context.nameOf(node.slice(3));
      if (!name) return undefined;
      losses.push(
        `a referência ao âmbito pai $..${node.slice(3)} passa a \${${name}}: o XLSForm não distingue âmbitos`,
      );
      return `\${${name}}`;
    }
    if (node.startsWith('$')) {
      const name = context.nameOf(node.slice(1));
      if (!name) {
        losses.push(`a referência ${node} não corresponde a nenhum campo`);
        return undefined;
      }
      return `\${${name}}`;
    }
    return `'${node.replace(/'/g, "\\'")}'`;
  }

  const op = node.op as string;
  const args = node.args;

  if (op === 'between') {
    const [a, low, high] = args.map((arg) => render(arg, context, losses));
    if (!a || !low || !high) return undefined;
    return `(${a} >= ${low} and ${a} <= ${high})`;
  }

  if (op === 'in') {
    const target = render(args[0]!, context, losses);
    const list = args[1];
    if (!target || !Array.isArray(list)) return undefined;
    const parts = list.map((item) => `${target} = ${render(item, context, losses)}`);
    return `(${parts.join(' or ')})`;
  }

  if (op === 'is_null') {
    const a = render(args[0]!, context, losses);
    return a ? `(${a} = '')` : undefined;
  }

  if (op === 'sum') {
    // O XLSForm identifica o campo somado, não o repetível: a informação do
    // repetível está implícita na árvore e não se perde nada.
    const fieldId = args[1];
    const name = typeof fieldId === 'string' ? context.nameOf(fieldId) : undefined;
    if (!name) return undefined;
    return `sum(\${${name}})`;
  }

  if (op === 'distance_m' || op === 'date_diff_days') {
    losses.push(`${op} não tem equivalente em XLSForm e a expressão foi omitida`);
    return undefined;
  }

  const call = CALL[op];
  if (call) {
    const parts = args.map((arg) => render(arg, context, losses));
    if (parts.some((p) => p === undefined)) return undefined;
    return `${call}(${parts.join(', ')})`;
  }

  const binary = BINARY[op];
  if (binary) {
    const parts = args.map((arg) => render(arg, context, losses));
    if (parts.some((p) => p === undefined)) return undefined;
    return `(${parts.join(binary)})`;
  }

  losses.push(`o operador ${op} não tem equivalente em XLSForm`);
  return undefined;
}
