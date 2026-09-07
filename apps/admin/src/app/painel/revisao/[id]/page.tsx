import Link from 'next/link';
import { collectFields, type FormDefinition } from '@cvforms/form-core';

import { chamarApi } from '@/lib/api';
import { Conflito, type RevisaoEmConflito } from './Conflito';

interface Registo {
  registo: { id: string; form_id: string; status: string; updated_at: string };
  revisao?: { id: string; revision_no: number };
}

interface Conflitos {
  estado: string;
  revisao_corrente: string | null;
  conflitos: Array<{ base_revision_id: string; ramos: number; revisoes: string[] }>;
  revisoes: RevisaoEmConflito[];
}

/**
 * Um registo por rever, com os ramos lado a lado.
 *
 * Os rótulos vêm da versão do formulário com que o registo foi recolhido, e
 * não da corrente: mostrar a resposta de uma pergunta com o texto de outra
 * pergunta é a forma mais fácil de alguém decidir mal com toda a confiança.
 */
export default async function RegistoPorRever({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let registo: Registo | undefined;
  let conflitos: Conflitos | undefined;
  let rotulos: Record<string, string> = {};
  let erro: string | undefined;

  try {
    [registo, conflitos] = await Promise.all([
      chamarApi<Registo>(`/records/${id}`),
      chamarApi<Conflitos>(`/records/${id}/conflitos`),
    ]);
    rotulos = await lerRotulos(registo.registo.form_id);
  } catch (e) {
    erro = (e as Error).message;
  }

  const temConflito = (conflitos?.conflitos.length ?? 0) > 0;

  return (
    <main>
      <h1>Registo {id.slice(0, 8)}</h1>
      <p className="suave">
        Estado: <code>{conflitos?.estado ?? '—'}</code>
      </p>

      {erro ? <p className="erro">{erro}</p> : null}

      {temConflito && conflitos ? (
        <Conflito
          recordId={id}
          revisoes={conflitos.revisoes}
          rotulos={rotulos}
          revisaoCorrente={conflitos.revisao_corrente}
        />
      ) : null}

      {!temConflito && !erro ? (
        <div className="cartao">
          <p>
            Este registo não tem ramos em conflito. Se está em <code>needs_review</code>, é porque a
            validação falhou — a revisão foi gravada à mesma, e o que falta é corrigi-la na app ou
            aceitá-la como está.
          </p>
          <p className="suave">
            Gravar uma revisão com erros é deliberado: recusá-la teria deixado o trabalho preso no
            telefone do técnico.
          </p>
        </div>
      ) : null}

      <p style={{ marginTop: '1.5rem' }}>
        <Link href="/painel/revisao">← Por rever</Link>
      </p>
    </main>
  );
}

/** `id` do campo → rótulo, da versão publicada corrente do formulário. */
async function lerRotulos(formId: string): Promise<Record<string, string>> {
  try {
    const detalhe = await chamarApi<{ versao_corrente: number }>(`/forms/${formId}`);
    const { definicao } = await chamarApi<{ definicao: FormDefinition }>(
      `/forms/${formId}/versions/${detalhe.versao_corrente}`,
    );
    const mapa: Record<string, string> = {};
    for (const { field } of collectFields(definicao)) {
      mapa[field.id] = field.label?.pt ?? field.name;
    }
    return mapa;
  } catch {
    // Sem rótulos mostram-se os `id` dos campos. É pior de ler, mas é honesto
    // — e melhor do que não mostrar o conflito nenhum.
    return {};
  }
}
