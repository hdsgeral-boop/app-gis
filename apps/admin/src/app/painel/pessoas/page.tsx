import Link from 'next/link';

import { chamarApi } from '@/lib/api';
import { Pessoas, type Equipa, type Papel, type Utilizador } from './Pessoas';

/**
 * Utilizadores, papéis e equipas (F6.5).
 *
 * O que se muda aqui não é a permissão em si: é o que a determina. Tudo o que
 * este ecrã escreve dispara o recálculo de `form_access` por trigger, e é essa
 * tabela que as políticas RLS, as regras do PowerSync e o `/me` lêem. Nenhum
 * dos três é actualizado pela aplicação, e é de propósito — três cópias da
 * mesma regra divergiriam.
 */
export default async function PessoasPage() {
  let utilizadores: Utilizador[] = [];
  let papeis: Papel[] = [];
  let equipas: Equipa[] = [];
  let erro: string | undefined;

  try {
    const [u, p, e] = await Promise.all([
      chamarApi<{ utilizadores: Utilizador[] }>('/admin/users'),
      chamarApi<{ papeis: Papel[] }>('/admin/roles'),
      chamarApi<{ equipas: Equipa[] }>('/admin/teams'),
    ]);
    utilizadores = u.utilizadores;
    papeis = p.papeis;
    equipas = e.equipas;
  } catch (err) {
    erro = (err as Error).message;
  }

  return (
    <main>
      <h1>Pessoas</h1>
      <p className="suave">
        Quem é da organização, que papéis tem e em que equipas está. Para dizer que formulários é
        que cada um recolhe, vai a <Link href="/painel/formularios">Formulários</Link> → o
        formulário → Atribuições.
      </p>

      {erro ? <p className="erro">{erro}</p> : null}

      <Pessoas utilizadores={utilizadores} papeis={papeis} equipas={equipas} />

      <p style={{ marginTop: '1.5rem' }}>
        <Link href="/painel">← Painel</Link>
      </p>
    </main>
  );
}
