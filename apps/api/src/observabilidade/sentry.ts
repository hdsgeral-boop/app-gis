/**
 * Relato de erros (F10.6).
 *
 * DUAS DECISÕES QUE GOVERNAM ESTE FICHEIRO:
 *
 * 1. **Sem DSN, isto não faz nada — e isso é o normal.** Em desenvolvimento,
 *    em CI e num arranque de demonstração ninguém tem conta no Sentry. Uma
 *    biblioteca de telemetria que rebenta o arranque quando não está
 *    configurada é uma biblioteca que se acaba por arrancar.
 *
 * 2. **O que sai daqui não leva dados de campo.** A restrição inegociável 9 diz
 *    «nada de dados pessoais em logs», e um relatório de erro é um log com
 *    outro nome. O corpo dos pedidos, as respostas dos formulários e os
 *    cabeçalhos de autorização nunca entram — o que vai é o que serve para
 *    encontrar o defeito: a rota, o tipo de erro, e a organização.
 *
 * O `@sentry/node` é carregado dinamicamente e só quando há DSN. Assim a
 * dependência é opcional a sério: quem clonar o repositório e correr `pnpm
 * install --prod` sem ela não fica com uma API que não arranca.
 */

type Sentry = {
  init(opcoes: Record<string, unknown>): void;
  captureException(erro: unknown, contexto?: Record<string, unknown>): void;
  captureMessage(mensagem: string, contexto?: Record<string, unknown>): void;
};

let sentry: Sentry | undefined;
let activo = false;

export interface OpcoesDeSentry {
  dsn: string;
  ambiente: string;
  /** Percentagem de pedidos com traço. 0 desliga o traçado. */
  amostragem?: number;
  versao?: string;
}

/**
 * Arranca o relato de erros. Devolve `false` quando não há DSN, e isso não é
 * uma falha — é o caso normal fora de produção.
 */
export async function iniciarSentry(opcoes: OpcoesDeSentry | undefined): Promise<boolean> {
  if (!opcoes?.dsn) return false;
  try {
    // O especificador vai numa variável de propósito: assim o TypeScript não
    // o resolve em tempo de compilação e o pacote é MESMO opcional — quem não
    // o instalar continua a compilar e a arrancar.
    const especificador = '@sentry/node';
    const modulo = (await import(especificador)) as unknown as Sentry;
    modulo.init({
      dsn: opcoes.dsn,
      environment: opcoes.ambiente,
      release: opcoes.versao,
      tracesSampleRate: opcoes.amostragem ?? 0,
      // Restrição 9: nada de PII. O Sentry, por omissão, apanha endereços IP e
      // cookies; aqui não apanha.
      sendDefaultPii: false,
      beforeSend: (evento: Record<string, unknown>) => limpar(evento),
    });
    sentry = modulo;
    activo = true;
    return true;
  } catch {
    // A dependência não está instalada, ou o DSN é inválido. Nenhum dos dois é
    // razão para a API não arrancar.
    return false;
  }
}

export function sentryActivo(): boolean {
  return activo;
}

export function capturarErro(erro: unknown, contexto: Record<string, unknown> = {}): void {
  if (!activo || !sentry) return;
  sentry.captureException(erro, { extra: contexto });
}

export function capturarAviso(mensagem: string, contexto: Record<string, unknown> = {}): void {
  if (!activo || !sentry) return;
  sentry.captureMessage(mensagem, { level: 'warning', extra: contexto });
}

/**
 * Tira do evento tudo o que possa ser resposta de campo ou credencial.
 *
 * Faz-se aqui e não por configuração porque uma versão nova do SDK pode passar
 * a incluir mais um campo por omissão, e um `beforeSend` que remove por lista
 * explícita continua a valer nesse dia.
 */
function limpar(evento: Record<string, unknown>): Record<string, unknown> {
  const pedido = evento['request'] as Record<string, unknown> | undefined;
  if (pedido) {
    delete pedido['data'];
    delete pedido['cookies'];
    const cabecalhos = pedido['headers'] as Record<string, unknown> | undefined;
    if (cabecalhos) {
      delete cabecalhos['authorization'];
      delete cabecalhos['cookie'];
      delete cabecalhos['x-api-key'];
    }
  }
  delete evento['user'];
  return evento;
}
