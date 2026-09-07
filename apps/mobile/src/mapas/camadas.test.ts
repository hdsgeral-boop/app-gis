import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { BaseLocal } from '@/forms/definicoes';
import {
  ESQUEMA_CAMADAS,
  acrescentarCamadaManual,
  camadaDeFundo,
  camadasDisponiveis,
  esquecerFicheiro,
  espacoOcupado,
  estaPronta,
  guardarCamadas,
  listarCamadas,
  marcarDescarregada,
  porDescarregar,
  type CamadaLocal,
  type CamadaRemota,
} from './camadas';

/**
 * F8 — camadas de mapa no telefone.
 *
 * O que este ficheiro vigia é o que faz perder um mapa de 300 MB já
 * descarregado, ou pior: mostrar como pronto um ficheiro que veio a meio. Um
 * PMTiles truncado não dá erro — dá um mapa que carrega metade e pára, e quem
 * está no terreno conclui que a área não tem mapa.
 */

function abrir(): BaseLocal & { bruto: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec(ESQUEMA_CAMADAS);
  return {
    bruto: db,
    async runAsync(source: string, params: unknown[] = []) {
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

function remota(over: Partial<CamadaRemota> = {}): CamadaRemota {
  return {
    id: 'c1',
    nome: 'Luanda',
    descricao: null,
    tipo: 'pmtiles',
    projecto_id: null,
    bytes: 300_000_000,
    sha256: 'a'.repeat(64),
    zoom_min: 8,
    zoom_max: 16,
    style_url: null,
    descarga_automatica: false,
    por_omissao: true,
    ...over,
  };
}

describe('F8 — o que o servidor diz e o que este telefone tem', () => {
  let db: ReturnType<typeof abrir>;
  beforeEach(() => {
    db = abrir();
  });

  it('sincronizar NÃO apaga o ficheiro já descarregado', async () => {
    // É o teste mais importante do ficheiro. Se a sincronização reescrevesse o
    // `ficheiro_uri`, cada sincronização obrigaria a descarregar 300 MB outra
    // vez — e um técnico com dados móveis pagaria isso do bolso.
    await guardarCamadas(db, [remota()]);
    await marcarDescarregada(db, 'c1', 'file://mapas/c1.pmtiles', 300_000_000);

    await guardarCamadas(db, [remota({ nome: 'Luanda (v2)' })]);

    const [camada] = await listarCamadas(db);
    expect(camada!.nome).toBe('Luanda (v2)');
    expect(camada!.ficheiro_uri).toBe('file://mapas/c1.pmtiles');
    expect(camada!.bytes_locais).toBe(300_000_000);
  });

  it('uma camada que o servidor deixou de anunciar, mas está cá, fica', async () => {
    // O ficheiro está no telefone e ainda serve. Perde-se a linha do servidor,
    // não o mapa.
    await guardarCamadas(db, [remota()]);
    await marcarDescarregada(db, 'c1', 'file://mapas/c1.pmtiles', 300_000_000);

    await guardarCamadas(db, []);

    const restantes = await listarCamadas(db);
    expect(restantes).toHaveLength(1);
    expect(restantes[0]!.origem).toBe('manual');
  });

  it('uma camada que o servidor retirou e que não está cá desaparece', async () => {
    await guardarCamadas(db, [remota()]);
    await guardarCamadas(db, []);
    expect(await listarCamadas(db)).toHaveLength(0);
  });

  it('a camada que o técnico escolheu à mão não é tocada pela sincronização', async () => {
    await acrescentarCamadaManual(db, {
      id: 'manual-1',
      nome: 'Bengo (cartão SD)',
      uri: 'file://sd/bengo.pmtiles',
      bytes: 120_000_000,
    });
    await guardarCamadas(db, [remota()]);

    const dela = (await listarCamadas(db)).find((c) => c.id === 'manual-1');
    expect(dela?.ficheiro_uri).toBe('file://sd/bengo.pmtiles');
  });
});

describe('F8 — o que conta como pronto', () => {
  let db: ReturnType<typeof abrir>;
  beforeEach(() => {
    db = abrir();
  });

  it('um ficheiro a meio NÃO conta como pronto', async () => {
    // Um PMTiles truncado carrega metade e pára, sem erro nenhum.
    await guardarCamadas(db, [remota()]);
    await marcarDescarregada(db, 'c1', 'file://mapas/c1.pmtiles', 150_000_000);

    const [camada] = await listarCamadas(db);
    expect(estaPronta(camada!)).toBe(false);
    expect(await camadasDisponiveis(db)).toHaveLength(0);
  });

  it('um ficheiro completo conta', async () => {
    await guardarCamadas(db, [remota()]);
    await marcarDescarregada(db, 'c1', 'file://mapas/c1.pmtiles', 300_000_000);
    expect(await camadasDisponiveis(db)).toHaveLength(1);
  });

  it('um estilo online conta se tiver URL', async () => {
    await guardarCamadas(db, [
      remota({ id: 'c2', tipo: 'estilo_online', style_url: 'https://x/estilo.json', bytes: null }),
    ]);
    const [camada] = await listarCamadas(db);
    expect(estaPronta(camada!)).toBe(true);
  });

  it('um pmtiles sem ficheiro não conta', () => {
    const camada = { tipo: 'pmtiles', ficheiro_uri: null } as CamadaLocal;
    expect(estaPronta(camada)).toBe(false);
  });
});

describe('F8 — que mapa se mostra por baixo', () => {
  let db: ReturnType<typeof abrir>;
  beforeEach(() => {
    db = abrir();
  });

  it('sem nenhum mapa pronto, não devolve nenhum', async () => {
    // Devolver uma camada online sem rede é um ecrã à espera de mosaicos que
    // nunca chegam. Melhor dizer que não há mapa.
    await guardarCamadas(db, [remota()]);
    expect(await camadaDeFundo(db)).toBeUndefined();
  });

  it('usa a que o administrador marcou como fundo', async () => {
    await guardarCamadas(db, [
      remota({ id: 'a', nome: 'Outra', por_omissao: false }),
      remota({ id: 'b', nome: 'Fundo', por_omissao: true }),
    ]);
    await marcarDescarregada(db, 'a', 'file://a.pmtiles', 300_000_000);
    await marcarDescarregada(db, 'b', 'file://b.pmtiles', 300_000_000);

    expect((await camadaDeFundo(db))?.id).toBe('b');
  });

  it('a escolha do técnico ganha à do administrador', async () => {
    await guardarCamadas(db, [
      remota({ id: 'a', nome: 'Outra', por_omissao: false }),
      remota({ id: 'b', nome: 'Fundo', por_omissao: true }),
    ]);
    await marcarDescarregada(db, 'a', 'file://a.pmtiles', 300_000_000);
    await marcarDescarregada(db, 'b', 'file://b.pmtiles', 300_000_000);

    expect((await camadaDeFundo(db, 'a'))?.id).toBe('a');
  });

  it('uma escolha que já não está pronta cai para a de fundo', async () => {
    await guardarCamadas(db, [remota({ id: 'b', por_omissao: true })]);
    await marcarDescarregada(db, 'b', 'file://b.pmtiles', 300_000_000);
    expect((await camadaDeFundo(db, 'inexistente'))?.id).toBe('b');
  });
});

describe('F8 — espaço e o que falta', () => {
  let db: ReturnType<typeof abrir>;
  beforeEach(() => {
    db = abrir();
  });

  it('as que faltam vêm da mais pequena para a maior', async () => {
    // Descarregar primeiro a mais pequena dá ao técnico um mapa a funcionar
    // mais depressa, mesmo que seja só de uma parte da área.
    await guardarCamadas(db, [
      remota({ id: 'grande', bytes: 400_000_000 }),
      remota({ id: 'pequena', bytes: 40_000_000, por_omissao: false }),
    ]);
    const fila = await porDescarregar(db);
    expect(fila.map((c) => c.id)).toEqual(['pequena', 'grande']);
  });

  it('conta o espaço só do que está mesmo cá', async () => {
    await guardarCamadas(db, [
      remota({ id: 'a', bytes: 100_000_000 }),
      remota({ id: 'b', bytes: 200_000_000, por_omissao: false }),
    ]);
    await marcarDescarregada(db, 'a', 'file://a.pmtiles', 100_000_000);
    expect(await espacoOcupado(db)).toBe(100_000_000);
  });

  it('esquecer o ficheiro liberta o espaço e mantém a camada na lista', async () => {
    // A camada tem de continuar visível: uma que desaparecesse ao ser apagada
    // obrigaria a sincronizar outra vez só para a voltar a ver.
    await guardarCamadas(db, [remota()]);
    await marcarDescarregada(db, 'c1', 'file://c1.pmtiles', 300_000_000);
    await esquecerFicheiro(db, 'c1');

    expect(await espacoOcupado(db)).toBe(0);
    expect(await listarCamadas(db)).toHaveLength(1);
    expect(await camadasDisponiveis(db)).toHaveLength(0);
  });
});
