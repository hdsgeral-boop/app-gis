'use client';

import { useMemo, useState } from 'react';
import {
  criarEstado,
  definirValor,
  eRelevante,
  errosVisiveis,
  evaluateBoolean,
  makeContext,
  marcarTocado,
  mostrarTodosOsErros,
  rotulosDasInstancias,
  acrescentarInstancia,
  removerInstancia,
  texto,
  valorEm,
  type EstadoFormulario,
  type Field,
  type FormDefinition,
} from '@cvforms/form-core';

/**
 * Pré-visualização (F2.17).
 *
 * Corre a MESMA máquina de estado que o telefone — a do `form-core`. Não é uma
 * imitação: a relevância, os cálculos e a validação que se vêem aqui são
 * exactamente os que o técnico vai ver em campo. Uma pré-visualização que
 * fosse uma segunda implementação mentiria mais cedo ou mais tarde, e o
 * momento de descobrir seria no terreno.
 *
 * O que NÃO é igual é a aparência: aqui é HTML, lá é React Native. Isso é
 * apresentação, e é aceitável divergir; o comportamento não.
 */
export function PreVisualizacao({ definicao }: { definicao: FormDefinition }) {
  const inicial = useMemo(() => {
    try {
      return criarEstado(definicao, {});
    } catch {
      return undefined;
    }
  }, [definicao]);
  const [estado, setEstado] = useState<EstadoFormulario | undefined>(inicial);

  // A definição muda a cada tecla no construtor: recomeçar sempre perderia o
  // que já foi escrito na pré-visualização, por isso só se recomeça quando a
  // estrutura de campos muda.
  const assinatura = useMemo(() => JSON.stringify(estruturaDe(definicao)), [definicao]);
  const [ultimaAssinatura, setUltimaAssinatura] = useState(assinatura);
  if (assinatura !== ultimaAssinatura) {
    setUltimaAssinatura(assinatura);
    setEstado(inicial);
  }

  if (!estado) {
    return (
      <p className="suave">A definição ainda não é válida o suficiente para pré-visualizar.</p>
    );
  }

  const seccao = estado.seccoes[estado.seccaoActual];

  return (
    <div className="previsualizacao">
      <div className="telefone">
        {estado.seccoes.length > 1 ? (
          <div className="abas">
            {estado.seccoes.map((s, i) => (
              <button
                key={s.id ?? `solta-${i}`}
                type="button"
                className={i === estado.seccaoActual ? 'aba activa' : 'aba'}
                onClick={() =>
                  setEstado({ ...estado, seccaoActual: i, revisao: estado.revisao + 1 })
                }
              >
                {s.titulo}
              </button>
            ))}
          </div>
        ) : null}

        <div className="ecra">
          <Campos campos={seccao?.campos ?? []} prefixo="" estado={estado} aoMudar={setEstado} />
        </div>

        <div className="rodape-do-telefone">
          <button
            type="button"
            className="botao"
            onClick={() => setEstado(mostrarTodosOsErros(estado))}
          >
            submeter
          </button>
        </div>
      </div>

      <details className="dados">
        <summary>Respostas em JSON, como vão ser gravadas</summary>
        <pre>{JSON.stringify(estado.dados, null, 2)}</pre>
      </details>
    </div>
  );
}

/** Só a estrutura: mudar um rótulo não recomeça o preenchimento. */
function estruturaDe(definicao: FormDefinition): unknown {
  const visitar = (campos: readonly Field[]): unknown[] =>
    campos.map((c) => ({
      id: c.id,
      type: c.type,
      relevant: c.relevant,
      calculation: c.calculation,
      filhos: c.type === 'group' || c.type === 'repeat' ? visitar(c.fields) : undefined,
    }));
  return visitar(definicao.fields);
}

interface PropsCampos {
  campos: readonly Field[];
  prefixo: string;
  estado: EstadoFormulario;
  aoMudar(estado: EstadoFormulario): void;
}

function Campos({ campos, prefixo, estado, aoMudar }: PropsCampos) {
  return (
    <>
      {campos.map((campo) => {
        const caminho = `${prefixo}${campo.id}`;
        if (!eRelevante(estado, caminho)) return null;

        if (campo.type === 'group') {
          return (
            <fieldset key={caminho} className="grupo">
              <legend>{texto(campo.label, estado.idioma, campo.name)}</legend>
              <Campos campos={campo.fields} prefixo={prefixo} estado={estado} aoMudar={aoMudar} />
            </fieldset>
          );
        }

        if (campo.type === 'repeat') {
          const lista = valorEm(estado, caminho);
          const instancias = Array.isArray(lista) ? lista : [];
          const rotulos = rotulosDasInstancias(estado, caminho);
          return (
            <fieldset key={caminho} className="grupo repetivel">
              <legend>
                {texto(campo.label, estado.idioma, campo.name)} ({instancias.length})
              </legend>
              {instancias.map((_, i) => (
                <div key={i} className="instancia">
                  <div className="linha entre">
                    <strong>{rotulos[i] ?? `${i + 1}`}</strong>
                    <button
                      type="button"
                      className="botao-suave perigo"
                      onClick={() => aoMudar(removerInstancia(estado, caminho, i))}
                    >
                      remover
                    </button>
                  </div>
                  <Campos
                    campos={campo.fields}
                    prefixo={`${caminho}[${i}].`}
                    estado={estado}
                    aoMudar={aoMudar}
                  />
                </div>
              ))}
              <button
                type="button"
                className="botao-suave"
                onClick={() => aoMudar(acrescentarInstancia(estado, caminho))}
              >
                + acrescentar
              </button>
            </fieldset>
          );
        }

        return (
          <CampoSimples
            key={caminho}
            campo={campo}
            caminho={caminho}
            estado={estado}
            aoMudar={aoMudar}
          />
        );
      })}
    </>
  );
}

function CampoSimples({
  campo,
  caminho,
  estado,
  aoMudar,
}: {
  campo: Field;
  caminho: string;
  estado: EstadoFormulario;
  aoMudar(estado: EstadoFormulario): void;
}) {
  const valor = valorEm(estado, caminho);
  const erros = errosVisiveis(estado, caminho);
  const mudar = (v: unknown) => aoMudar(definirValor(estado, caminho, v));
  const sair = () => aoMudar(marcarTocado(estado, caminho));

  if (campo.type === 'note') {
    return <p className="nota">{texto(campo.label, estado.idioma, '')}</p>;
  }

  return (
    <label className="campo">
      <span className="rotulo">
        {texto(campo.label, estado.idioma, campo.name)}
        {campo.required ? <em className="obrigatorio"> *</em> : null}
      </span>
      {campo.hint ? (
        <span className="suave pequeno">{texto(campo.hint, estado.idioma, '')}</span>
      ) : null}

      <Entrada campo={campo} estado={estado} valor={valor} mudar={mudar} sair={sair} />

      {erros.map((e, i) => (
        <span key={i} className="erro">
          {e.message}
        </span>
      ))}
    </label>
  );
}

function Entrada({
  campo,
  estado,
  valor,
  mudar,
  sair,
}: {
  campo: Field;
  estado: EstadoFormulario;
  valor: unknown;
  mudar(v: unknown): void;
  sair(): void;
}) {
  const comoTexto = valor === null || valor === undefined ? '' : String(valor);

  switch (campo.type) {
    case 'integer':
    case 'decimal':
      return (
        <input
          type="number"
          value={comoTexto}
          step={campo.type === 'integer' ? 1 : 'any'}
          onChange={(e) => mudar(e.target.value === '' ? null : Number(e.target.value))}
          onBlur={sair}
        />
      );
    case 'boolean':
      return (
        <input
          type="checkbox"
          checked={valor === true}
          onChange={(e) => {
            mudar(e.target.checked);
            sair();
          }}
        />
      );
    case 'date':
      return (
        <input
          type="date"
          value={comoTexto}
          onChange={(e) => mudar(e.target.value || null)}
          onBlur={sair}
        />
      );
    case 'time':
      return (
        <input
          type="time"
          value={comoTexto}
          onChange={(e) => mudar(e.target.value || null)}
          onBlur={sair}
        />
      );
    case 'datetime':
      return (
        <input
          type="datetime-local"
          value={comoTexto.slice(0, 16)}
          onChange={(e) => mudar(e.target.value ? new Date(e.target.value).toISOString() : null)}
          onBlur={sair}
        />
      );
    case 'select_one':
    case 'select_multiple': {
      const lista = estado.definicao.choice_lists?.[campo.choices_ref] ?? [];
      const ctx = makeContext(estado.dados);
      const visiveis = lista.filter((o) => !o.relevant || evaluateBoolean(o.relevant, ctx));
      if (campo.type === 'select_one') {
        return (
          <select
            value={typeof valor === 'string' ? valor : ''}
            onChange={(e) => {
              mudar(e.target.value || null);
              sair();
            }}
          >
            <option value="">—</option>
            {visiveis.map((o) => (
              <option key={o.value} value={o.value}>
                {texto(o.label, estado.idioma, o.value)}
              </option>
            ))}
          </select>
        );
      }
      const escolhidas = Array.isArray(valor) ? (valor as string[]) : [];
      return (
        <span className="opcoes">
          {visiveis.map((o) => (
            <label key={o.value} className="opcao">
              <input
                type="checkbox"
                checked={escolhidas.includes(o.value)}
                onChange={(e) => {
                  mudar(
                    e.target.checked
                      ? [...escolhidas, o.value]
                      : escolhidas.filter((v) => v !== o.value),
                  );
                  sair();
                }}
              />
              {texto(o.label, estado.idioma, o.value)}
            </label>
          ))}
        </span>
      );
    }
    case 'geopoint':
      return (
        <span className="suave pequeno">
          {/* Sem GNSS no browser: um ponto de exemplo chega para ver a
              relevância e os cálculos que dependem dele reagirem. */}
          {valor ? JSON.stringify(valor) : 'sem posição'}{' '}
          <button
            type="button"
            className="botao-suave"
            onClick={() => {
              mudar({
                lat: -8.8383,
                lon: 13.2344,
                accuracy_m: 1.2,
                fix_type: 'single',
                source: 'manual',
              });
              sair();
            }}
          >
            usar ponto de exemplo
          </button>
        </span>
      );
    case 'calculate':
      return <output className="calculado">{comoTexto || '—'}</output>;
    case 'photo':
    case 'audio':
    case 'file':
    case 'signature':
      return <span className="suave pequeno">anexo — capturado no telefone</span>;
    default:
      return (
        <input
          type="text"
          value={comoTexto}
          onChange={(e) => mudar(e.target.value || null)}
          onBlur={sair}
        />
      );
  }
}
