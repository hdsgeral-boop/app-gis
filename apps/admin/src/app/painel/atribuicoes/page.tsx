import { chamarApi } from '@/lib/api';
import {
  Atribuicoes,
  type Atribuicao,
  type Equipa,
  type Formulario,
  type Papel,
  type Pessoa,
} from './Atribuicoes';

/**
 * Atribuições (F6.3 e F6.4).
 *
 * Um ecrã só, com todos os formulários, em vez de um separador escondido
 * dentro de cada formulário. A pergunta que se faz mais vezes não é «quem tem
 * acesso a este formulário» — é «este técnico novo já tem o que precisa».
 */
export default async function AtribuicoesPage() {
  let formularios: Formulario[] = [];
  let pessoas: Pessoa[] = [];
  let equipas: Equipa[] = [];
  let papeis: Papel[] = [];
  const atribuicoesPorFormulario: Record<string, Atribuicao[]> = {};
  let erro: string | undefined;

  try {
    const [f, u, e, p] = await Promise.all([
      chamarApi<{ formularios: Formulario[] }>('/admin/forms'),
      chamarApi<{ utilizadores: Pessoa[] }>('/admin/users'),
      chamarApi<{ equipas: Equipa[] }>('/admin/teams'),
      chamarApi<{ papeis: Papel[] }>('/admin/roles'),
    ]);
    formularios = f.formularios;
    pessoas = u.utilizadores;
    equipas = e.equipas;
    papeis = p.papeis;

    // Em paralelo: com dez formulários, uma chamada de cada vez seriam dez
    // idas ao servidor em série só para desenhar uma página.
    const listas = await Promise.all(
      formularios.map((form) =>
        chamarApi<{ atribuicoes: Atribuicao[] }>(`/admin/forms/${form.id}/assignments`)
          .then((r) => [form.id, r.atribuicoes] as const)
          .catch(() => [form.id, [] as Atribuicao[]] as const),
      ),
    );
    for (const [id, lista] of listas) atribuicoesPorFormulario[id] = lista;
  } catch (e) {
    erro = (e as Error).message;
  }

  return (
    <main>
      <div className="marca-fita" />
      <h1>Atribuições</h1>
      <p className="suave">
        Quem recolhe o quê, e onde. Sem uma atribuição, um formulário não existe para o técnico —
        nem a definição chega ao telefone. É aplicado pelo Postgres, e não apenas por este ecrã.
      </p>

      {erro ? <p className="erro">{erro}</p> : null}

      <Atribuicoes
        formularios={formularios}
        pessoas={pessoas}
        equipas={equipas}
        papeis={papeis}
        atribuicoesPorFormulario={atribuicoesPorFormulario}
      />
    </main>
  );
}
