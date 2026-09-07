import {
  FIELD_TYPES,
  collectFields,
  type Field,
  type FieldType,
  type FormDefinition,
  type LocalizedText,
} from '@cvforms/form-core';

/**
 * Operações do construtor sobre uma definição (F2.15).
 *
 * Puro, sem React: acrescentar, remover, mover e alterar um campo são
 * operações sobre dados, e é assim que se testam. O ecrã só chama isto.
 *
 * A regra que atravessa tudo: o `id` é gerado uma vez e nunca mais muda, nem
 * quando o campo é renomeado, nem quando é movido. Os dados já recolhidos
 * estão guardados por `id` (FORM-SPEC §1).
 */

/** Caminho até um campo: índices sucessivos na árvore. */
export type Caminho = number[];

export const TIPOS_COM_FILHOS: FieldType[] = ['group', 'repeat'];

/** Tipos que se podem escolher no construtor, agrupados como no ecrã. */
export const FAMILIAS: Array<{ titulo: string; tipos: FieldType[] }> = [
  { titulo: 'Texto e números', tipos: ['text', 'integer', 'decimal', 'barcode', 'calculate'] },
  { titulo: 'Escolhas', tipos: ['select_one', 'select_multiple', 'boolean'] },
  { titulo: 'Datas', tipos: ['date', 'time', 'datetime'] },
  { titulo: 'Localização', tipos: ['geopoint', 'geotrace', 'geoshape'] },
  { titulo: 'Anexos', tipos: ['photo', 'audio', 'file', 'signature'] },
  { titulo: 'Estrutura', tipos: ['group', 'repeat', 'note', 'reference'] },
];

export const NOME_DO_TIPO: Record<FieldType, string> = {
  text: 'Texto',
  note: 'Nota',
  integer: 'Número inteiro',
  decimal: 'Número decimal',
  boolean: 'Sim / não',
  select_one: 'Escolha única',
  select_multiple: 'Escolha múltipla',
  date: 'Data',
  time: 'Hora',
  datetime: 'Data e hora',
  geopoint: 'Ponto',
  geotrace: 'Linha',
  geoshape: 'Polígono',
  photo: 'Fotografia',
  audio: 'Áudio',
  file: 'Ficheiro',
  signature: 'Assinatura',
  barcode: 'Código de barras',
  calculate: 'Campo calculado',
  group: 'Grupo',
  repeat: 'Repetível',
  reference: 'Referência a outro registo',
};

/** Sanea um rótulo escrito por um humano num `name` válido. */
export function nomeAPartirDoRotulo(rotulo: string, usados: Set<string>): string {
  const base =
    rotulo
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^[^a-z_]+/, '')
      .replace(/^_+|_+$/g, '')
      .slice(0, 55) || 'campo';
  if (!usados.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidato = `${base}_${i}`;
    if (!usados.has(candidato)) return candidato;
  }
}

/**
 * `id` novo. Curto e opaco, derivado do tipo — nunca é lido por um humano em
 * contexto de dados, mas ver `f_codigo` num diff ajuda quem depura.
 */
export function novoId(tipo: FieldType, rotulo: string, usados: Set<string>): string {
  const prefixo = TIPOS_COM_FILHOS.includes(tipo) ? 'g' : 'f';
  const slug =
    rotulo
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^[^a-z_]+/, '')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'campo';
  const base = `${prefixo}_${slug}`;
  if (!usados.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidato = `${base}_${i}`;
    if (!usados.has(candidato)) return candidato;
  }
}

export function idsUsados(definicao: FormDefinition): Set<string> {
  return new Set(collectFields(definicao).map((v) => v.field.id));
}

/** `name` já usados no âmbito de dados onde o campo vai ficar. */
export function nomesDoAmbito(definicao: FormDefinition, caminho: Caminho): Set<string> {
  const ambito = ambitoDeDados(definicao, caminho);
  return new Set(
    collectFields(definicao)
      .filter((v) => v.repeatScope === ambito)
      .map((v) => v.field.name),
  );
}

/** `id` do repetível que contém este caminho, ou `undefined` na raiz. */
function ambitoDeDados(definicao: FormDefinition, caminho: Caminho): string | undefined {
  let campos: readonly Field[] = definicao.fields;
  let ambito: string | undefined;
  for (const indice of caminho.slice(0, -1)) {
    const campo = campos[indice];
    if (!campo || (campo.type !== 'group' && campo.type !== 'repeat')) break;
    if (campo.type === 'repeat') ambito = campo.id;
    campos = campo.fields;
  }
  return ambito;
}

export function campoEm(definicao: FormDefinition, caminho: Caminho): Field | undefined {
  let campos: readonly Field[] = definicao.fields;
  let campo: Field | undefined;
  for (const indice of caminho) {
    campo = campos[indice];
    if (!campo) return undefined;
    campos = campo.type === 'group' || campo.type === 'repeat' ? campo.fields : [];
  }
  return campo;
}

/** Devolve uma cópia da definição com o campo do caminho substituído. */
export function substituirCampo(
  definicao: FormDefinition,
  caminho: Caminho,
  novo: Field,
): FormDefinition {
  return { ...definicao, fields: substituirEm(definicao.fields, caminho, novo) };
}

function substituirEm(campos: readonly Field[], caminho: Caminho, novo: Field): Field[] {
  const [indice, ...resto] = caminho;
  if (indice === undefined) return [...campos];
  return campos.map((campo, i) => {
    if (i !== indice) return campo;
    if (resto.length === 0) return novo;
    if (campo.type !== 'group' && campo.type !== 'repeat') return campo;
    return { ...campo, fields: substituirEm(campo.fields, resto, novo) };
  });
}

export function acrescentarCampo(
  definicao: FormDefinition,
  caminhoDoPai: Caminho,
  campo: Field,
): FormDefinition {
  if (caminhoDoPai.length === 0) {
    return { ...definicao, fields: [...definicao.fields, campo] };
  }
  const pai = campoEm(definicao, caminhoDoPai);
  if (!pai || (pai.type !== 'group' && pai.type !== 'repeat')) return definicao;
  return substituirCampo(definicao, caminhoDoPai, { ...pai, fields: [...pai.fields, campo] });
}

export function removerCampo(definicao: FormDefinition, caminho: Caminho): FormDefinition {
  return { ...definicao, fields: removerEm(definicao.fields, caminho) };
}

function removerEm(campos: readonly Field[], caminho: Caminho): Field[] {
  const [indice, ...resto] = caminho;
  if (indice === undefined) return [...campos];
  if (resto.length === 0) return campos.filter((_, i) => i !== indice);
  return campos.map((campo, i) => {
    if (i !== indice || (campo.type !== 'group' && campo.type !== 'repeat')) return campo;
    return { ...campo, fields: removerEm(campo.fields, resto) };
  });
}

/** Move um campo dentro do mesmo nível. Mover entre níveis muda o âmbito. */
export function moverCampo(
  definicao: FormDefinition,
  caminho: Caminho,
  direccao: -1 | 1,
): FormDefinition {
  const pai = caminho.slice(0, -1);
  const indice = caminho[caminho.length - 1];
  if (indice === undefined) return definicao;
  const irmaos = pai.length === 0 ? definicao.fields : filhosDe(definicao, pai);
  const destino = indice + direccao;
  if (!irmaos || destino < 0 || destino >= irmaos.length) return definicao;

  const reordenados = [...irmaos];
  const [movido] = reordenados.splice(indice, 1);
  if (!movido) return definicao;
  reordenados.splice(destino, 0, movido);

  if (pai.length === 0) return { ...definicao, fields: reordenados };
  const contentor = campoEm(definicao, pai);
  if (!contentor || (contentor.type !== 'group' && contentor.type !== 'repeat')) return definicao;
  return substituirCampo(definicao, pai, { ...contentor, fields: reordenados });
}

function filhosDe(definicao: FormDefinition, caminho: Caminho): Field[] | undefined {
  const campo = campoEm(definicao, caminho);
  return campo && (campo.type === 'group' || campo.type === 'repeat') ? campo.fields : undefined;
}

/** Campo novo, já com os valores mínimos que o tornam válido. */
export function campoNovo(
  tipo: FieldType,
  rotulo: string,
  definicao: FormDefinition,
  caminhoDoPai: Caminho,
): Field {
  const id = novoId(tipo, rotulo, idsUsados(definicao));
  const name = nomeAPartirDoRotulo(rotulo, nomesDoAmbito(definicao, [...caminhoDoPai, 0]));
  const base = { id, name, type: tipo, label: { pt: rotulo } as LocalizedText };

  if (tipo === 'group' || tipo === 'repeat') return { ...base, fields: [] } as unknown as Field;
  if (tipo === 'select_one' || tipo === 'select_multiple') {
    // Sem lista, o campo não passa o validador. Criar uma vazia adiava o erro
    // para a publicação; criar uma com duas opções dá algo para editar.
    return { ...base, choices_ref: primeiraListaOuNova(definicao) } as unknown as Field;
  }
  if (tipo === 'calculate') {
    return { ...base, calculation: { op: 'coalesce', args: ['', ''] } } as unknown as Field;
  }
  if (tipo === 'reference') {
    return { ...base, target_form_id: '' } as unknown as Field;
  }
  return base as unknown as Field;
}

function primeiraListaOuNova(definicao: FormDefinition): string {
  const chaves = Object.keys(definicao.choice_lists ?? {});
  return chaves[0] ?? 'lista_1';
}

export function listaNova(definicao: FormDefinition): string {
  const chaves = new Set(Object.keys(definicao.choice_lists ?? {}));
  for (let i = 1; ; i++) {
    const chave = `lista_${i}`;
    if (!chaves.has(chave)) return chave;
  }
}

export const TODOS_OS_TIPOS = FIELD_TYPES;
