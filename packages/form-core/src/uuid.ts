/**
 * UUIDv7 gerado no cliente (restrição inegociável 3).
 *
 * Vive aqui — e não em cada app — por ser exactamente o mesmo problema que o
 * resto deste pacote resolve: uma regra implementada duas vezes diverge. O
 * telefone gera o `id` de um registo antes de haver rede, e o servidor gera o
 * `id` de um formulário criado no painel; os dois têm de produzir a mesma
 * forma de identificador, ordenável pela mesma coluna.
 *
 * Porquê a versão 7 e não a 4: os primeiros 48 bits são o instante em
 * milissegundos, por isso os `id` gerados em sequência ficam próximos no
 * índice B-tree. Com UUIDv4 cada inserção cai num sítio aleatório do índice, e
 * numa tabela de registos de campo isso é fragmentação a sério.
 *
 * Nota sobre o relógio: o instante embutido vem do dispositivo, que em campo
 * está frequentemente errado. NUNCA se ordena por ele — a ordenação canónica é
 * `server_received_at` (ESPECIFICACAO §13.8). O `id` serve para identificar e
 * para agrupar no índice, não para datar.
 */

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Bytes aleatórios, do melhor sítio disponível no ambiente. */
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const crypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
    .crypto;
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
    return bytes;
  }
  // Sem WebCrypto não há como gerar identificadores seguros, e um `id`
  // previsível num sistema multi-organização é um problema de segurança, não
  // uma inconveniência. Falhar alto é a resposta certa.
  throw new Error('não há gerador de aleatórios criptográfico neste ambiente');
}

let ultimoInstante = 0;
let ultimoContador = 0;

/**
 * Gera um UUIDv7.
 *
 * Dois `id` gerados no mesmo milissegundo continuam ordenados entre si: os 12
 * bits a seguir ao instante são um contador que só reinicia quando o relógio
 * avança. Sem isso, gerar 30 registos de uma vez — o que acontece ao importar
 * — produzia uma ordem arbitrária dentro do mesmo milissegundo.
 */
export function uuidv7(): string {
  const agora = Date.now();
  if (agora === ultimoInstante) {
    ultimoContador = (ultimoContador + 1) & 0x0fff;
  } else {
    ultimoInstante = agora;
    ultimoContador = randomBytes(2)[0]! & 0x0fff;
  }

  const bytes = new Uint8Array(16);
  // 48 bits de instante, big-endian.
  bytes[0] = (agora / 2 ** 40) & 0xff;
  bytes[1] = (agora / 2 ** 32) & 0xff;
  bytes[2] = (agora / 2 ** 24) & 0xff;
  bytes[3] = (agora / 2 ** 16) & 0xff;
  bytes[4] = (agora / 2 ** 8) & 0xff;
  bytes[5] = agora & 0xff;

  // 4 bits de versão (7) + 12 bits de contador.
  bytes[6] = 0x70 | ((ultimoContador >> 8) & 0x0f);
  bytes[7] = ultimoContador & 0xff;

  const aleatorio = randomBytes(8);
  bytes.set(aleatorio, 8);
  // 2 bits de variante (RFC 4122).
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const h = (i: number): string => HEX[bytes[i]!]!;
  return (
    `${h(0)}${h(1)}${h(2)}${h(3)}-${h(4)}${h(5)}-${h(6)}${h(7)}-${h(8)}${h(9)}-` +
    `${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}`
  );
}

/** `true` se for um UUID bem formado da versão 7. */
export function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Instante embutido num UUIDv7, em milissegundos. Só para diagnóstico. */
export function uuidv7Timestamp(value: string): number | undefined {
  if (!isUuidV7(value)) return undefined;
  return Number.parseInt(value.replace(/-/g, '').slice(0, 12), 16);
}
