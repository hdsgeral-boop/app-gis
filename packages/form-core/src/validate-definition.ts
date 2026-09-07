import {
  buildDependencyGraph,
  collectReferences,
  expressionsOf,
  findCycles,
  type ExpressionSlot,
} from './dependencies.js';
import { isExpression } from './evaluate.js';
import {
  buildIndex,
  isVisibleFrom,
  scopeChain,
  type FormIndex,
  type ScopeId,
} from './index-form.js';
import { OPERATORS, describeArity, isOperator } from './operators.js';
import { isMalformedReference } from './refs.js';
import type { Expression, ExpressionArg, Field, FormDefinition } from './types/index.js';

/**
 * Validador semântico da definição (FORM-SPEC §8).
 *
 * O JSON Schema garante a FORMA; isto garante o SENTIDO. Uma definição que
 * falhe aqui é recusada ao publicar — nunca chega a um telefone. Cada regra da
 * §8 tem um código próprio e um teste próprio.
 */

export type IssueSeverity = 'erro' | 'aviso';

export interface ValidationIssue {
  code: string;
  severity: IssueSeverity;
  /** Caminho exacto até ao sítio do problema. Sem isto ninguém corrige nada. */
  path: string;
  message: string;
}

export interface ValidateDefinitionOptions {
  /**
   * `form_id` que existem e são visíveis para quem publica. Sem esta lista, a
   * regra 6 da §8 não é verificável e é saltada — só a API a sabe responder.
   */
  knownFormIds?: readonly string[];
}

export interface DefinitionValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /** Índice já construído, para quem valida e a seguir publica não repetir. */
  index: FormIndex;
}

export function validateDefinition(
  definition: FormDefinition,
  options: ValidateDefinitionOptions = {},
): DefinitionValidationResult {
  const index = buildIndex(definition);
  const issues: ValidationIssue[] = [];
  const erro = (code: string, path: string, message: string): void => {
    issues.push({ code, severity: 'erro', path, message });
  };
  const aviso = (code: string, path: string, message: string): void => {
    issues.push({ code, severity: 'aviso', path, message });
  };

  checkDuplicateIds(definition, erro);
  checkDuplicateNames(index, erro);
  checkFieldRules(index, options, erro, aviso);
  checkSettings(index, erro);
  checkChoiceLists(definition, erro);
  checkCycles(index, erro);

  return { valid: !issues.some((i) => i.severity === 'erro'), issues, index };
}

/** Caminho legível de um campo: `g_cont/f_ns`. */
function pathOf(index: FormIndex, id: string): string {
  const visit = index.byId.get(id);
  return visit ? [...visit.ancestors, id].join('/') : id;
}

// ── Regra 1: `id` duplicados ────────────────────────────────────────────────

function checkDuplicateIds(
  definition: FormDefinition,
  erro: (code: string, path: string, message: string) => void,
): void {
  const seen = new Map<string, string>();
  const walk = (fields: readonly Field[], prefix: string[]): void => {
    for (const field of fields) {
      const path = [...prefix, field.id].join('/');
      const first = seen.get(field.id);
      if (first !== undefined) {
        erro(
          'id_duplicado',
          path,
          `O id "${field.id}" já é usado em "${first}". Um id nunca se repete nem se reutiliza, porque é a chave sob a qual os dados ficam guardados.`,
        );
      } else {
        seen.set(field.id, path);
      }
      if (field.type === 'group' || field.type === 'repeat') {
        walk(field.fields, [...prefix, field.id]);
      }
    }
  };
  walk(definition.fields, []);
}

// ── Regra 2: `name` duplicados no mesmo âmbito ──────────────────────────────

function checkDuplicateNames(
  index: FormIndex,
  erro: (code: string, path: string, message: string) => void,
): void {
  const byScope = new Map<ScopeId, Map<string, string>>();
  for (const { field, repeatScope } of index.order) {
    if (field.type === 'note') continue; // não gera coluna nenhuma
    let names = byScope.get(repeatScope);
    if (!names) {
      names = new Map();
      byScope.set(repeatScope, names);
    }
    const first = names.get(field.name);
    if (first !== undefined) {
      erro(
        'name_duplicado',
        pathOf(index, field.id),
        `O name "${field.name}" já é usado pelo campo "${first}" no mesmo âmbito. Dois campos com o mesmo name gerariam a mesma coluna na vista.`,
      );
    } else {
      names.set(field.name, field.id);
    }
  }
}

// ── Regras 4, 5, 6, 8, 9, 10, 11, 12 ────────────────────────────────────────

function checkFieldRules(
  index: FormIndex,
  options: ValidateDefinitionOptions,
  erro: (code: string, path: string, message: string) => void,
  aviso: (code: string, path: string, message: string) => void,
): void {
  for (const { field, repeatScope } of index.order) {
    const base = pathOf(index, field.id);

    // Regra 12: um campo calculado que o utilizador possa editar produz dados
    // contraditórios — um valor escrito à mão que o próximo recálculo apaga.
    if (field.calculation && field.type !== 'calculate' && field.readonly !== true) {
      erro(
        'calculo_em_campo_editavel',
        `${base}.calculation`,
        `O campo "${field.id}" tem calculation mas não é do tipo calculate nem está readonly. Marca-o readonly ou muda o tipo para calculate.`,
      );
    }

    // Regra 5: lista de escolhas inexistente.
    if (field.type === 'select_one' || field.type === 'select_multiple') {
      const lists = index.definition.choice_lists ?? {};
      if (!Object.prototype.hasOwnProperty.call(lists, field.choices_ref)) {
        erro(
          'lista_desconhecida',
          `${base}.choices_ref`,
          `A lista de escolhas "${field.choices_ref}" não existe em choice_lists.`,
        );
      }
    }

    // Regra 6: formulário apontado inexistente ou de outra organização.
    if (field.type === 'reference' && options.knownFormIds) {
      if (!options.knownFormIds.includes(field.target_form_id)) {
        erro(
          'formulario_desconhecido',
          `${base}.target_form_id`,
          `O formulário "${field.target_form_id}" não existe ou não está acessível a partir deste projecto.`,
        );
      }
    }

    if (field.type === 'repeat' && field.min !== undefined && field.max !== undefined) {
      if (field.min > field.max) {
        erro(
          'repetivel_min_maior_que_max',
          base,
          `O repetível "${field.id}" tem min (${field.min}) maior do que max (${field.max}).`,
        );
      }
    }

    for (const { slot, expr } of expressionsOf(field)) {
      const exprPath = `${base}.${slot}`;
      checkExpression(index, field, repeatScope, expr, slot, exprPath, erro, aviso);
    }
  }
}

function checkExpression(
  index: FormIndex,
  field: Field,
  scope: ScopeId,
  node: ExpressionArg,
  slot: ExpressionSlot,
  path: string,
  erro: (code: string, path: string, message: string) => void,
  aviso: (code: string, path: string, message: string) => void,
): void {
  // O âmbito de `instance_label` é o de dentro do repetível, não o de fora.
  const effectiveScope = slot === 'instance_label' && field.type === 'repeat' ? field.id : scope;

  if (typeof node === 'string') {
    if (isMalformedReference(node)) {
      erro(
        'referencia_malformada',
        path,
        `"${node}" parece uma referência mas não é válida. Uma referência é $id, $..id ou $self; um literal que comece por $ escreve-se com concat.`,
      );
      return;
    }
    checkReferenceStrings(index, field, effectiveScope, node, slot, path, erro);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) =>
      checkExpression(index, field, scope, item, slot, `${path}[${i}]`, erro, aviso),
    );
    return;
  }
  if (!isExpression(node)) return;

  // Regra 10: aridade.
  if (!isOperator(node.op)) {
    erro(
      'operador_desconhecido',
      path,
      `O operador "${node.op}" não existe na versão 1 do formato.`,
    );
    return;
  }
  const spec = OPERATORS[node.op];
  if (node.args.length < spec.min || node.args.length > spec.max) {
    erro(
      'aridade_invalida',
      path,
      `O operador "${node.op}" recebe ${describeArity(node.op)} argumentos e recebeu ${node.args.length}.`,
    );
  }

  // Uma restrição que use `today` ou `now` deixa de ser reproduzível: um
  // registo validado ontem pode ficar inválido hoje, sem ninguém lhe tocar.
  if (spec.volatile && slot === 'constraint') {
    aviso(
      'restricao_nao_reproduzivel',
      path,
      `A restrição usa "${node.op}", que não é determinista. Um registo válido hoje pode ficar inválido amanhã sem ninguém lhe tocar.`,
    );
  }

  // Regra 11: `count` e `sum` sobre algo que não é repetível.
  if (node.op === 'count' || node.op === 'sum') {
    checkAggregation(index, node, effectiveScope, path, erro);
  }

  node.args.forEach((arg, i) => {
    // O segundo argumento do `sum` é o id do campo somado, em texto simples:
    // não é referência nem literal a validar como expressão.
    if (node.op === 'sum' && i === 1) return;
    checkExpression(index, field, scope, arg, slot, `${path}.args[${i}]`, erro, aviso);
  });
}

function checkReferenceStrings(
  index: FormIndex,
  field: Field,
  scope: ScopeId,
  value: string,
  slot: ExpressionSlot,
  path: string,
  erro: (code: string, path: string, message: string) => void,
): void {
  const found = collectReferences(value, slot, path);
  for (const { ref } of found) {
    // Regra 8: `$self` só faz sentido dentro de um `constraint`.
    if (ref.kind === 'self') {
      if (slot !== 'constraint') {
        erro(
          'self_fora_de_constraint',
          path,
          `$self só pode ser usado num constraint. Aqui está em ${slot}; usa $${field.id} se querias mesmo o valor deste campo.`,
        );
      }
      continue;
    }

    // Regra 9: `$..x` só dentro de um repetível.
    if (ref.kind === 'parent' && scope === undefined) {
      erro(
        'ambito_pai_fora_de_repeticao',
        path,
        `$..${ref.id} refere-se ao âmbito pai, e este campo não está dentro de nenhum repetível.`,
      );
      continue;
    }

    // Regra 4: referência a campo inexistente.
    const target = index.byId.get(ref.id);
    if (!target) {
      erro(
        'referencia_desconhecida',
        path,
        `A referência $${ref.kind === 'parent' ? '..' : ''}${ref.id} aponta para um campo que não existe. As referências são sempre por id, nunca por name.`,
      );
      continue;
    }

    const from = ref.kind === 'parent' ? parentOf(index, scope) : scope;
    if (!isVisibleFrom(index, ref.id, from)) {
      erro(
        'referencia_fora_de_ambito',
        path,
        `O campo "${ref.id}" está dentro do repetível "${target.repeatScope ?? 'raiz'}" e não é visível daqui: há N instâncias e a expressão não diz qual. Usa count ou sum.`,
      );
    }
  }
}

function parentOf(index: FormIndex, scope: ScopeId): ScopeId {
  return scope === undefined ? undefined : index.parentScope.get(scope);
}

function checkAggregation(
  index: FormIndex,
  node: Expression,
  scope: ScopeId,
  path: string,
  erro: (code: string, path: string, message: string) => void,
): void {
  const target = node.args[0];
  if (typeof target !== 'string') {
    erro(
      'agregacao_sem_repetivel',
      `${path}.args[0]`,
      `O operador "${node.op}" tem de receber uma referência a um repetível no primeiro argumento.`,
    );
    return;
  }
  const ref = collectReferences(target, 'calculation', path)[0]?.ref;
  if (!ref || ref.kind === 'self') {
    erro(
      'agregacao_sem_repetivel',
      `${path}.args[0]`,
      `O operador "${node.op}" tem de receber uma referência a um repetível no primeiro argumento.`,
    );
    return;
  }
  const repeat = index.repeats.get(ref.id);
  if (!repeat) {
    const exists = index.byId.has(ref.id);
    erro(
      'agregacao_sem_repetivel',
      `${path}.args[0]`,
      exists
        ? `"${ref.id}" não é um repetível, e "${node.op}" só funciona sobre repetíveis.`
        : `"${ref.id}" não existe, e "${node.op}" só funciona sobre repetíveis.`,
    );
    return;
  }
  if (!scopeChain(index, scope).includes(index.parentScope.get(ref.id))) {
    erro(
      'agregacao_fora_de_ambito',
      `${path}.args[0]`,
      `O repetível "${ref.id}" não é alcançável a partir deste âmbito.`,
    );
  }

  if (node.op === 'sum') {
    const summed = node.args[1];
    if (typeof summed !== 'string' || summed.startsWith('$')) {
      erro(
        'sum_sem_campo',
        `${path}.args[1]`,
        `O segundo argumento de sum é o id do campo a somar, em texto simples (por exemplo "f_leitura"), não uma referência.`,
      );
      return;
    }
    const inner = index.byId.get(summed);
    if (!inner) {
      erro(
        'referencia_desconhecida',
        `${path}.args[1]`,
        `O campo "${summed}", somado por sum, não existe.`,
      );
    } else if (inner.repeatScope !== ref.id) {
      erro(
        'campo_somado_fora_do_repetivel',
        `${path}.args[1]`,
        `O campo "${summed}" não está dentro do repetível "${ref.id}".`,
      );
    }
  }
}

// ── Regra 7: `geometry_field` ───────────────────────────────────────────────

function checkSettings(
  index: FormIndex,
  erro: (code: string, path: string, message: string) => void,
): void {
  const settings = index.definition.settings;
  if (!settings) return;

  if (settings.geometry_field !== undefined) {
    const target = index.byId.get(settings.geometry_field);
    if (!target) {
      erro(
        'geometry_field_invalido',
        'settings.geometry_field',
        `settings.geometry_field aponta para "${settings.geometry_field}", que não existe.`,
      );
    } else if (target.field.type !== 'geopoint') {
      erro(
        'geometry_field_invalido',
        'settings.geometry_field',
        `settings.geometry_field tem de apontar para um geopoint; "${settings.geometry_field}" é do tipo ${target.field.type}.`,
      );
    } else if (target.repeatScope !== undefined) {
      erro(
        'geometry_field_invalido',
        'settings.geometry_field',
        `settings.geometry_field aponta para um campo dentro do repetível "${target.repeatScope}": um registo só tem uma geometria.`,
      );
    }
  }

  if (settings.record_label) {
    const dummy: Field = {
      id: '__record_label__',
      name: '__record_label__',
      type: 'note',
    };
    // O rótulo do registo é avaliado no âmbito raiz, como diz a §3.
    checkExpression(
      index,
      dummy,
      undefined,
      settings.record_label,
      'calculation',
      'settings.record_label',
      erro,
      () => {},
    );
  }
}

function checkChoiceLists(
  definition: FormDefinition,
  erro: (code: string, path: string, message: string) => void,
): void {
  for (const [key, choices] of Object.entries(definition.choice_lists ?? {})) {
    const seen = new Set<string>();
    choices.forEach((choice, i) => {
      if (seen.has(choice.value)) {
        erro(
          'valor_de_escolha_duplicado',
          `choice_lists.${key}[${i}]`,
          `O valor "${choice.value}" aparece duas vezes na lista "${key}". O value é o que fica guardado e tem de ser único.`,
        );
      }
      seen.add(choice.value);
    });
  }
}

// ── Regra 3: ciclos ─────────────────────────────────────────────────────────

function checkCycles(
  index: FormIndex,
  erro: (code: string, path: string, message: string) => void,
): void {
  const graph = buildDependencyGraph(index);
  for (const cycle of findCycles(graph)) {
    const head = cycle.path[0] ?? '';
    erro(
      'ciclo',
      pathOf(index, head),
      `Ciclo de dependências: ${cycle.path.join(' → ')}. Um formulário com um ciclo nunca estabiliza.`,
    );
  }
}
