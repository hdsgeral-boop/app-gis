import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Image } from 'react-native';

import type { Dimensoes, ManipuladorDeImagem } from './imagem';

/**
 * A parte da F9.1 que precisa de hardware.
 *
 * A decisão — que dimensões, que qualidade, o que fazer quando falha — está no
 * `imagem.ts` e é testada sem telefone nenhum. Aqui fica só o trabalho sobre
 * os pixels e o acesso ao ficheiro, que é o que não se pode testar de outra
 * maneira.
 */

export const manipuladorNativo: ManipuladorDeImagem = {
  /**
   * As dimensões sem carregar a imagem inteira para memória.
   *
   * `Image.getSize` lê só o cabeçalho. Abrir uma foto de 4000×3000 num Android
   * de gama baixa só para saber quanto mede são 48 MB de bitmap e um risco
   * real de a app ser morta pelo sistema.
   */
  medir(uri: string): Promise<Dimensoes> {
    return new Promise((resolver, rejeitar) => {
      Image.getSize(
        uri,
        (largura, altura) => resolver({ largura, altura }),
        (erro) => rejeitar(erro instanceof Error ? erro : new Error(String(erro))),
      );
    });
  },

  async redimensionar(uri: string, destino: Dimensoes, qualidade: number) {
    const contexto = ImageManipulator.ImageManipulator.manipulate(uri);
    contexto.resize({ width: destino.largura, height: destino.altura });
    const imagem = await contexto.renderAsync();
    const resultado = await imagem.saveAsync({
      compress: qualidade,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    return { uri: resultado.uri, bytes: await manipuladorNativo.tamanho(resultado.uri) };
  },

  async tamanho(uri: string): Promise<number> {
    const ficheiro = new FileSystem.File(uri);
    return ficheiro.size ?? 0;
  },
};

export interface FotografiaEscolhida {
  uri: string;
  largura: number;
  altura: number;
}

/**
 * Abre a câmara e devolve o que o técnico tirou.
 *
 * `undefined` quando ele cancela — cancelar não é um erro e não deve aparecer
 * como um.
 *
 * `allowsEditing: false` de propósito: o ecrã de corte do Android é mais um
 * toque, e o que interessa numa chapa de contador é a fotografia inteira. Cada
 * toque a mais custa tempo a alguém que tem trinta visitas para fazer.
 */
export async function tirarFotografia(): Promise<FotografiaEscolhida | undefined> {
  const permissao = await ImagePicker.requestCameraPermissionsAsync();
  if (!permissao.granted) {
    throw new Error(
      permissao.canAskAgain
        ? 'A app precisa da câmara para anexar fotografias.'
        : 'O acesso à câmara foi recusado. Activa-o nas definições do telefone, em Aplicações → Consul Colect → Permissões.',
    );
  }

  const resultado = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    // A compressão a sério é feita a seguir, com o `max_dimension_px` do
    // formulário. Aqui pede-se o máximo para não comprimir duas vezes — cada
    // passagem por JPEG perde detalhe, e o que se está a fotografar são muitas
    // vezes números de série.
    quality: 1,
    exif: false,
  });
  if (resultado.canceled) return undefined;

  const primeira = resultado.assets[0];
  if (!primeira) return undefined;
  return { uri: primeira.uri, largura: primeira.width, altura: primeira.height };
}

/** O mesmo, mas a partir da galeria — para quando a foto já foi tirada. */
export async function escolherDaGaleria(): Promise<FotografiaEscolhida | undefined> {
  const permissao = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permissao.granted) throw new Error('A app precisa de acesso às fotografias.');

  const resultado = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 1,
    exif: false,
  });
  if (resultado.canceled) return undefined;
  const primeira = resultado.assets[0];
  if (!primeira) return undefined;
  return { uri: primeira.uri, largura: primeira.width, altura: primeira.height };
}

/**
 * SHA-256 do ficheiro, que é a chave da deduplicação (F9.6).
 *
 * Corre DEPOIS do redimensionamento, e é isso que o torna barato: o que se lê
 * para memória é a foto já reduzida (algumas centenas de kB), e não os 4 MB
 * que saíram da câmara. Fazê-lo antes obrigaria a ler o ficheiro grande e a
 * hash mudava na mesma ao redimensionar — o servidor deduplica pelo conteúdo
 * que recebe, não pelo que a câmara produziu.
 */
export async function hashDoFicheiro(uri: string): Promise<string> {
  const ficheiro = new FileSystem.File(uri);
  if (!ficheiro.exists) throw new Error('o ficheiro da fotografia desapareceu');

  const bytes = await ficheiro.bytes();
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
