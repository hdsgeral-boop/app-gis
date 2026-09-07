import type { FonteDeLocalizacao } from '@cvforms/form-core';

import { FonteGpsInterno } from './interno';
import { FonteNmeaTcp } from './tcp';
import { abrirSocketNativo } from './tcp-nativo';

/**
 * Que receptor é que a app está a usar (F7.1).
 *
 * Existe um só sítio a decidir isto, e é este. O renderizador recebe uma
 * `FonteDeLocalizacao` e não sabe — nem pode saber — se por trás está o GPS do
 * telefone ou um Emlid ligado por Wi-Fi. Trocar de um para o outro a meio de
 * um levantamento não toca em código de formulário nenhum, que é o que a F7.1
 * pede.
 *
 * A escolha é do técnico e vive nas definições da app. A fonte fica em memória
 * entre chamadas de propósito: uma ligação TCP a um receptor demora a
 * estabelecer, e criar uma nova a cada ponto tornava a recolha inutilizável.
 */

export type TipoDeFonte = 'interno' | 'tcp';

export interface ConfiguracaoDeGnss {
  tipo: TipoDeFonte;
  /** Só para `tcp`. Um Emlid anuncia-se em 192.168.42.1:9001 por omissão. */
  host?: string;
  porto?: number;
}

const POR_OMISSAO: ConfiguracaoDeGnss = { tipo: 'interno' };

let configuracao: ConfiguracaoDeGnss = POR_OMISSAO;
let actual: FonteDeLocalizacao | undefined;

export function configuracaoDeGnss(): ConfiguracaoDeGnss {
  return configuracao;
}

/**
 * Troca de receptor.
 *
 * Fecha o anterior a sério: uma ligação TCP que ficasse aberta continuaria a
 * consumir bateria e a reconectar-se sozinha a um receptor que já ninguém
 * está a usar.
 */
export function definirGnss(nova: ConfiguracaoDeGnss): FonteDeLocalizacao {
  fechar();
  configuracao = nova;
  return fonteDeLocalizacaoActual();
}

export function fonteDeLocalizacaoActual(): FonteDeLocalizacao {
  if (actual) return actual;

  if (configuracao.tipo === 'tcp') {
    const fonte = new FonteNmeaTcp({
      host: configuracao.host ?? '192.168.42.1',
      porto: configuracao.porto ?? 9001,
      abrir: abrirSocketNativo(),
      descricao: `Receptor NMEA (${configuracao.host ?? '192.168.42.1'})`,
    });
    // Ligar sem esperar: o ecrã abre já, e a primeira leitura chega quando o
    // receptor a der. Bloquear aqui deixava o campo de geometria em branco
    // enquanto o Wi-Fi negoceia.
    void fonte.ligar().catch(() => undefined);
    actual = fonte;
    return fonte;
  }

  actual = new FonteGpsInterno();
  return actual;
}

/** Fecha o receptor. O ecrã de formulário chama isto ao sair. */
export function fechar(): void {
  const anterior = actual as { desligar?: () => void } | undefined;
  anterior?.desligar?.();
  actual = undefined;
}
