import { buildDependencyGraph, type DependencyGraph } from './dependencies.js';
import { childContext, evaluate, makeContext, type EvalContext } from './evaluate.js';
import { buildIndex, type FormIndex } from './index-form.js';
import { computeFormState, type InstancePath } from './runtime.js';
import { validateAnswers, type AnswerIssue } from './validate-answers.js';
import type { Field, FormDefinition, LocalizedText, RecordData } from './types/index.js';

/**
 * Estado de um formulário a ser preenchido (F3).
 *
 * Vive aqui, e não na app móvel, porque tem dois consumidores: o renderizador
 * do telefone e a pré-visualização do construtor no painel. Se fossem duas
 * implementações, o que o administrador vê ao desenhar deixaria de ser o que o
 * técnico vê em campo — e a divergência só apareceria no terreno.
 *
 * É TypeScript puro, sem React nem React Native. É aqui que vivem a relevância
 * reactiva, os cálculos, os repetíveis e a validação — ou seja, tudo o que
 * pode estar errado — e assim testa-se em milissegundos, sem emulador.
 *
 * Nenhuma linha deste ficheiro conhece nenhum formulário concreto (restrição
 * inegociável 6). Se aqui aparecer um `if (campo.id === ...)`, o desenho
 * falhou.
 */

/**
 * Cópia profunda das respostas.
 *
 * O `structuredClone` só existe no Hermes a partir de certas versões do React
 * Native, e uma app que rebenta ao escrever no primeiro campo é pior do que
 * uma cópia um pouco mais lenta. As respostas são JSON puro — não há Date nem
 * Map lá dentro — por isso a alternativa é exacta.
 */
function clonarDados(dados: RecordData): RecordData {
  const clone = (globalThis as { structuredClone?: <T>(v: T) => T }).structuredClone;
  return clone ? clone(dados) : (JSON.parse(JSON.stringify(dados)) as RecordData);
}

export interface Seccao {
  /** `id` do grupo de topo, ou `undefined` na secção implícita. */
  id: string | undefined;
  titulo: string;
  /** Campos de topo desta secção, pela ordem da definição. */
  campos: Field[];
}

export interface EstadoFormulario {
  definicao: FormDefinition;
  indice: FormIndex;
  grafo: DependencyGraph;
  /** Respostas, sempre por `id` de campo. Nunca por `name`. */
  dados: RecordData;
  /** Relevância por caminho de instância. */
  relevancia: Map<InstancePath, boolean>;
  /** Erros por caminho de instância. */
  erros: Map<InstancePath, AnswerIssue[]>;
  /**
   * Caminhos que o técnico já tocou. Um erro só aparece depois de mexer no
   * campo, ou depois de tentar submeter: acender tudo a vermelho num
   * formulário vazio não ajuda ninguém a preenchê-lo.
   */
  tocados: Set<InstancePath>;
  mostrarTodosOsErros: boolean;
  seccoes: Seccao[];
  seccaoActual: number;
  idioma: string;
  /** Muda a cada alteração. É o que o React usa para saber que tem de pintar. */
  revisao: number;
  /** Instante injectável, para `today` e `now` serem testáveis. */
  agora?: Date;
}

export interface OpcoesEstado {
  idioma?: string;
  agora?: Date;
  seccaoActual?: number;
}

export function criarEstado(
  definicao: FormDefinition,
  dados: RecordData = {},
  opcoes: OpcoesEstado = {},
): EstadoFormulario {
  const indice = buildIndex(definicao);
  const idioma = opcoes.idioma ?? definicao.settings?.default_language ?? 'pt';
  const estado: EstadoFormulario = {
    definicao,
    indice,
    grafo: buildDependencyGraph(indice),
    dados: aplicarValoresPorOmissao(definicao, clonarDados(dados)),
    relevancia: new Map(),
    erros: new Map(),
    tocados: new Set(),
    mostrarTodosOsErros: false,
    seccoes: calcularSeccoes(definicao, idioma),
    seccaoActual: opcoes.seccaoActual ?? 0,
    idioma,
    revisao: 0,
    ...(opcoes.agora ? { agora: opcoes.agora } : {}),
  };
  return recalcular(estado);
}

/**
 * Recalcula tudo o que depende dos dados: cálculos, relevância e validação.
 *
 * Uma só passagem por alteração. A ordenação topológica do `form-core` é o que
 * torna isto possível — sem ela seria preciso iterar até estabilizar, e num
 * Android de gama baixa isso sente-se a cada toque.
 */
export function recalcular(estado: EstadoFormulario): EstadoFormulario {
  const resultado = computeFormState(estado.definicao, estado.dados, {
    index: estado.indice,
    ...(estado.agora ? { now: estado.agora } : {}),
  });

  const validacao = validateAnswers(estado.definicao, resultado.data, {
    index: estado.indice,
    language: estado.idioma,
    ...(estado.agora ? { now: estado.agora } : {}),
  });

  const erros = new Map<InstancePath, AnswerIssue[]>();
  for (const issue of validacao.issues) {
    const lista = erros.get(issue.path);
    if (lista) lista.push(issue);
    else erros.set(issue.path, [issue]);
  }

  return {
    ...estado,
    dados: resultado.data,
    relevancia: resultado.relevance.byPath,
    erros,
    revisao: estado.revisao + 1,
  };
}

/** Escreve um valor e recalcula. É o único caminho por onde os dados mudam. */
export function definirValor(
  estado: EstadoFormulario,
  caminho: InstancePath,
  valor: unknown,
): EstadoFormulario {
  const dados = clonarDados(estado.dados);
  escreverEmCaminho(dados, caminho, valor);
  const tocados = new Set(estado.tocados);
  tocados.add(caminho);
  return recalcular({ ...estado, dados, tocados });
}

/** Marca um campo como tocado sem lhe mudar o valor (ao sair do campo). */
export function marcarTocado(estado: EstadoFormulario, caminho: InstancePath): EstadoFormulario {
  if (estado.tocados.has(caminho)) return estado;
  const tocados = new Set(estado.tocados);
  tocados.add(caminho);
  return { ...estado, tocados, revisao: estado.revisao + 1 };
}

export function mostrarTodosOsErros(estado: EstadoFormulario): EstadoFormulario {
  return { ...estado, mostrarTodosOsErros: true, revisao: estado.revisao + 1 };
}

export function irParaSeccao(estado: EstadoFormulario, indice: number): EstadoFormulario {
  const limite = Math.max(0, Math.min(indice, estado.seccoes.length - 1));
  return { ...estado, seccaoActual: limite, revisao: estado.revisao + 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Repetíveis (F3.8)
// ─────────────────────────────────────────────────────────────────────────────

/** Acrescenta uma instância a um repetível e devolve o estado novo. */
export function acrescentarInstancia(
  estado: EstadoFormulario,
  caminhoDoRepetivel: InstancePath,
): EstadoFormulario {
  const dados = clonarDados(estado.dados);
  const actual = lerCaminho(dados, caminhoDoRepetivel);
  const lista = Array.isArray(actual) ? [...actual] : [];
  const repetivel = campoDoCaminho(estado.indice, caminhoDoRepetivel);
  lista.push(repetivel && repetivel.type === 'repeat' ? instanciaVazia(repetivel) : {});
  escreverEmCaminho(dados, caminhoDoRepetivel, lista);
  return recalcular({ ...estado, dados });
}

/**
 * Remove uma instância.
 *
 * Remove mesmo, do rascunho local — não é o mesmo que apagar um registo
 * sincronizado, que nunca se apaga (restrição inegociável 4). Aqui trata-se de
 * uma linha que o técnico acrescentou por engano e ainda não submeteu.
 */
export function removerInstancia(
  estado: EstadoFormulario,
  caminhoDoRepetivel: InstancePath,
  indice: number,
): EstadoFormulario {
  const dados = clonarDados(estado.dados);
  const actual = lerCaminho(dados, caminhoDoRepetivel);
  if (!Array.isArray(actual)) return estado;
  const lista = [...actual];
  if (indice < 0 || indice >= lista.length) return estado;
  lista.splice(indice, 1);
  escreverEmCaminho(dados, caminhoDoRepetivel, lista);
  return recalcular({ ...estado, dados });
}

export function moverInstancia(
  estado: EstadoFormulario,
  caminhoDoRepetivel: InstancePath,
  de: number,
  para: number,
): EstadoFormulario {
  const dados = clonarDados(estado.dados);
  const actual = lerCaminho(dados, caminhoDoRepetivel);
  if (!Array.isArray(actual)) return estado;
  const lista = [...actual];
  if (de < 0 || de >= lista.length || para < 0 || para >= lista.length) return estado;
  const [movido] = lista.splice(de, 1);
  lista.splice(para, 0, movido);
  escreverEmCaminho(dados, caminhoDoRepetivel, lista);
  return recalcular({ ...estado, dados });
}

/**
 * Rótulo de cada instância de um repetível, para a lista não ser
 * «Contador 1, Contador 2» quando o técnico já escreveu o número de série.
 */
export function rotulosDasInstancias(
  estado: EstadoFormulario,
  caminhoDoRepetivel: InstancePath,
): string[] {
  const repetivel = campoDoCaminho(estado.indice, caminhoDoRepetivel);
  const lista = lerCaminho(estado.dados, caminhoDoRepetivel);
  if (!Array.isArray(lista)) return [];
  const nome = repetivel ? texto(repetivel.label, estado.idioma, repetivel.name) : 'Instância';

  return lista.map((instancia, i) => {
    if (!repetivel || repetivel.type !== 'repeat' || !repetivel.instance_label) {
      return `${nome} ${i + 1}`;
    }
    const ctx = contextoDaInstancia(estado, caminhoDoRepetivel, i);
    const valor = evaluate(repetivel.instance_label, ctx);
    return valor === null || valor === undefined || valor === ''
      ? `${nome} ${i + 1}`
      : String(valor);
  });
}

function contextoDaInstancia(
  estado: EstadoFormulario,
  caminhoDoRepetivel: InstancePath,
  indice: number,
): EvalContext {
  const segmentos = partirCaminho(caminhoDoRepetivel);
  let ctx: EvalContext = makeContext(estado.dados, estado.agora ? { now: estado.agora } : {});
  let valores: RecordData = estado.dados;

  for (const segmento of segmentos) {
    const lista = valores[segmento.id];
    if (segmento.indice === undefined || !Array.isArray(lista)) continue;
    const item = lista[segmento.indice];
    if (typeof item !== 'object' || item === null) continue;
    valores = item as RecordData;
    ctx = childContext(ctx, valores);
  }

  const alvo = lerCaminho(estado.dados, caminhoDoRepetivel);
  const instancia = Array.isArray(alvo) ? alvo[indice] : undefined;
  if (typeof instancia === 'object' && instancia !== null) {
    return childContext(ctx, instancia as RecordData);
  }
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Consultas para a UI
// ─────────────────────────────────────────────────────────────────────────────

export function eRelevante(estado: EstadoFormulario, caminho: InstancePath): boolean {
  return estado.relevancia.get(caminho) ?? true;
}

/** Erros a mostrar num campo: só depois de tocado, ou ao tentar submeter. */
export function errosVisiveis(estado: EstadoFormulario, caminho: InstancePath): AnswerIssue[] {
  if (!estado.mostrarTodosOsErros && !estado.tocados.has(caminho)) return [];
  return estado.erros.get(caminho) ?? [];
}

export function valorEm(estado: EstadoFormulario, caminho: InstancePath): unknown {
  return lerCaminho(estado.dados, caminho) ?? null;
}

/** Número de erros por secção, para o cabeçalho de navegação. */
export function errosPorSeccao(estado: EstadoFormulario): number[] {
  return estado.seccoes.map((seccao) => {
    const ids = new Set<string>();
    const recolher = (campos: readonly Field[]): void => {
      for (const campo of campos) {
        ids.add(campo.id);
        if (campo.type === 'group' || campo.type === 'repeat') recolher(campo.fields);
      }
    };
    recolher(seccao.campos);
    let total = 0;
    for (const [, lista] of estado.erros) {
      for (const issue of lista) {
        if (issue.severity === 'erro' && ids.has(issue.fieldId)) total++;
      }
    }
    return total;
  });
}

export function estaValido(estado: EstadoFormulario): boolean {
  for (const [, lista] of estado.erros) {
    if (lista.some((i) => i.severity === 'erro')) return false;
  }
  return true;
}

export function texto(rotulo: LocalizedText | undefined, idioma: string, omissao: string): string {
  if (!rotulo) return omissao;
  return rotulo[idioma] ?? rotulo.pt ?? omissao;
}

// ─────────────────────────────────────────────────────────────────────────────
// Caminhos de instância
// ─────────────────────────────────────────────────────────────────────────────

export interface SegmentoDeCaminho {
  id: string;
  indice: number | undefined;
}

/** `g_cont[1].f_ns` → `[{id:'g_cont',indice:1},{id:'f_ns'}]`. */
export function partirCaminho(caminho: InstancePath): SegmentoDeCaminho[] {
  if (caminho === '') return [];
  return caminho.split('.').map((parte) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?$/.exec(parte);
    if (!match) return { id: parte, indice: undefined };
    return {
      id: match[1]!,
      indice: match[2] === undefined ? undefined : Number(match[2]),
    };
  });
}

export function lerCaminho(dados: RecordData, caminho: InstancePath): unknown {
  let actual: unknown = dados;
  for (const segmento of partirCaminho(caminho)) {
    if (typeof actual !== 'object' || actual === null) return undefined;
    actual = (actual as RecordData)[segmento.id];
    if (segmento.indice !== undefined) {
      if (!Array.isArray(actual)) return undefined;
      actual = actual[segmento.indice];
    }
  }
  return actual;
}

/**
 * Escreve num caminho, criando pelo caminho o que faltar.
 *
 * Criar o que falta é intencional: uma instância de repetível pode ser tocada
 * antes de existir no objecto, e recusar a escrita perderia o que o técnico
 * acabou de escrever.
 */
export function escreverEmCaminho(dados: RecordData, caminho: InstancePath, valor: unknown): void {
  const segmentos = partirCaminho(caminho);
  if (segmentos.length === 0) return;
  let actual: RecordData = dados;

  for (let i = 0; i < segmentos.length - 1; i++) {
    const segmento = segmentos[i]!;
    let seguinte = actual[segmento.id];
    if (segmento.indice === undefined) {
      if (typeof seguinte !== 'object' || seguinte === null || Array.isArray(seguinte)) {
        seguinte = {};
        actual[segmento.id] = seguinte;
      }
      actual = seguinte as RecordData;
      continue;
    }
    if (!Array.isArray(seguinte)) {
      seguinte = [];
      actual[segmento.id] = seguinte;
    }
    const lista = seguinte as unknown[];
    while (lista.length <= segmento.indice) lista.push({});
    let item = lista[segmento.indice];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      item = {};
      lista[segmento.indice] = item;
    }
    actual = item as RecordData;
  }

  const ultimo = segmentos[segmentos.length - 1]!;
  if (ultimo.indice === undefined) {
    actual[ultimo.id] = valor;
    return;
  }
  const lista = Array.isArray(actual[ultimo.id]) ? (actual[ultimo.id] as unknown[]) : [];
  while (lista.length <= ultimo.indice) lista.push({});
  lista[ultimo.indice] = valor;
  actual[ultimo.id] = lista;
}

function campoDoCaminho(indice: FormIndex, caminho: InstancePath): Field | undefined {
  const segmentos = partirCaminho(caminho);
  const ultimo = segmentos[segmentos.length - 1];
  return ultimo ? indice.byId.get(ultimo.id)?.field : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Secções: cada grupo de topo é uma secção; o que estiver solto vai para uma
 * secção implícita à cabeça. Um formulário de 80 perguntas navega assim sem
 * arrastar o dedo por um ecrã infinito (F3.7).
 */
function calcularSeccoes(definicao: FormDefinition, idioma: string): Seccao[] {
  const seccoes: Seccao[] = [];
  let soltos: Field[] = [];

  const fecharSoltos = (): void => {
    if (soltos.length === 0) return;
    seccoes.push({
      id: undefined,
      titulo: texto(definicao.title, idioma, 'Formulário'),
      campos: soltos,
    });
    soltos = [];
  };

  for (const campo of definicao.fields) {
    if (campo.type === 'group') {
      fecharSoltos();
      seccoes.push({
        id: campo.id,
        titulo: texto(campo.label, idioma, campo.name),
        campos: campo.fields,
      });
      continue;
    }
    soltos.push(campo);
  }
  fecharSoltos();

  if (seccoes.length === 0) {
    seccoes.push({
      id: undefined,
      titulo: texto(definicao.title, idioma, 'Formulário'),
      campos: [],
    });
  }
  return seccoes;
}

/** Valores por omissão, aplicados só onde ainda não há resposta. */
function aplicarValoresPorOmissao(definicao: FormDefinition, dados: RecordData): RecordData {
  const visitar = (campos: readonly Field[], alvo: RecordData): void => {
    for (const campo of campos) {
      if (campo.type === 'group') {
        visitar(campo.fields, alvo);
        continue;
      }
      if (campo.type === 'repeat') {
        const lista = Array.isArray(alvo[campo.id]) ? (alvo[campo.id] as RecordData[]) : [];
        // Um repetível com `min` abre já com as instâncias mínimas: obrigar o
        // técnico a carregar em «acrescentar» para poder sequer cumprir o
        // mínimo é fricção sem razão nenhuma.
        while (lista.length < (campo.min ?? 0)) lista.push({});
        for (const instancia of lista) visitar(campo.fields, instancia);
        alvo[campo.id] = lista;
        continue;
      }
      if (campo.default !== undefined && alvo[campo.id] === undefined) {
        alvo[campo.id] = campo.default;
      }
    }
  };
  visitar(definicao.fields, dados);
  return dados;
}

function instanciaVazia(repetivel: Field): RecordData {
  const instancia: RecordData = {};
  if (repetivel.type !== 'repeat') return instancia;
  const visitar = (campos: readonly Field[], alvo: RecordData): void => {
    for (const campo of campos) {
      if (campo.type === 'group') visitar(campo.fields, alvo);
      else if (campo.type === 'repeat') alvo[campo.id] = [];
      else if (campo.default !== undefined) alvo[campo.id] = campo.default;
    }
  };
  visitar(repetivel.fields, instancia);
  return instancia;
}
