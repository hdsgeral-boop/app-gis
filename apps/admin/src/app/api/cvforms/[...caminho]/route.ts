import { NextResponse, type NextRequest } from 'next/server';

import { chamarApiBruto } from '@/lib/api';

/**
 * Ponte entre o construtor, que corre no browser, e a API.
 *
 * O construtor é interactivo e tem de falar com a API a cada gravação de
 * rascunho. Não pode fazê-lo directamente porque o `access_token` nunca sai do
 * servidor — um token de administrador no `localStorage` do browser é um
 * problema de segurança que não se justifica por conveniência de código.
 *
 * Esta rota reencaminha o pedido, acrescenta o token do lado de cá, e devolve
 * a resposta tal como veio, incluindo o estado. Não interpreta nada: se a API
 * recusa uma publicação com 409 e uma lista de problemas, é isso que chega ao
 * ecrã.
 */
async function reencaminhar(pedido: NextRequest, caminho: string[]): Promise<NextResponse> {
  const rota = `/${caminho.join('/')}${pedido.nextUrl.search}`;
  const corpo =
    pedido.method === 'GET' || pedido.method === 'DELETE' ? undefined : await pedido.text();

  try {
    const resposta = await chamarApiBruto(rota, {
      method: pedido.method,
      ...(corpo ? { body: corpo } : {}),
    });
    const texto = await resposta.text();
    return new NextResponse(texto, {
      status: resposta.status,
      headers: { 'content-type': resposta.headers.get('content-type') ?? 'application/json' },
    });
  } catch (erro) {
    return NextResponse.json(
      { message: erro instanceof Error ? erro.message : 'falha a contactar a API' },
      { status: 502 },
    );
  }
}

type Contexto = { params: Promise<{ caminho: string[] }> };

export async function GET(pedido: NextRequest, contexto: Contexto) {
  return reencaminhar(pedido, (await contexto.params).caminho);
}
export async function POST(pedido: NextRequest, contexto: Contexto) {
  return reencaminhar(pedido, (await contexto.params).caminho);
}
export async function PATCH(pedido: NextRequest, contexto: Contexto) {
  return reencaminhar(pedido, (await contexto.params).caminho);
}
export async function DELETE(pedido: NextRequest, contexto: Contexto) {
  return reencaminhar(pedido, (await contexto.params).caminho);
}
