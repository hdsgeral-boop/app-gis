import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { BaseLocal } from '@/forms/definicoes';
import {
  ESQUEMA_DOS_ANEXOS,
  anexosSeguroApagar,
  enfileirarAnexo,
  marcarLocalApagado,
  podeEnviar,
  processarAnexos,
  resumoDosAnexos,
  type AnexoNaFila,
  type ClienteDeAnexos,
} from './anexos.js';

/**
 * F9.2, F9.4, F9.5 e F9.7 — a fila dos anexos.
 *
 * O que se prova: que a política de rede é respeitada, que um upload
 * interrompido retoma sem duplicar, e que um ficheiro local nunca se apaga
 * antes de o servidor o confirmar.
 */

function abrir(): BaseLocal {
  const db = new DatabaseSync(':memory:');
  db.exec(ESQUEMA_DOS_ANEXOS);
  return {
    async runAsync(source: string, params: unknown[] = []) {
      if (params.length === 0 && source.includes('CREATE TABLE')) {
        db.exec(source);
        return {};
      }
      return db.prepare(source).run(...(params as never[]));
    },
    async getFirstAsync<T>(source: string, params: unknown[] = []) {
      return (db.prepare(source).get(...(params as never[])) as T) ?? null;
    },
    async getAllAsync<T>(source: string, params: unknown[] = []) {
      return db.prepare(source).all(...(params as never[])) as T[];
    },
  };
}

const WIFI = { wifi: true, permitirDadosMoveis: false };
const DADOS_MOVEIS = { wifi: false, permitirDadosMoveis: false };

async function enfileirar(db: BaseLocal, id: string, hash = `${id.padEnd(64, '0')}`) {
  await enfileirarAnexo(db, {
    id,
    recordId: 'r1',
    fieldId: 'f_foto',
    localUri: `file:///fotos/${id}.jpg`,
    mimeType: 'image/jpeg',
    bytes: 2_000_000,
    hash,
  });
}

/** Cliente controlado: cada teste programa o que o servidor responde. */
function cliente(
  opcoes: {
    jaExiste?: boolean;
    falharNoEnvio?: boolean;
    falharNoCompletar?: boolean;
  } = {},
): ClienteDeAnexos & { presigns: string[]; envios: string[]; completos: string[] } {
  const registo = {
    presigns: [] as string[],
    envios: [] as string[],
    completos: [] as string[],
    async presign(anexo: AnexoNaFila) {
      registo.presigns.push(anexo.hash);
      return opcoes.jaExiste
        ? { jaExiste: true }
        : { jaExiste: false, url: 'https://armazenamento/objecto?assinatura', cabecalhos: {} };
    },
    async enviar(anexo: AnexoNaFila) {
      registo.envios.push(anexo.id);
      if (opcoes.falharNoEnvio) throw new Error('ligação cortada a meio do upload');
    },
    async completar(anexo: AnexoNaFila) {
      registo.completos.push(anexo.id);
      if (opcoes.falharNoCompletar) throw new Error('o servidor não confirmou');
    },
  };
  return registo;
}

describe('F9.4 — só por Wi-Fi, por omissão', () => {
  let db: BaseLocal;
  beforeEach(() => {
    db = abrir();
  });

  it('a decisão é só isto', () => {
    expect(podeEnviar({ wifi: true, permitirDadosMoveis: false })).toBe(true);
    expect(podeEnviar({ wifi: false, permitirDadosMoveis: false })).toBe(false);
    // O técnico decide gastar dados. É opção dele, não do sistema.
    expect(podeEnviar({ wifi: false, permitirDadosMoveis: true })).toBe(true);
  });

  it('sem Wi-Fi, não se envia nada — e diz-se porquê', async () => {
    await enfileirar(db, 'a1');
    const transporte = cliente();
    const resultado = await processarAnexos(db, transporte, DADOS_MOVEIS);

    expect(resultado.travadoPelaRede).toBe(true);
    expect(resultado.adiados).toBe(1);
    expect(transporte.presigns).toHaveLength(0);
  });

  it('com Wi-Fi, sobe', async () => {
    await enfileirar(db, 'a1');
    const resultado = await processarAnexos(db, cliente(), WIFI);
    expect(resultado.enviados).toBe(1);
  });
});

describe('F9.6 — o servidor já tem o ficheiro', () => {
  it('não se envia nada, e o anexo fica concluído', async () => {
    const db = abrir();
    await enfileirar(db, 'a1');
    const transporte = cliente({ jaExiste: true });

    const resultado = await processarAnexos(db, transporte, WIFI);
    expect(resultado.jaExistiam).toBe(1);
    // Nem um byte de rede: é a diferença entre subir 30 fotos e subir 3.
    expect(transporte.envios).toHaveLength(0);
    expect((await resumoDosAnexos(db)).concluidos).toBe(1);
  });
});

describe('F9.5 — corte a meio do upload', () => {
  let db: BaseLocal;
  beforeEach(() => {
    db = abrir();
  });

  it('um envio cortado volta a ser tentado, com o mesmo hash', async () => {
    await enfileirar(db, 'a1');

    const primeira = cliente({ falharNoEnvio: true });
    const falhou = await processarAnexos(db, primeira, WIFI);
    expect(falhou.falhados).toBe(1);

    const segunda = cliente();
    const resultado = await processarAnexos(db, segunda, WIFI);
    expect(resultado.enviados).toBe(1);
    // O mesmo hash nas duas tentativas: é por ele que o servidor deduplica, e
    // é isso que impede um retry de criar um segundo ficheiro.
    expect(segunda.presigns[0]).toBe(primeira.presigns[0]);
  });

  it('o motivo da falha fica à vista e a tentativa é contada', async () => {
    await enfileirar(db, 'a1');
    await processarAnexos(db, cliente({ falharNoEnvio: true }), WIFI);

    const [linha] = await db.getAllAsync<{
      tentativas: number;
      ultimo_erro: string;
      estado: string;
    }>('SELECT tentativas, ultimo_erro, estado FROM fila_de_anexos WHERE id = ?', ['a1']);
    expect(linha?.tentativas).toBe(1);
    expect(linha?.ultimo_erro).toContain('cortada');
    expect(linha?.estado).toBe('pendente');
  });

  it('um anexo que falha não trava os outros', async () => {
    await enfileirar(db, 'a1');
    await enfileirar(db, 'a2');

    let primeiro = true;
    const transporte: ClienteDeAnexos = {
      async presign() {
        return { jaExiste: false, url: 'https://x', cabecalhos: {} };
      },
      async enviar() {
        if (primeiro) {
          primeiro = false;
          throw new Error('falhou o primeiro');
        }
      },
      async completar() {},
    };

    // Ao contrário das revisões, dois anexos não têm ordem entre si.
    const resultado = await processarAnexos(db, transporte, WIFI);
    expect(resultado).toMatchObject({ enviados: 1, falhados: 1 });
  });
});

describe('F9.7 — o ficheiro local só se apaga depois de confirmado', () => {
  let db: BaseLocal;
  beforeEach(() => {
    db = abrir();
  });

  it('um anexo por subir nunca aparece como seguro de apagar', async () => {
    await enfileirar(db, 'a1');
    expect(await anexosSeguroApagar(db)).toEqual([]);

    // Nem depois de falhar: apagar aqui seria perder trabalho de campo.
    await processarAnexos(db, cliente({ falharNoEnvio: true }), WIFI);
    expect(await anexosSeguroApagar(db)).toEqual([]);
  });

  it('depois de o servidor confirmar, pode apagar-se', async () => {
    await enfileirar(db, 'a1');
    await processarAnexos(db, cliente(), WIFI);

    const seguros = await anexosSeguroApagar(db);
    expect(seguros).toHaveLength(1);
    expect(seguros[0]?.confirmado_em).not.toBeNull();

    await marcarLocalApagado(db, 'a1');
    // O registo do anexo fica; o que desaparece é o ficheiro no telefone.
    const [linha] = await db.getAllAsync<{ local_uri: string; estado: string }>(
      'SELECT local_uri, estado FROM fila_de_anexos WHERE id = ?',
      ['a1'],
    );
    expect(linha?.local_uri).toBe('');
    expect(linha?.estado).toBe('concluido');
  });

  it('o resumo diz quanto espaço há a recuperar e quanto falta subir', async () => {
    await enfileirar(db, 'a1');
    await enfileirar(db, 'a2');
    await processarAnexos(db, cliente(), WIFI);
    await enfileirar(db, 'a3');

    const resumo = await resumoDosAnexos(db);
    expect(resumo.concluidos).toBe(2);
    expect(resumo.pendentes).toBe(1);
    expect(resumo.bytesPendentes).toBe(2_000_000);
    expect(resumo.bytesRecuperaveis).toBe(4_000_000);
  });
});
