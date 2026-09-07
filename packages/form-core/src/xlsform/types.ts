/**
 * O XLSForm, como o `form-core` o vê: linhas e colunas, já lidas.
 *
 * Ler o `.xlsx` binário NÃO é trabalho deste pacote. O `form-core` corre no
 * telefone, onde um leitor de folhas de cálculo não tem nada que fazer, e a
 * regra do repositório é uma dependência a menos. Quem tem o ficheiro — o
 * painel e a API — converte-o nestas linhas e entrega-as aqui.
 */

/** Uma linha de uma folha, por nome de coluna. Valores já em texto. */
export type XlsRow = Record<string, string>;

export interface XlsFormWorkbook {
  survey: XlsRow[];
  choices: XlsRow[];
  settings?: XlsRow[];
}

/** Um problema numa linha concreta do ficheiro, para quem importa ir corrigir. */
export interface XlsFormIssue {
  /** Número da linha na folha, contando o cabeçalho como linha 1. */
  row: number;
  sheet: 'survey' | 'choices' | 'settings';
  column?: string;
  value?: string;
  reason: string;
}
