import Link from 'next/link';

/**
 * A página que não existe.
 *
 * Sem este ficheiro, o Next tenta pré-desenhar o 404 com o documento do
 * encaminhador antigo e a compilação falha com «<Html> should not be imported
 * outside of pages/_document» — um erro que não tem nada que ver com o que se
 * escreveu.
 */
export default function NaoEncontrado() {
  return (
    <main style={{ textAlign: 'center', paddingTop: '6rem' }}>
      <div className="marca-fita" style={{ margin: '0 auto 1rem' }} />
      <h1>Esta página não existe</h1>
      <p className="suave">
        O endereço está errado, ou o que estava aqui foi arquivado. Nenhum registo se perde por
        causa disto.
      </p>
      <p style={{ marginTop: '1.5rem' }}>
        <Link className="botao" href="/painel">
          Voltar ao painel
        </Link>
      </p>
    </main>
  );
}
