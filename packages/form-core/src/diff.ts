import { buildIndex, type FormIndex } from './index-form.js';
import type { Choice, Field, FormDefinition, LocalizedText } from './types/index.js';

/**
 * Diff entre duas versões de um formulário, classificado (FORM-SPEC §9).
 *
 * O que está em jogo: publicar nunca reescreve registos existentes. Uma
 * alteração é COMPATÍVEL quando os registos já recolhidos continuam a ler-se
 * sem ambiguidade, e INCOMPATÍVEL quando não — e aí exige confirmação
 * explícita de quem publica.
 *
 * Onde não há forma de decidir sem olhar para os dados — apertar uma restrição
 * escrita à mão, por exemplo — classificamos como incompatível. Um aviso a
 * mais custa um clique; um aviso a menos custa registos que deixam de validar
 * em campo, longe de quem publicou.
 */

export type DiffClassification = 'compativel' | 'incompativel';

export interface DiffEntry {
  code: string;
  classification: DiffClassification;
  /** Caminho do campo na versão nova, ou na antiga se tiver sido removido. */
  path: string;
  fieldId?: string;
  message: string;
}

export interface FormDiff {
  /** `false` se houver pelo menos uma alteração incompatível. */
  compatible: boolean;
  entries: DiffEntry[];
}

interface FieldSnapshot {
  field: Field;
  path: string;
  scope: string | undefined;
}

function snapshot(index: FormIndex): Map<string, FieldSnapshot> {
  const out = new Map<string, FieldSnapshot>();
  for (const visit of index.order) {
    out.set(visit.field.id, {
      field: visit.field,
      path: [...visit.ancestors, visit.field.id].join('/'),
      scope: visit.repeatScope,
    });
  }
  return out;
}

export function diffDefinitions(previous: FormDefinition, next: FormDefinition): FormDiff {
  const before = snapshot(buildIndex(previous));
  const after = snapshot(buildIndex(next));
  const entries: DiffEntry[] = [];

  const push = (
    code: string,
    classification: DiffClassification,
    path: string,
    message: string,
    fieldId?: string,
  ): void => {
    entries.push(
      fieldId
        ? { code, classification, path, message, fieldId }
        : { code, classification, path, message },
    );
  };

  // ── Campos removidos ──────────────────────────────────────────────────────
  for (const [id, old] of before) {
    if (after.has(id)) continue;
    push(
      'campo_removido',
      'incompativel',
      old.path,
      `O campo "${old.field.name}" (${id}) foi removido. Os dados já recolhidos continuam guardados, mas deixam de aparecer nas vistas.`,
      id,
    );
  }

  // ── Campos acrescentados e alterados ──────────────────────────────────────
  for (const [id, novo] of after) {
    const old = before.get(id);
    if (!old) {
      push(
        'campo_acrescentado',
        'compativel',
        novo.path,
        `Campo "${novo.field.name}" (${id}) acrescentado. Os registos antigos ficam sem valor neste campo.`,
        id,
      );
      continue;
    }
    diffField(old, novo, push);
  }

  diffChoiceLists(previous, next, push);
  diffSettings(previous, next, push);

  return { compatible: !entries.some((e) => e.classification === 'incompativel'), entries };
}

function diffField(
  old: FieldSnapshot,
  novo: FieldSnapshot,
  push: (
    code: string,
    classification: DiffClassification,
    path: string,
    message: string,
    fieldId?: string,
  ) => void,
): void {
  const a = old.field;
  const b = novo.field;
  const id = b.id;

  if (a.type !== b.type) {
    push(
      'tipo_alterado',
      'incompativel',
      novo.path,
      `O campo "${b.name}" (${id}) mudou de ${a.type} para ${b.type}. Os valores já guardados foram escritos com o tipo antigo.`,
      id,
    );
  }

  if (a.name !== b.name) {
    push(
      'name_alterado',
      'compativel',
      novo.path,
      `O campo ${id} mudou de name: "${a.name}" → "${b.name}". Muda o nome da coluna nas vistas; os dados ficam intactos.`,
      id,
    );
  }

  if (old.scope !== novo.scope) {
    push(
      'ambito_alterado',
      'incompativel',
      novo.path,
      `O campo "${b.name}" (${id}) mudou de âmbito (${old.scope ?? 'raiz'} → ${novo.scope ?? 'raiz'}). Os dados antigos estão gravados no nível anterior.`,
      id,
    );
  }

  for (const key of ['label', 'hint', 'constraint_message'] as const) {
    if (!sameLabel(a[key], b[key])) {
      push(
        'rotulo_alterado',
        'compativel',
        `${novo.path}.${key}`,
        `O ${key} de "${b.name}" (${id}) mudou. Rótulos não tocam nos dados.`,
        id,
      );
    }
  }
  if (a.appearance !== b.appearance) {
    push(
      'apresentacao_alterada',
      'compativel',
      `${novo.path}.appearance`,
      `A apresentação de "${b.name}" (${id}) mudou.`,
      id,
    );
  }

  // Obrigatoriedade: relaxar é compatível; passar a exigir invalida registos
  // antigos que ficaram sem resposta e que ninguém vai poder corrigir em massa.
  const antesObrigatorio = a.required === true;
  const agoraObrigatorio = b.required === true;
  if (antesObrigatorio !== agoraObrigatorio) {
    push(
      agoraObrigatorio ? 'obrigatoriedade_apertada' : 'obrigatoriedade_relaxada',
      agoraObrigatorio ? 'incompativel' : 'compativel',
      `${novo.path}.required`,
      agoraObrigatorio
        ? `"${b.name}" (${id}) passou a obrigatório. Registos antigos sem resposta deixam de validar.`
        : `"${b.name}" (${id}) deixou de ser obrigatório.`,
      id,
    );
  }

  diffBounds(a, b, novo.path, push);
  diffConstraint(a, b, novo.path, push);
  diffCalculation(a, b, novo.path, push);
}

/** Limites numéricos e de cardinalidade: alargar é compatível, apertar não. */
function diffBounds(
  a: Field,
  b: Field,
  path: string,
  push: (
    code: string,
    classification: DiffClassification,
    path: string,
    message: string,
    fieldId?: string,
  ) => void,
): void {
  const numeric = (key: string, before: unknown, now: unknown, tighter: boolean): void => {
    if (before === now) return;
    push(
      tighter ? 'limite_apertado' : 'limite_alargado',
      tighter ? 'incompativel' : 'compativel',
      `${path}.${key}`,
      `${key} de "${b.name}" (${b.id}) mudou de ${String(before ?? 'sem limite')} para ${String(now ?? 'sem limite')}.`,
      b.id,
    );
  };

  const min = (before: number | undefined, now: number | undefined): boolean =>
    now !== undefined && (before === undefined || now > before); // subir o mínimo aperta
  const max = (before: number | undefined, now: number | undefined): boolean =>
    now !== undefined && (before === undefined || now < before); // descer o máximo aperta

  if (a.type === b.type) {
    if (b.type === 'integer' || b.type === 'decimal') {
      const prev = a as typeof b;
      numeric('min', prev.min, b.min, min(prev.min, b.min));
      numeric('max', prev.max, b.max, max(prev.max, b.max));
    }
    if (b.type === 'text') {
      const prev = a as typeof b;
      numeric('max_length', prev.max_length, b.max_length, max(prev.max_length, b.max_length));
    }
    if (b.type === 'select_multiple') {
      const prev = a as typeof b;
      numeric(
        'min_selected',
        prev.min_selected,
        b.min_selected,
        min(prev.min_selected, b.min_selected),
      );
      numeric(
        'max_selected',
        prev.max_selected,
        b.max_selected,
        max(prev.max_selected, b.max_selected),
      );
    }
    if (b.type === 'repeat') {
      const prev = a as typeof b;
      numeric('min', prev.min, b.min, min(prev.min, b.min));
      numeric('max', prev.max, b.max, max(prev.max, b.max));
    }
  }
}

function diffConstraint(
  a: Field,
  b: Field,
  path: string,
  push: (
    code: string,
    classification: DiffClassification,
    path: string,
    message: string,
    fieldId?: string,
  ) => void,
): void {
  const antes = JSON.stringify(a.constraint ?? null);
  const agora = JSON.stringify(b.constraint ?? null);
  if (antes === agora) return;

  if (b.constraint === undefined) {
    push(
      'restricao_alargada',
      'compativel',
      `${path}.constraint`,
      `A restrição de "${b.name}" (${b.id}) foi retirada. Tudo o que era válido continua válido.`,
      b.id,
    );
    return;
  }
  push(
    'restricao_apertada',
    'incompativel',
    `${path}.constraint`,
    a.constraint === undefined
      ? `"${b.name}" (${b.id}) passou a ter restrição. Registos antigos podem deixar de validar.`
      : `A restrição de "${b.name}" (${b.id}) mudou. Sem olhar para os dados não é possível saber se aperta ou alarga, por isso exige confirmação.`,
    b.id,
  );
}

function diffCalculation(
  a: Field,
  b: Field,
  path: string,
  push: (
    code: string,
    classification: DiffClassification,
    path: string,
    message: string,
    fieldId?: string,
  ) => void,
): void {
  if (JSON.stringify(a.calculation ?? null) === JSON.stringify(b.calculation ?? null)) return;
  // Alterar um cálculo não invalida nada: os valores antigos continuam
  // gravados como foram calculados na altura, e é isso que se quer — recalcular
  // o passado seria reescrever respostas.
  push(
    'calculo_alterado',
    'compativel',
    `${path}.calculation`,
    `O cálculo de "${b.name}" (${b.id}) mudou. Os registos antigos mantêm o valor com que foram gravados.`,
    b.id,
  );
}

function diffChoiceLists(
  previous: FormDefinition,
  next: FormDefinition,
  push: (
    code: string,
    classification: DiffClassification,
    path: string,
    message: string,
    fieldId?: string,
  ) => void,
): void {
  const before = previous.choice_lists ?? {};
  const after = next.choice_lists ?? {};

  for (const key of Object.keys(before)) {
    if (!(key in after)) {
      push(
        'lista_removida',
        'incompativel',
        `choice_lists.${key}`,
        `A lista "${key}" foi removida. Valores gravados com ela deixam de ter rótulo.`,
      );
    }
  }
  for (const [key, choices] of Object.entries(after)) {
    const old = before[key];
    if (!old) {
      push(
        'lista_acrescentada',
        'compativel',
        `choice_lists.${key}`,
        `Lista "${key}" acrescentada.`,
      );
      continue;
    }
    const antes = new Map(old.map((c: Choice) => [c.value, c]));
    const agora = new Map(choices.map((c: Choice) => [c.value, c]));
    for (const value of antes.keys()) {
      if (!agora.has(value)) {
        push(
          'opcao_removida',
          'incompativel',
          `choice_lists.${key}`,
          `A opção "${value}" foi removida da lista "${key}". Registos que a tenham gravada deixam de ter opção correspondente.`,
        );
      }
    }
    for (const [value, choice] of agora) {
      const old2 = antes.get(value);
      if (!old2) {
        push(
          'opcao_acrescentada',
          'compativel',
          `choice_lists.${key}`,
          `Opção "${value}" acrescentada à lista "${key}".`,
        );
      } else if (!sameLabel(old2.label, choice.label)) {
        push(
          'rotulo_de_opcao_alterado',
          'compativel',
          `choice_lists.${key}`,
          `O rótulo da opção "${value}" mudou. O value, que é o que fica guardado, não mudou.`,
        );
      }
    }
  }
}

function diffSettings(
  previous: FormDefinition,
  next: FormDefinition,
  push: (
    code: string,
    classification: DiffClassification,
    path: string,
    message: string,
    fieldId?: string,
  ) => void,
): void {
  const a = previous.settings ?? {};
  const b = next.settings ?? {};

  if (a.geometry_field !== b.geometry_field) {
    push(
      'geometry_field_alterado',
      'incompativel',
      'settings.geometry_field',
      `settings.geometry_field mudou de ${a.geometry_field ?? 'nenhum'} para ${b.geometry_field ?? 'nenhum'}. A geometria dos registos antigos foi escrita a partir do campo anterior.`,
    );
  }
  if (a.max_accuracy_m !== b.max_accuracy_m) {
    const apertou =
      b.max_accuracy_m !== undefined &&
      (a.max_accuracy_m === undefined || b.max_accuracy_m < a.max_accuracy_m);
    push(
      apertou ? 'limiar_de_precisao_apertado' : 'limiar_de_precisao_alargado',
      'compativel',
      'settings.max_accuracy_m',
      `O limiar de precisão mudou de ${a.max_accuracy_m ?? 'nenhum'} para ${b.max_accuracy_m ?? 'nenhum'} m. Aplica-se a recolhas novas; não invalida o que já foi recolhido.`,
    );
  }
  if (a.allow_edit_after_submit !== b.allow_edit_after_submit) {
    push(
      'edicao_apos_submissao_alterada',
      'compativel',
      'settings.allow_edit_after_submit',
      `allow_edit_after_submit passou a ${String(b.allow_edit_after_submit ?? false)}.`,
    );
  }
}

function sameLabel(a: LocalizedText | undefined, b: LocalizedText | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
