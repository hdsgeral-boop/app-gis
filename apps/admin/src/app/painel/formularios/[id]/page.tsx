import Link from 'next/link';
import type { FormDefinition } from '@cvforms/form-core';

import { Construtor } from '@/componentes/construtor/Construtor';
import { chamarApi } from '@/lib/api';

/**
 * O construtor de um formulário.
 *
 * Carrega no servidor a última versão que existir — publicada ou rascunho — e
 * entrega-a ao construtor, que a partir daí trabalha no browser e fala com a
 * API pela ponte em `/api/cvforms`.
 */
export default async function Formulario({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let definicao: FormDefinition | undefined;
  let formulario:
    { key: string; titulo: Record<string, string>; versao_corrente: number | null } | undefined;
  let erro: string | undefined;

  try {
    const lista = await chamarApi<{
      formularios: Array<{
        id: string;
        key: string;
        titulo: Record<string, string>;
        versao_corrente: number | null;
      }>;
    }>('/admin/forms');
    const encontrado = lista.formularios.find((f) => f.id === id);
    if (!encontrado) throw new Error('formulário inexistente nesta organização');
    formulario = encontrado;

    try {
      definicao = await chamarApi<FormDefinition>(`/admin/forms/${id}/export?format=json`);
    } catch {
      // Ainda não tem nenhuma versão: começa-se de uma definição vazia, com o
      // título que o formulário já tem.
      definicao = undefined;
    }
  } catch (e) {
    erro = (e as Error).message;
  }

  if (erro || !formulario) {
    return (
      <main>
        <h1>Construtor</h1>
        <p className="erro">{erro ?? 'não foi possível carregar o formulário'}</p>
        <Link href="/painel/formularios">← voltar</Link>
      </main>
    );
  }

  const inicial: FormDefinition = definicao ?? {
    spec_version: 1,
    form_id: id,
    version: (formulario.versao_corrente ?? 0) + 1,
    title: { pt: formulario.titulo?.pt ?? formulario.key },
    fields: [],
  };

  return (
    <main className="largo">
      <div className="linha entre">
        <div>
          <h1>{formulario.titulo?.pt ?? formulario.key}</h1>
          <p className="suave">
            {formulario.versao_corrente
              ? `versão ${formulario.versao_corrente} publicada`
              : 'ainda não publicado — não aparece em telefone nenhum'}
          </p>
        </div>
        <Link className="botao-suave" href="/painel/formularios">
          ← formulários
        </Link>
      </div>

      <Construtor
        formId={id}
        formKey={formulario.key}
        versaoPublicada={formulario.versao_corrente}
        definicaoInicial={inicial}
      />
    </main>
  );
}
