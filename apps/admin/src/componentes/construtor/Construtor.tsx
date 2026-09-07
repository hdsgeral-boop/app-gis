'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  validateDefinition,
  type Field,
  type FieldType,
  type FormDefinition,
  type ValidationIssue,
} from '@cvforms/form-core';

import { PreVisualizacao } from './PreVisualizacao';
import { Propriedades } from './Propriedades';
import {
  FAMILIAS,
  NOME_DO_TIPO,
  acrescentarCampo,
  campoEm,
  campoNovo,
  moverCampo,
  removerCampo,
  substituirCampo,
  type Caminho,
} from './modelo';

/**
 * O construtor de formulários (F2.15 a F2.18).
 *
 * Três painéis: a árvore à esquerda, as propriedades do campo escolhido ao
 * centro, e a pré-visualização à direita — a mesma que corre no telefone.
 *
 * Não há aqui nenhum editor de JSON. Um administrador que tenha de escrever
 * JSON para pôr um formulário no terreno não está a usar uma plataforma, está
 * a programar; e nesse caso toda esta camada não serve para nada.
 */

interface Alteracao {
  code: string;
  classification: 'compativel' | 'incompativel';
  message: string;
  path: string;
}

export interface PropsConstrutor {
  formId: string;
  formKey: string;
  versaoPublicada: number | null;
  definicaoInicial: FormDefinition;
}

export function Construtor({
  formId,
  formKey,
  versaoPublicada,
  definicaoInicial,
}: PropsConstrutor) {
  const [definicao, setDefinicao] = useState<FormDefinition>(definicaoInicial);
  const [seleccionado, setSeleccionado] = useState<Caminho>([]);
  const [estado, setEstado] = useState<string>();
  const [aTrabalhar, setATrabalhar] = useState(false);
  const [alteracoes, setAlteracoes] = useState<Alteracao[] | undefined>();

  const problemas: ValidationIssue[] = useMemo(() => {
    try {
      return validateDefinition(definicao).issues;
    } catch (e) {
      return [
        {
          code: 'definicao_corrompida',
          severity: 'erro',
          path: '',
          message: e instanceof Error ? e.message : String(e),
        },
      ];
    }
  }, [definicao]);
  const erros = problemas.filter((p) => p.severity === 'erro');

  const campo = campoEm(definicao, seleccionado);

  const guardar = useCallback(async () => {
    setATrabalhar(true);
    setEstado(undefined);
    try {
      const resposta = await fetch(`/api/cvforms/admin/forms/${formId}/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definicao }),
      });
      const corpo = await resposta.json();
      setEstado(
        resposta.ok
          ? `rascunho guardado como versão ${corpo.versao}${corpo.valido ? '' : ' (com problemas por resolver)'}`
          : `não foi possível guardar: ${corpo.message ?? resposta.status}`,
      );
    } catch (e) {
      setEstado(`não foi possível guardar: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setATrabalhar(false);
    }
  }, [definicao, formId]);

  const verDiff = useCallback(async () => {
    setATrabalhar(true);
    setEstado(undefined);
    try {
      const proxima = (versaoPublicada ?? 0) + 1;
      const resposta = await fetch(`/api/cvforms/admin/forms/${formId}/versions/${proxima}/diff`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definicao }),
      });
      const corpo = await resposta.json();
      setAlteracoes(corpo.alteracoes ?? []);
      if (corpo.primeira_versao) setEstado('primeira versão: não há nada com que comparar');
    } finally {
      setATrabalhar(false);
    }
  }, [definicao, formId, versaoPublicada]);

  const publicar = useCallback(
    async (confirmarIncompativel: boolean) => {
      setATrabalhar(true);
      setEstado(undefined);
      try {
        const resposta = await fetch(`/api/cvforms/admin/forms/${formId}/publish`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            definicao,
            ...(confirmarIncompativel ? { confirmar_incompativel: true } : {}),
          }),
        });
        const corpo = await resposta.json();

        if (resposta.ok) {
          setAlteracoes(undefined);
          setEstado(
            `versão ${corpo.versao} publicada · ${corpo.vistas?.length ?? 0} vista(s) geradas: ` +
              (corpo.vistas ?? []).map((v: { nome: string }) => v.nome).join(', '),
          );
          return;
        }
        if (resposta.status === 409 && corpo.diff) {
          setAlteracoes(corpo.diff.entries);
          setEstado('há alterações incompatíveis: lê-as e confirma explicitamente para publicar');
          return;
        }
        setEstado(
          `não foi possível publicar: ${
            (corpo.problemas ?? []).map((p: { message: string }) => p.message).join(' · ') ||
            corpo.message ||
            resposta.status
          }`,
        );
      } catch (e) {
        setEstado(`não foi possível publicar: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setATrabalhar(false);
      }
    },
    [definicao, formId],
  );

  const incompativeis = (alteracoes ?? []).filter((a) => a.classification === 'incompativel');

  return (
    <div className="construtor">
      <aside className="arvore">
        <div className="linha entre">
          <h2>Campos</h2>
          <span className="suave pequeno">{formKey}</span>
        </div>

        <Arvore
          campos={definicao.fields}
          caminho={[]}
          seleccionado={seleccionado}
          aoSeleccionar={setSeleccionado}
          aoMover={(c, d) => setDefinicao(moverCampo(definicao, c, d))}
          aoRemover={(c) => {
            setDefinicao(removerCampo(definicao, c));
            setSeleccionado([]);
          }}
        />

        <Acrescentar
          definicao={definicao}
          destino={destinoDe(definicao, seleccionado)}
          aoAcrescentar={(tipo, rotulo) => {
            const pai = destinoDe(definicao, seleccionado);
            const novo = campoNovo(tipo, rotulo, definicao, pai);
            setDefinicao(acrescentarCampo(definicao, pai, novo));
          }}
        />

        <section className="bloco">
          <h3>Definições gerais</h3>
          <label className="campo">
            <span className="rotulo">Título</span>
            <input
              type="text"
              value={definicao.title?.pt ?? ''}
              onChange={(e) =>
                setDefinicao({ ...definicao, title: { ...definicao.title, pt: e.target.value } })
              }
            />
          </label>
          <label className="campo">
            <span className="rotulo">Campo que alimenta o mapa</span>
            <select
              value={definicao.settings?.geometry_field ?? ''}
              onChange={(e) =>
                setDefinicao({
                  ...definicao,
                  settings: {
                    ...definicao.settings,
                    ...(e.target.value
                      ? { geometry_field: e.target.value }
                      : { geometry_field: undefined }),
                  },
                })
              }
            >
              <option value="">— nenhum —</option>
              {definicao.fields
                .filter((f) => f.type === 'geopoint')
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label?.pt ?? f.name}
                  </option>
                ))}
            </select>
            <span className="suave pequeno">
              Sem ele, o registo não aparece no mapa nem responde a consultas por área.
            </span>
          </label>
          <label className="campo">
            <span className="rotulo">Precisão máxima aceite (m)</span>
            <input
              type="number"
              step="0.1"
              min={0}
              value={definicao.settings?.max_accuracy_m ?? ''}
              onChange={(e) =>
                setDefinicao({
                  ...definicao,
                  settings: {
                    ...definicao.settings,
                    max_accuracy_m: e.target.value ? Number(e.target.value) : undefined,
                  },
                })
              }
            />
          </label>
        </section>
      </aside>

      <section className="centro">
        {campo ? (
          <Propriedades
            definicao={definicao}
            campo={campo}
            aoMudarCampo={(novo) => setDefinicao(substituirCampo(definicao, seleccionado, novo))}
            aoMudarDefinicao={setDefinicao}
          />
        ) : (
          <p className="suave">Escolhe um campo à esquerda, ou acrescenta um novo.</p>
        )}
      </section>

      <section className="direita">
        <h2>Pré-visualização</h2>
        <p className="suave pequeno">
          Corre a mesma máquina de estado do telefone: a relevância, os cálculos e a validação são
          exactamente os que o técnico vai ver.
        </p>
        <PreVisualizacao definicao={definicao} />
      </section>

      <footer className="barra">
        <div className="expandir">
          {erros.length > 0 ? (
            <details className="problemas" open>
              <summary>{erros.length} problema(s) impedem publicar</summary>
              <ul>
                {problemas.map((p, i) => (
                  <li key={i} className={p.severity === 'erro' ? 'erro' : 'aviso'}>
                    <code>{p.path}</code> {p.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <span className="suave">
              A definição está válida.
              {problemas.length > 0 ? ` ${problemas.length} aviso(s).` : ''}
            </span>
          )}
          {estado ? <p className="estado">{estado}</p> : null}
        </div>

        <button type="button" className="botao-suave" disabled={aTrabalhar} onClick={guardar}>
          guardar rascunho
        </button>
        <button type="button" className="botao-suave" disabled={aTrabalhar} onClick={verDiff}>
          ver alterações
        </button>
        <button
          type="button"
          className="botao"
          disabled={aTrabalhar || erros.length > 0}
          onClick={() => publicar(false)}
        >
          publicar
        </button>
      </footer>

      {alteracoes ? (
        <div className="alteracoes">
          <h3>Alterações desde a versão publicada</h3>
          {alteracoes.length === 0 ? (
            <p className="suave">Nada mudou.</p>
          ) : (
            <ul>
              {alteracoes.map((a, i) => (
                <li key={i} className={a.classification}>
                  <strong>
                    {a.classification === 'incompativel' ? 'Incompatível' : 'Compatível'}
                  </strong>{' '}
                  {a.message}
                </li>
              ))}
            </ul>
          )}
          {incompativeis.length > 0 ? (
            <div className="confirmacao">
              <p>
                {incompativeis.length} alteração(ões) incompatíveis. Publicar não reescreve nem
                apaga nenhum registo já recolhido, mas os dados dos campos afectados deixam de
                aparecer nas vistas.
              </p>
              <button
                type="button"
                className="botao perigo"
                disabled={aTrabalhar}
                onClick={() => publicar(true)}
              >
                percebi, publicar mesmo assim
              </button>
            </div>
          ) : null}
          <button type="button" className="botao-suave" onClick={() => setAlteracoes(undefined)}>
            fechar
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Onde um campo novo é acrescentado: dentro do contentor escolhido, ou na raiz. */
function destinoDe(definicao: FormDefinition, seleccionado: Caminho): Caminho {
  const campo = campoEm(definicao, seleccionado);
  if (campo && (campo.type === 'group' || campo.type === 'repeat')) return seleccionado;
  return seleccionado.slice(0, -1);
}

function Arvore({
  campos,
  caminho,
  seleccionado,
  aoSeleccionar,
  aoMover,
  aoRemover,
}: {
  campos: readonly Field[];
  caminho: Caminho;
  seleccionado: Caminho;
  aoSeleccionar(caminho: Caminho): void;
  aoMover(caminho: Caminho, direccao: -1 | 1): void;
  aoRemover(caminho: Caminho): void;
}) {
  return (
    <ul className="lista-de-campos">
      {campos.map((campo, i) => {
        const meu = [...caminho, i];
        const activo = meu.join('.') === seleccionado.join('.');
        return (
          <li key={campo.id}>
            <div className={activo ? 'no activo' : 'no'}>
              <button type="button" className="nome" onClick={() => aoSeleccionar(meu)}>
                {campo.label?.pt || campo.name}
                <span className="suave pequeno"> · {NOME_DO_TIPO[campo.type]}</span>
              </button>
              <span className="accoes">
                <button
                  type="button"
                  className="botao-icone"
                  title="subir"
                  onClick={() => aoMover(meu, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="botao-icone"
                  title="descer"
                  onClick={() => aoMover(meu, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="botao-icone perigo"
                  title="remover"
                  onClick={() => aoRemover(meu)}
                >
                  ×
                </button>
              </span>
            </div>
            {campo.type === 'group' || campo.type === 'repeat' ? (
              <Arvore
                campos={campo.fields}
                caminho={meu}
                seleccionado={seleccionado}
                aoSeleccionar={aoSeleccionar}
                aoMover={aoMover}
                aoRemover={aoRemover}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Acrescentar({
  definicao,
  destino,
  aoAcrescentar,
}: {
  definicao: FormDefinition;
  destino: Caminho;
  aoAcrescentar(tipo: FieldType, rotulo: string): void;
}) {
  const [tipo, setTipo] = useState<FieldType>('text');
  const [rotulo, setRotulo] = useState('');
  const contentor = campoEm(definicao, destino);

  return (
    <section className="bloco acrescentar">
      <h3>Acrescentar campo</h3>
      <p className="suave pequeno">
        {contentor ? `dentro de "${contentor.label?.pt ?? contentor.name}"` : 'no nível de topo'}
      </p>
      <input
        type="text"
        value={rotulo}
        placeholder="A pergunta, tal como o técnico a vai ler"
        onChange={(e) => setRotulo(e.target.value)}
      />
      <select value={tipo} onChange={(e) => setTipo(e.target.value as FieldType)}>
        {FAMILIAS.map((familia) => (
          <optgroup key={familia.titulo} label={familia.titulo}>
            {familia.tipos.map((t) => (
              <option key={t} value={t}>
                {NOME_DO_TIPO[t]}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <button
        type="button"
        className="botao-suave"
        disabled={rotulo.trim() === ''}
        onClick={() => {
          aoAcrescentar(tipo, rotulo.trim());
          setRotulo('');
        }}
      >
        + acrescentar
      </button>
    </section>
  );
}
