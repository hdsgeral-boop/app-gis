'use client';

import type { Choice, Field, FormDefinition } from '@cvforms/form-core';

import { EditorDeExpressao } from './EditorDeExpressao';
import { listaNova, NOME_DO_TIPO } from './modelo';

/**
 * Painel de propriedades do campo seleccionado (F2.15).
 *
 * A regra mais importante do ecrã: o `id` é mostrado mas não é editável, e diz
 * porquê. É o que separa esta plataforma do Kobo — renomear uma pergunta muda
 * a coluna da vista e o XLSForm exportado, e nunca toca nos dados já
 * recolhidos (FORM-SPEC §1).
 */

export interface PropsPropriedades {
  definicao: FormDefinition;
  campo: Field;
  aoMudarCampo(campo: Field): void;
  aoMudarDefinicao(definicao: FormDefinition): void;
}

export function Propriedades({
  definicao,
  campo,
  aoMudarCampo,
  aoMudarDefinicao,
}: PropsPropriedades) {
  const alterar = (patch: Partial<Field>): void => aoMudarCampo({ ...campo, ...patch } as Field);

  return (
    <div className="propriedades">
      <header>
        <h3>{campo.label?.pt ?? campo.name}</h3>
        <p className="suave pequeno">{NOME_DO_TIPO[campo.type]}</p>
      </header>

      <label className="campo">
        <span className="rotulo">Pergunta (rótulo)</span>
        <input
          type="text"
          value={campo.label?.pt ?? ''}
          onChange={(e) => alterar({ label: { ...campo.label, pt: e.target.value } })}
        />
      </label>

      <label className="campo">
        <span className="rotulo">Texto de apoio</span>
        <input
          type="text"
          value={campo.hint?.pt ?? ''}
          onChange={(e) =>
            alterar(
              e.target.value
                ? { hint: { ...campo.hint, pt: e.target.value } }
                : ({ hint: undefined } as Partial<Field>),
            )
          }
        />
      </label>

      <label className="campo">
        <span className="rotulo">Nome da coluna</span>
        <input
          type="text"
          value={campo.name}
          pattern="[a-zA-Z_][a-zA-Z0-9_]*"
          onChange={(e) => alterar({ name: e.target.value })}
        />
        <span className="suave pequeno">
          Dá nome à coluna nas vistas do QGIS e ao XLSForm exportado. Mudá-lo nunca perde dados.
        </span>
      </label>

      <div className="campo">
        <span className="rotulo">Identificador</span>
        <code className="identificador">{campo.id}</code>
        <span className="suave pequeno">
          Gerado pelo sistema e imutável: é por ele que as respostas ficam guardadas. Não é
          reutilizado, nem sequer depois de o campo ser apagado.
        </span>
      </div>

      {campo.type !== 'note' && campo.type !== 'group' ? (
        <>
          <label className="linha">
            <input
              type="checkbox"
              checked={campo.required === true}
              onChange={(e) => alterar({ required: e.target.checked })}
            />
            <span>Obrigatório</span>
          </label>
          <label className="linha">
            <input
              type="checkbox"
              checked={campo.searchable === true}
              onChange={(e) => alterar({ searchable: e.target.checked })}
            />
            <span>Pesquisável (cria índice e entra na procura da app)</span>
          </label>
          <label className="linha">
            <input
              type="checkbox"
              checked={campo.projected !== false}
              onChange={(e) => alterar({ projected: e.target.checked })}
            />
            <span>Aparece como coluna nas vistas</span>
          </label>
        </>
      ) : null}

      <PropriedadesDoTipo
        definicao={definicao}
        campo={campo}
        alterar={alterar}
        aoMudarDefinicao={aoMudarDefinicao}
      />

      <section className="bloco">
        <h4>Só aparece quando…</h4>
        <p className="suave pequeno">
          Um campo escondido não é validado nem gravado, mesmo que seja obrigatório.
        </p>
        <EditorDeExpressao
          definicao={definicao}
          campoId={campo.id}
          permiteSelf={false}
          valor={campo.relevant}
          aoMudar={(valor) => alterar({ relevant: valor })}
        />
      </section>

      {campo.type !== 'note' && campo.type !== 'group' && campo.type !== 'repeat' ? (
        <section className="bloco">
          <h4>Só aceita valores em que…</h4>
          <EditorDeExpressao
            definicao={definicao}
            campoId={campo.id}
            permiteSelf
            valor={campo.constraint}
            aoMudar={(valor) => alterar({ constraint: valor })}
          />
          {campo.constraint ? (
            <label className="campo">
              <span className="rotulo">Mensagem quando não cumpre</span>
              <input
                type="text"
                value={campo.constraint_message?.pt ?? ''}
                placeholder="Escreve-a: a mensagem por omissão não ajuda ninguém"
                onChange={(e) =>
                  alterar({
                    constraint_message: { ...campo.constraint_message, pt: e.target.value },
                  })
                }
              />
            </label>
          ) : null}
        </section>
      ) : null}

      {campo.type === 'calculate' ? (
        <section className="bloco">
          <h4>Cálculo</h4>
          <EditorDeExpressao
            definicao={definicao}
            campoId={campo.id}
            permiteSelf={false}
            valor={campo.calculation}
            aoMudar={(valor) =>
              alterar({ calculation: valor ?? { op: 'coalesce', args: ['', ''] } })
            }
          />
        </section>
      ) : null}
    </div>
  );
}

function PropriedadesDoTipo({
  definicao,
  campo,
  alterar,
  aoMudarDefinicao,
}: {
  definicao: FormDefinition;
  campo: Field;
  alterar(patch: Partial<Field>): void;
  aoMudarDefinicao(definicao: FormDefinition): void;
}) {
  switch (campo.type) {
    case 'text':
      return (
        <>
          <label className="campo">
            <span className="rotulo">Comprimento máximo</span>
            <input
              type="number"
              min={1}
              value={campo.max_length ?? ''}
              onChange={(e) =>
                alterar({ max_length: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </label>
          <label className="linha">
            <input
              type="checkbox"
              checked={campo.multiline === true}
              onChange={(e) => alterar({ multiline: e.target.checked })}
            />
            <span>Várias linhas</span>
          </label>
        </>
      );

    case 'integer':
    case 'decimal':
      return (
        <div className="linha">
          <label className="campo">
            <span className="rotulo">Mínimo</span>
            <input
              type="number"
              value={campo.min ?? ''}
              onChange={(e) =>
                alterar({ min: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </label>
          <label className="campo">
            <span className="rotulo">Máximo</span>
            <input
              type="number"
              value={campo.max ?? ''}
              onChange={(e) =>
                alterar({ max: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </label>
        </div>
      );

    case 'select_one':
    case 'select_multiple':
      return (
        <ListaDeEscolhas
          definicao={definicao}
          campo={campo}
          alterar={alterar}
          aoMudarDefinicao={aoMudarDefinicao}
        />
      );

    case 'repeat':
      return (
        <div className="linha">
          <label className="campo">
            <span className="rotulo">Mínimo de instâncias</span>
            <input
              type="number"
              min={0}
              value={campo.min ?? ''}
              onChange={(e) =>
                alterar({ min: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </label>
          <label className="campo">
            <span className="rotulo">Máximo</span>
            <input
              type="number"
              min={1}
              value={campo.max ?? ''}
              onChange={(e) =>
                alterar({ max: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </label>
        </div>
      );

    case 'geopoint':
    case 'geotrace':
    case 'geoshape':
      return (
        <label className="campo">
          <span className="rotulo">Precisão máxima aceite (m)</span>
          <input
            type="number"
            step="0.1"
            min={0}
            value={campo.max_accuracy_m ?? ''}
            placeholder={String(definicao.settings?.max_accuracy_m ?? 'sem limiar')}
            onChange={(e) =>
              alterar({ max_accuracy_m: e.target.value ? Number(e.target.value) : undefined })
            }
          />
          <span className="suave pequeno">
            Acima do limiar a app avisa e só grava com justificação escrita, que fica na revisão.
          </span>
        </label>
      );

    case 'photo':
      return (
        <div className="linha">
          <label className="campo">
            <span className="rotulo">Máximo de fotografias</span>
            <input
              type="number"
              min={1}
              value={campo.max_count ?? ''}
              onChange={(e) =>
                alterar({ max_count: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </label>
          <label className="campo">
            <span className="rotulo">Lado maior, em pixéis</span>
            <input
              type="number"
              min={320}
              value={campo.max_dimension_px ?? ''}
              placeholder="1600"
              onChange={(e) =>
                alterar({ max_dimension_px: e.target.value ? Number(e.target.value) : undefined })
              }
            />
            <span className="suave pequeno">
              Redimensionada no telefone, antes de entrar na fila.
            </span>
          </label>
        </div>
      );

    case 'reference':
      return (
        <label className="campo">
          <span className="rotulo">Formulário apontado</span>
          <input
            type="text"
            value={campo.target_form_id}
            placeholder="UUID do formulário"
            onChange={(e) => alterar({ target_form_id: e.target.value })}
          />
        </label>
      );

    default:
      return null;
  }
}

function ListaDeEscolhas({
  definicao,
  campo,
  alterar,
  aoMudarDefinicao,
}: {
  definicao: FormDefinition;
  campo: Field & { choices_ref: string; allow_other?: boolean };
  alterar(patch: Partial<Field>): void;
  aoMudarDefinicao(definicao: FormDefinition): void;
}) {
  const listas = definicao.choice_lists ?? {};
  const opcoes = listas[campo.choices_ref] ?? [];

  const gravarOpcoes = (proximas: Choice[]): void => {
    aoMudarDefinicao({
      ...definicao,
      choice_lists: { ...listas, [campo.choices_ref]: proximas },
    });
  };

  return (
    <section className="bloco">
      <div className="linha entre">
        <label className="campo">
          <span className="rotulo">Lista de opções</span>
          <select
            value={campo.choices_ref}
            onChange={(e) => alterar({ choices_ref: e.target.value } as Partial<Field>)}
          >
            {Object.keys(listas).map((chave) => (
              <option key={chave} value={chave}>
                {chave}
              </option>
            ))}
            {listas[campo.choices_ref] ? null : (
              <option value={campo.choices_ref}>{campo.choices_ref} (nova)</option>
            )}
          </select>
        </label>
        <button
          type="button"
          className="botao-suave"
          onClick={() => {
            const chave = listaNova(definicao);
            aoMudarDefinicao({ ...definicao, choice_lists: { ...listas, [chave]: [] } });
            alterar({ choices_ref: chave } as Partial<Field>);
          }}
        >
          nova lista
        </button>
      </div>

      <table className="opcoes">
        <thead>
          <tr>
            <th>Valor guardado</th>
            <th>Rótulo visível</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {opcoes.map((opcao, i) => (
            <tr key={i}>
              <td>
                <input
                  type="text"
                  value={opcao.value}
                  onChange={(e) => {
                    const proximas = [...opcoes];
                    proximas[i] = { ...opcao, value: e.target.value };
                    gravarOpcoes(proximas);
                  }}
                />
              </td>
              <td>
                <input
                  type="text"
                  value={opcao.label?.pt ?? ''}
                  onChange={(e) => {
                    const proximas = [...opcoes];
                    proximas[i] = { ...opcao, label: { ...opcao.label, pt: e.target.value } };
                    gravarOpcoes(proximas);
                  }}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="botao-icone"
                  onClick={() => gravarOpcoes(opcoes.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        className="botao-suave"
        onClick={() =>
          gravarOpcoes([...opcoes, { value: `opcao_${opcoes.length + 1}`, label: { pt: '' } }])
        }
      >
        + opção
      </button>
      <p className="suave pequeno">
        O valor guardado nunca deve mudar depois de haver dados; o rótulo pode mudar à vontade.
      </p>

      <label className="linha">
        <input
          type="checkbox"
          checked={campo.allow_other === true}
          onChange={(e) => alterar({ allow_other: e.target.checked } as Partial<Field>)}
        />
        <span>Permitir escrever uma resposta fora da lista</span>
      </label>
    </section>
  );
}
