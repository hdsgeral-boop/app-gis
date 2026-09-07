/**
 * Relato de erros do painel (F10.6).
 *
 * O Next.js chama `register()` uma vez, no arranque de cada runtime. É o sítio
 * certo para ligar telemetria — e é o único que apanha um erro que aconteça
 * antes de a primeira página ser servida.
 *
 * Como na API, o `@sentry/nextjs` é carregado dinamicamente e só quando há
 * DSN. Sem DSN isto não faz nada, e sem o pacote instalado também não: o
 * painel arranca na mesma. Uma biblioteca de telemetria que impede o arranque
 * quando não está configurada é uma biblioteca que se acaba por desligar.
 */
export async function register(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  try {
    // Numa variável de propósito: assim o TypeScript não o resolve em tempo de
    // compilação e o pacote é MESMO opcional.
    const especificador = '@sentry/nextjs';
    const Sentry = (await import(especificador)) as {
      init(opcoes: Record<string, unknown>): void;
    };

    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
      // Restrição inegociável 9: nada de dados pessoais. O painel mostra
      // respostas de campo, e um relatório de erro que as levasse consigo era
      // um log com outro nome.
      sendDefaultPii: false,
      beforeSend(evento: Record<string, unknown>) {
        const pedido = evento['request'] as Record<string, unknown> | undefined;
        if (pedido) {
          delete pedido['data'];
          delete pedido['cookies'];
        }
        delete evento['user'];
        return evento;
      },
    });
  } catch {
    // O pacote não está instalado, ou o DSN é inválido. Nem um nem outro são
    // razão para o painel não abrir.
  }
}
