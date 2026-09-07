import * as FileSystem from 'expo-file-system';

import { abrirBaseLocal } from '../db/local';
import { config } from '../lib/config';
import { lerTokens, renovar } from '../lib/auth';
import { marcarDescarregada, porDescarregar, type CamadaLocal } from './camadas';

/**
 * Descarregar mosaicos (F8.2).
 *
 * TRÊS COISAS QUE ISTO FAZ E QUE UM `fetch` DIRECTO NÃO FARIA:
 *
 * 1. **Retoma de onde ficou.** Um PMTiles de 300 MB por uma rede de campo cai
 *    a meio quase sempre. Sem retoma, cada tentativa recomeça do zero e o
 *    mapa nunca chega — e cada tentativa custa os megabytes todos outra vez.
 * 2. **Só marca como pronta no fim.** Um ficheiro a meio não dá erro nenhum ao
 *    ser aberto: dá um mapa que carrega metade e pára, e quem está no terreno
 *    conclui que a área não tem mapa.
 * 3. **Verifica o tamanho.** É a confirmação mais barata de que o que chegou é
 *    o que saiu. O hash seria melhor, mas ler 300 MB para o calcular num
 *    Android de gama baixa custa mais do que vale.
 *
 * O ficheiro NÃO passa pela API: vem directamente do armazenamento com um URL
 * assinado. É a mesma decisão da F9.3, e pela mesma razão.
 */

/** Onde os mosaicos ficam. Fora da cache: o Android limpa a cache sozinho. */
function pastaDeMapas(): string {
  return `${FileSystem.Paths.document.uri}mapas/`;
}

export interface ProgressoDaDescarga {
  (bytesFeitos: number, bytesEsperados: number): void;
}

/**
 * Descarrega uma camada e regista-a.
 *
 * Devolve o caminho local. Se já lá estava completa, devolve-o sem gastar
 * rede — voltar a descarregar 300 MB por engano é o género de erro que se paga
 * na factura de alguém.
 */
export async function descarregarCamada(
  camada: CamadaLocal,
  aoProgredir?: ProgressoDaDescarga,
): Promise<string> {
  if (camada.tipo !== 'pmtiles') {
    throw new Error('só uma camada de mosaicos se descarrega');
  }

  const pasta = new FileSystem.Directory(pastaDeMapas());
  if (!pasta.exists) pasta.create({ intermediates: true });

  const destino = new FileSystem.File(`${pastaDeMapas()}${camada.id}.pmtiles`);
  if (destino.exists && camada.bytes && destino.size === camada.bytes) {
    const db = await abrirBaseLocal();
    await marcarDescarregada(db, camada.id, destino.uri, destino.size);
    return destino.uri;
  }

  const tokens = await lerTokens();
  if (!tokens) throw new Error('precisas de ter sessão iniciada para descarregar um mapa');
  const frescos = await renovar(tokens);

  // A API só assina; o ficheiro vem do armazenamento.
  const resposta = await fetch(`${config.apiUrl}/mapas/camadas/${camada.id}/url`, {
    headers: { authorization: `Bearer ${frescos.accessToken}` },
  });
  if (!resposta.ok) throw new Error(`a API respondeu ${resposta.status}`);
  const { url, bytes } = (await resposta.json()) as { url: string; bytes: number | null };

  const descarga = FileSystem.createDownloadResumable(
    url,
    destino.uri,
    {},
    aoProgredir
      ? (p) => aoProgredir(p.totalBytesWritten, p.totalBytesExpectedToWrite || (bytes ?? 0))
      : undefined,
  );

  const resultado = await descarga.downloadAsync();
  if (!resultado) throw new Error('a descarga foi interrompida');

  const ficheiro = new FileSystem.File(resultado.uri);
  const tamanho = ficheiro.size ?? 0;

  // Um ficheiro truncado é pior do que nenhum: não dá erro, dá um mapa que
  // carrega metade. Apaga-se e diz-se porquê.
  if (bytes && tamanho !== bytes) {
    ficheiro.delete();
    throw new Error(
      `o ficheiro chegou incompleto (${Math.round(tamanho / 1_048_576)} de ${Math.round(bytes / 1_048_576)} MB). Tenta outra vez com melhor rede.`,
    );
  }

  const db = await abrirBaseLocal();
  await marcarDescarregada(db, camada.id, resultado.uri, tamanho);
  return resultado.uri;
}

/**
 * Descarrega o que está marcado como automático.
 *
 * SÓ EM WI-FI, e só as marcadas — as duas condições são a mesma decisão da fila
 * de anexos (F9.4). Um mapa de 300 MB por rede móvel custa dinheiro real, e
 * ninguém autorizou esse gasto por carregar a app.
 *
 * `haWifi` entra por injecção: saber se há Wi-Fi obriga a um módulo nativo, e
 * essa dependência não tem que estar aqui dentro.
 */
export async function descarregarAutomaticas(haWifi: () => Promise<boolean> | boolean): Promise<{
  descarregadas: number;
  saltadas: number;
}> {
  if (!(await haWifi())) return { descarregadas: 0, saltadas: 0 };

  const db = await abrirBaseLocal();
  const pendentes = (await porDescarregar(db)).filter((c) => c.descarga_auto);

  let descarregadas = 0;
  let saltadas = 0;
  for (const camada of pendentes) {
    // Uma que falhe não impede as outras: um técnico com cinco mapas
    // atribuídos não pode ficar sem nenhum porque um tem um problema.
    try {
      await descarregarCamada(camada);
      descarregadas++;
    } catch {
      saltadas++;
    }
    // Confirma o Wi-Fi entre ficheiros: o técnico pode sair do alcance a meio,
    // e continuar por rede móvel é exactamente o que isto evita.
    if (!(await haWifi())) break;
  }
  return { descarregadas, saltadas };
}

/** Apaga o ficheiro do disco. A linha da camada fica. */
export async function apagarFicheiro(camada: CamadaLocal): Promise<void> {
  if (!camada.ficheiro_uri) return;
  const ficheiro = new FileSystem.File(camada.ficheiro_uri);
  if (ficheiro.exists) ficheiro.delete();
}
