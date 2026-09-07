'use client';

/**
 * O último recurso: um erro que rebentou acima de qualquer `error.tsx`.
 *
 * Tem de trazer o seu próprio `<html>` e `<body>` porque substitui o layout
 * raiz inteiro — se o layout foi o que rebentou, não se pode contar com ele.
 *
 * NÃO MOSTRA A MENSAGEM CRUA. Um erro de servidor traz nomes de tabelas e às
 * vezes um URL com senha dentro. O que se mostra é o `digest`, que é o que
 * liga isto à linha do log.
 */
export default function ErroGlobal({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="pt">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          display: 'grid',
          placeItems: 'center',
          minHeight: '100vh',
          margin: 0,
        }}
      >
        <main style={{ textAlign: 'center', maxWidth: '32rem', padding: '2rem' }}>
          <h1 style={{ fontSize: '1.4rem' }}>Alguma coisa correu mal</h1>
          <p style={{ color: '#5b6470' }}>
            O erro ficou registado. Se voltar a acontecer, manda esta referência a quem administra.
          </p>
          {error.digest ? (
            <p style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{error.digest}</p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1.5rem',
              padding: '0.7rem 1.2rem',
              borderRadius: 8,
              border: 0,
              background: '#10508a',
              color: '#fff',
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            Tentar outra vez
          </button>
        </main>
      </body>
    </html>
  );
}
