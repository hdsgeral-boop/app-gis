'use client';

import { useMemo, useState } from 'react';
import {
  OPERATORS,
  collectFields,
  describeArity,
  isExpression,
  type Expression,
  type ExpressionArg,
  type ExpressionOperator,
  type FormDefinition,
} from '@cvforms/form-core';

/**
 * Editor de expressões (F2.16).
 *
 * O objectivo é um administrador conseguir escrever um `relevant` sem saber o
 * que é uma AST. Por isso não há aqui uma caixa de texto com JSON: há um
 * operador, e os argumentos que esse operador precisa, cada um podendo ser um
 * campo, um valor escrito à mão, ou outra expressão.
 *
 * A alternativa — deixar escrever XPath como o XLSForm — implicaria um
 * analisador no caminho crítico da publicação e um sítio novo onde as coisas
 * falham em silêncio. A AST é o formato, e este editor escreve-a directamente.
 */

const DESCRICAO: Partial<Record<ExpressionOperator, string>> = {
  '==': 'é igual a',
  '!=': 'é diferente de',
  '<': 'é menor que',
  '<=': 'é menor ou igual a',
  '>': 'é maior que',
  '>=': 'é maior ou igual a',
  between: 'está entre',
  and: 'e (todas as condições)',
  or: 'ou (qualquer condição)',
  not: 'não é verdade que',
  '+': 'soma',
  '-': 'subtrai',
  '*': 'multiplica',
  '/': 'divide',
  round: 'arredonda',
  matches: 'corresponde ao padrão',
  starts_with: 'começa por',
  ends_with: 'termina em',
  contains: 'contém',
  length: 'comprimento de',
  concat: 'junta textos',
  upper: 'em maiúsculas',
  lower: 'em minúsculas',
  trim: 'sem espaços à volta',
  in: 'está na lista',
  selected: 'tem a opção escolhida',
  count: 'número de instâncias de',
  count_selected: 'número de opções escolhidas em',
  sum: 'soma o campo em todas as instâncias de',
  is_null: 'está vazio',
  coalesce: 'o primeiro que não estiver vazio',
  today: 'a data de hoje',
  now: 'o instante actual',
  date_diff_days: 'dias entre',
  distance_m: 'distância em metros entre',
  if: 'se … então … senão',
};

export interface PropsEditor {
  definicao: FormDefinition;
  /** `id` do campo onde a expressão vive; determina o que `$self` significa. */
  campoId: string;
  permiteSelf: boolean;
  valor: Expression | undefined;
  aoMudar(valor: Expression | undefined): void;
}

export function EditorDeExpressao({
  definicao,
  campoId,
  permiteSelf,
  valor,
  aoMudar,
}: PropsEditor) {
  if (!valor) {
    return (
      <button
        type="button"
        className="botao-suave"
        onClick={() => aoMudar({ op: '==', args: ['', ''] })}
      >
        + acrescentar condição
      </button>
    );
  }
  return (
    <div className="expressao">
      <No
        definicao={definicao}
        campoId={campoId}
        permiteSelf={permiteSelf}
        no={valor}
        aoMudar={(novo) => aoMudar(novo as Expression)}
      />
      <button type="button" className="botao-suave perigo" onClick={() => aoMudar(undefined)}>
        remover condição
      </button>
    </div>
  );
}

interface PropsNo {
  definicao: FormDefinition;
  campoId: string;
  permiteSelf: boolean;
  no: ExpressionArg;
  aoMudar(no: ExpressionArg): void;
}

function No({ definicao, campoId, permiteSelf, no, aoMudar }: PropsNo) {
  if (isExpression(no)) {
    return (
      <NoDeOperador
        definicao={definicao}
        campoId={campoId}
        permiteSelf={permiteSelf}
        expressao={no}
        aoMudar={aoMudar}
      />
    );
  }
  return (
    <NoDeValor
      definicao={definicao}
      campoId={campoId}
      permiteSelf={permiteSelf}
      valor={no}
      aoMudar={aoMudar}
    />
  );
}

function NoDeOperador({
  definicao,
  campoId,
  permiteSelf,
  expressao,
  aoMudar,
}: Omit<PropsNo, 'no'> & { expressao: Expression }) {
  const spec = OPERATORS[expressao.op];
  const podeAcrescentar = spec && expressao.args.length < spec.max;
  const podeRemover = spec && expressao.args.length > spec.min;

  return (
    <div className="no-de-operador">
      <div className="linha">
        <select
          value={expressao.op}
          onChange={(e) => {
            const novo = e.target.value as ExpressionOperator;
            aoMudar({ op: novo, args: ajustarAridade(expressao.args, novo) });
          }}
        >
          {Object.keys(OPERATORS).map((op) => (
            <option key={op} value={op}>
              {DESCRICAO[op as ExpressionOperator] ?? op}
            </option>
          ))}
        </select>
        <span className="suave pequeno">{describeArity(expressao.op)} argumento(s)</span>
      </div>

      <div className="argumentos">
        {expressao.args.map((arg, i) => (
          <div key={i} className="argumento">
            <No
              definicao={definicao}
              campoId={campoId}
              permiteSelf={permiteSelf}
              no={arg}
              aoMudar={(novo) => {
                const args = [...expressao.args];
                args[i] = novo;
                aoMudar({ ...expressao, args });
              }}
            />
            {podeRemover ? (
              <button
                type="button"
                className="botao-icone"
                title="remover argumento"
                onClick={() =>
                  aoMudar({ ...expressao, args: expressao.args.filter((_, j) => j !== i) })
                }
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
        {podeAcrescentar ? (
          <button
            type="button"
            className="botao-suave"
            onClick={() => aoMudar({ ...expressao, args: [...expressao.args, ''] })}
          >
            + argumento
          </button>
        ) : null}
      </div>
    </div>
  );
}

type Forma = 'campo' | 'texto' | 'numero' | 'booleano' | 'expressao';

function NoDeValor({
  definicao,
  campoId,
  permiteSelf,
  valor,
  aoMudar,
}: Omit<PropsNo, 'no'> & { valor: ExpressionArg }) {
  const campos = useMemo(
    () =>
      collectFields(definicao)
        .filter((v) => v.field.type !== 'note' && v.field.type !== 'group')
        .map((v) => ({ id: v.field.id, rotulo: v.field.label?.pt ?? v.field.name })),
    [definicao],
  );

  const formaInicial: Forma =
    typeof valor === 'string' && valor.startsWith('$')
      ? 'campo'
      : typeof valor === 'number'
        ? 'numero'
        : typeof valor === 'boolean'
          ? 'booleano'
          : 'texto';
  const [forma, setForma] = useState<Forma>(formaInicial);

  return (
    <div className="no-de-valor">
      <select
        value={forma}
        onChange={(e) => {
          const nova = e.target.value as Forma;
          setForma(nova);
          if (nova === 'campo') aoMudar('');
          else if (nova === 'numero') aoMudar(0);
          else if (nova === 'booleano') aoMudar(true);
          else if (nova === 'expressao') aoMudar({ op: '==', args: ['', ''] });
          else aoMudar('');
        }}
      >
        <option value="campo">um campo</option>
        <option value="texto">texto</option>
        <option value="numero">número</option>
        <option value="booleano">sim / não</option>
        <option value="expressao">outra condição</option>
      </select>

      {forma === 'campo' ? (
        <select
          value={typeof valor === 'string' ? valor : ''}
          onChange={(e) => aoMudar(e.target.value)}
        >
          <option value="">— escolher campo —</option>
          {permiteSelf ? <option value="$self">o valor deste campo</option> : null}
          {campos
            .filter((c) => c.id !== campoId)
            .map((c) => (
              <option key={c.id} value={`$${c.id}`}>
                {c.rotulo}
              </option>
            ))}
        </select>
      ) : null}

      {forma === 'texto' ? (
        <input
          type="text"
          value={typeof valor === 'string' && !valor.startsWith('$') ? valor : ''}
          placeholder="escreve o valor"
          onChange={(e) => aoMudar(e.target.value)}
        />
      ) : null}

      {forma === 'numero' ? (
        <input
          type="number"
          value={typeof valor === 'number' ? valor : 0}
          onChange={(e) => aoMudar(Number(e.target.value))}
        />
      ) : null}

      {forma === 'booleano' ? (
        <select
          value={valor === true ? 'sim' : 'nao'}
          onChange={(e) => aoMudar(e.target.value === 'sim')}
        >
          <option value="sim">sim</option>
          <option value="nao">não</option>
        </select>
      ) : null}
    </div>
  );
}

/** Ajusta a lista de argumentos ao mudar de operador, sem perder o que dá. */
function ajustarAridade(args: ExpressionArg[], op: ExpressionOperator): ExpressionArg[] {
  const spec = OPERATORS[op];
  const proximos = args.slice(0, spec.max === Infinity ? args.length : spec.max);
  while (proximos.length < spec.min) proximos.push('');
  return proximos;
}
