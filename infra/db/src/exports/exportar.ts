import {
  buildIndex,
  collectFields,
  type FormDefinition,
  type LocalizedText,
} from '@cvforms/form-core';
import type postgres from 'postgres';

import { quoteIdentifier, viewName } from '../views/identifiers.js';
import { VIEWS_SCHEMA } from '../views/generate.js';

/**
 * Exportações (F10.1 a F10.3).
 *
 * Saem SEMPRE das vistas geradas, e não do JSONB directamente. É essa a razão
 * de as vistas existirem: são a projecção tipada e é nelas que uma data é uma
 * data e um ponto é geometria. Exportar do JSONB obrigaria a repetir aqui todo
 * o trabalho do gerador, e as duas versões iam divergir.
 *
 * A regra que atravessa tudo: **as colunas saem com os rótulos que o técnico
 * lê, não com os `id` internos** (F10.1). Um ficheiro cheio de `f_cod` e
 * `g_cont` é ilegível para quem o vai abrir no Excel.
 */

export interface ExportarInput {
  sql: postgres.Sql;
  definition: FormDefinition;
  projectKey: string;
  formKey: string;
  /** Nome da vista a ler. Por omissão, a da versão da definição. */
  vista?: string;
  idioma?: string;
  /** Limita o que sai. Sem limite, sai tudo — que é o que um export quer. */
  limite?: number;
  /** `oeste,sul,este,norte` em WGS84. */
  bbox?: [number, number, number, number];
  estado?: string;
}

export interface ResultadoTabular {
  /** Cabeçalhos legíveis, pela ordem das colunas. */
  cabecalhos: string[];
  /** Nomes técnicos das colunas, para quem precisar de os cruzar. */
  colunas: string[];
  linhas: unknown[][];
}

/**
 * Lê a vista e devolve linhas com cabeçalhos legíveis.
 *
 * É a base do CSV e do XLSX. O GeoJSON usa o mesmo caminho mas trata a
 * geometria à parte.
 */
export async function lerParaExportacao(input: ExportarInput): Promise<ResultadoTabular> {
  const nome =
    input.vista ??
    viewName({
      project: input.projectKey,
      form: input.formKey,
      version: input.definition.version,
    });

  const rotulos = rotulosPorColuna(input.definition, input.idioma ?? 'pt');
  const linhas = await input.sql.unsafe(
    `SELECT * FROM ${VIEWS_SCHEMA}.${quoteIdentifier(nome)}
     ${condicoes(input)}
     ORDER BY updated_at DESC, record_id DESC
     ${input.limite ? `LIMIT ${Math.trunc(input.limite)}` : ''}`,
  );

  const colunas = linhas.columns?.map((c) => c.name) ?? Object.keys(linhas[0] ?? {});
  return {
    colunas,
    cabecalhos: colunas.map((c) => rotulos.get(c) ?? c),
    linhas: linhas.map((linha) => colunas.map((c) => (linha as Record<string, unknown>)[c])),
  };
}

function condicoes(input: ExportarInput): string {
  const partes: string[] = [];
  if (input.estado) {
    // O estado vem de um enum fechado; validá-lo aqui evita que uma chamada
    // futura o passe de outro sítio sem reparar.
    if (!/^[a-z_]+$/.test(input.estado)) throw new Error('estado inválido');
    partes.push(`status = '${input.estado}'`);
  }
  if (input.bbox) {
    const [oeste, sul, este, norte] = input.bbox.map((n) => {
      if (!Number.isFinite(n)) throw new Error('bbox inválido');
      return n;
    });
    partes.push(`geom && ST_MakeEnvelope(${oeste}, ${sul}, ${este}, ${norte}, 4326)`);
  }
  return partes.length ? `WHERE ${partes.join(' AND ')}` : '';
}

/**
 * Rótulo por nome de coluna.
 *
 * As colunas derivadas (`_txt`, `_accuracy_m`, `_fix_type`, `_source`) ganham
 * um sufixo legível em vez de aparecerem cruas: quem abre o ficheiro no Excel
 * não sabe o que é um `fix_type`.
 */
export function rotulosPorColuna(definition: FormDefinition, idioma: string): Map<string, string> {
  const index = buildIndex(definition);
  const mapa = new Map<string, string>([
    ['record_id', 'Identificador do registo'],
    ['status', 'Estado'],
    ['geom', 'Geometria'],
    ['created_at', 'Criado em'],
    ['updated_at', 'Actualizado em'],
    ['created_by', 'Criado por'],
    ['client_created_at', 'Recolhido em (relógio do telefone)'],
    ['revision_no', 'Revisão'],
    ['server_received_at', 'Recebido no servidor em'],
    ['device_id', 'Dispositivo'],
    ['form_version', 'Versão do formulário'],
    ['idx', 'Índice da instância'],
  ]);

  for (const { field } of index.order) {
    if (field.type === 'note' || field.type === 'group') continue;
    const rotulo = texto(field.label, idioma, field.name);
    mapa.set(field.name, rotulo);
    if (field.type === 'select_multiple') mapa.set(`${field.name}_txt`, `${rotulo} (texto)`);
    if (field.type === 'geopoint' || field.type === 'geotrace' || field.type === 'geoshape') {
      mapa.set(`${field.name}_accuracy_m`, `${rotulo} — precisão (m)`);
      mapa.set(`${field.name}_fix_type`, `${rotulo} — tipo de fixo`);
      mapa.set(`${field.name}_source`, `${rotulo} — origem`);
    }
  }
  return mapa;
}

function texto(rotulo: LocalizedText | undefined, idioma: string, omissao: string): string {
  if (!rotulo) return omissao;
  return rotulo[idioma] ?? rotulo.pt ?? omissao;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CSV com BOM e separador `;`.
 *
 * As duas escolhas são pelo Excel em português: sem BOM, os acentos aparecem
 * partidos; com vírgula como separador, o Excel de uma máquina com locale
 * português mete a linha inteira numa célula. Quem quiser vírgulas passa
 * `separador`.
 */
export function paraCsv(
  resultado: ResultadoTabular,
  opcoes: { separador?: string; bom?: boolean } = {},
): string {
  const separador = opcoes.separador ?? ';';
  const escapar = (valor: unknown): string => {
    if (valor === null || valor === undefined) return '';
    const texto = valor instanceof Date ? valor.toISOString() : String(valor);
    // Um valor que contenha o separador, aspas ou uma quebra de linha tem de
    // ir entre aspas, com as aspas duplicadas.
    return /["\n\r]|[;,\t]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
  };

  const linhas = [
    resultado.cabecalhos.map(escapar).join(separador),
    ...resultado.linhas.map((linha) => linha.map(escapar).join(separador)),
  ];
  // CRLF porque é o que o Excel espera; \n sozinho já lá chegou a partir tabelas.
  return `${opcoes.bom === false ? '' : '﻿'}${linhas.join('\r\n')}\r\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// GeoJSON
// ─────────────────────────────────────────────────────────────────────────────

export interface GeoJson {
  type: 'FeatureCollection';
  /**
   * O CRS não vai no ficheiro: a norma RFC 7946 fixa WGS84 e diz para não o
   * escrever. Quem precisar de outro sistema reprojecta no QGIS.
   */
  features: Array<{
    type: 'Feature';
    id: string;
    geometry: unknown;
    properties: Record<string, unknown>;
  }>;
}

/**
 * GeoJSON pronto a abrir no QGIS (F10.2).
 *
 * A geometria sai do PostGIS já como GeoJSON (`ST_AsGeoJSON`), e não é
 * construída aqui: reconstruí-la em TypeScript seria uma segunda
 * implementação de geometria, com os erros de arredondamento à mistura.
 */
export async function paraGeoJson(input: ExportarInput): Promise<GeoJson> {
  const nome =
    input.vista ??
    viewName({
      project: input.projectKey,
      form: input.formKey,
      version: input.definition.version,
    });

  const rotulos = rotulosPorColuna(input.definition, input.idioma ?? 'pt');
  const linhas = await input.sql.unsafe(
    `SELECT *, ST_AsGeoJSON(geom)::jsonb AS __geometria
     FROM ${VIEWS_SCHEMA}.${quoteIdentifier(nome)}
     ${condicoes(input)}
     ORDER BY updated_at DESC, record_id DESC
     ${input.limite ? `LIMIT ${Math.trunc(input.limite)}` : ''}`,
  );

  return {
    type: 'FeatureCollection',
    features: linhas.map((linha) => {
      const bruta = linha as Record<string, unknown>;
      const propriedades: Record<string, unknown> = {};
      for (const [coluna, valor] of Object.entries(bruta)) {
        // A geometria não se repete nas propriedades, e a coluna interna que a
        // transporta também não sai.
        if (coluna === 'geom' || coluna === '__geometria') continue;
        propriedades[rotulos.get(coluna) ?? coluna] = valor;
      }
      return {
        type: 'Feature' as const,
        id: String(bruta['record_id']),
        geometry: bruta['__geometria'] ?? null,
        properties: propriedades,
      };
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Relatório de qualidade (F10.5)
// ─────────────────────────────────────────────────────────────────────────────

export interface LinhaDeQualidade {
  record_id: string;
  field_id: string;
  accuracy_m: number;
  fix_type: string;
  source: string;
  limiar_m: number | null;
  justificacao: string | null;
  collected_at: string | null;
}

/**
 * Pontos recolhidos acima do limiar de precisão, com a justificação escrita.
 *
 * É o relatório que dá sentido à decisão da ESPECIFICACAO §11: deixar gravar
 * acima do limiar só vale a pena se alguém, depois, puder olhar para o que foi
 * gravado assim e para o que o técnico escreveu.
 */
export async function relatorioDeQualidade(
  sql: postgres.Sql,
  formId: string,
  definition: FormDefinition,
): Promise<LinhaDeQualidade[]> {
  const limiarDoFormulario = definition.settings?.max_accuracy_m ?? null;
  const limiarPorCampo = new Map<string, number | null>(
    collectFields(definition)
      .filter((v) => ['geopoint', 'geotrace', 'geoshape'].includes(v.field.type))
      .map((v) => [
        v.field.id,
        (v.field as { max_accuracy_m?: number }).max_accuracy_m ?? limiarDoFormulario,
      ]),
  );

  const linhas = await sql<
    Array<{
      record_id: string;
      field_id: string;
      accuracy_m: number;
      fix_type: string;
      source: string;
      justificacao: string | null;
      collected_at: Date | null;
    }>
  >`
    SELECT g.record_id, g.field_id, g.accuracy_m, g.fix_type::text, g.source::text,
           v.accuracy_override_reason AS justificacao, g.collected_at
    FROM gps_fixes g
    JOIN records r ON r.id = g.record_id
    LEFT JOIN record_revisions v ON v.id = g.revision_id
    WHERE r.form_id = ${formId} AND r.deleted_at IS NULL
    ORDER BY g.accuracy_m DESC
  `;

  return linhas
    .map((l) => ({
      record_id: l.record_id,
      field_id: l.field_id,
      accuracy_m: Number(l.accuracy_m),
      fix_type: l.fix_type,
      source: l.source,
      limiar_m: limiarPorCampo.get(l.field_id) ?? limiarDoFormulario,
      justificacao: l.justificacao,
      collected_at: l.collected_at ? l.collected_at.toISOString() : null,
    }))
    .filter((l) => l.limiar_m !== null && l.accuracy_m > l.limiar_m);
}
