import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renovar } from './auth';

/**
 * A renovação do token de acesso do painel.
 *
 * O DEFEITO QUE ISTO FIXA. O realm emite tokens de 15 minutos e a sessão do
 * painel dura 30 dias. Sem renovação, ao fim de um quarto de hora o painel
 * continuava a mostrar o nome de quem entrou — o cookie ainda era válido — e
 * todas as páginas passavam a dizer «respondeu 401». Parecia a API avariada,
 * e era o token expirado a ir para lá na mesma.
 */
const emissor = 'http://keycloak.teste/realms/cvforms';

beforeEach(() => {
  process.env.KEYCLOAK_ISSUER = emissor;
  process.env.KEYCLOAK_CLIENT_ID = 'cvforms-admin';
  delete process.env.KEYCLOAK_CLIENT_SECRET;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renovação do token do painel', () => {
  it('troca o refresh token por um par novo', async () => {
    const fetchFalso = vi.fn(async () =>
      Response.json({
        access_token: 'novo-acesso',
        refresh_token: 'novo-refresh',
        expires_in: 900,
      }),
    );
    vi.stubGlobal('fetch', fetchFalso);

    const antes = Date.now();
    const token = await renovar({ accessToken: 'velho', refreshToken: 'refresh-1' });

    expect(token.accessToken).toBe('novo-acesso');
    expect(token.erro).toBeUndefined();
    expect(token.accessTokenExpiresAt).toBeGreaterThanOrEqual(antes + 900_000);

    const [url, opcoes] = fetchFalso.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${emissor}/protocol/openid-connect/token`);
    const corpo = new URLSearchParams(opcoes.body as string);
    expect(corpo.get('grant_type')).toBe('refresh_token');
    expect(corpo.get('refresh_token')).toBe('refresh-1');
    expect(corpo.get('client_id')).toBe('cvforms-admin');
  });

  it('guarda o refresh token novo: o Keycloak roda-o e o antigo deixa de servir', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ access_token: 'a', refresh_token: 'rodado', expires_in: 60 }),
      ),
    );
    const token = await renovar({ refreshToken: 'antigo' });
    expect(token.refreshToken).toBe('rodado');
  });

  it('sem refresh token não inventa nada', async () => {
    const fetchFalso = vi.fn();
    vi.stubGlobal('fetch', fetchFalso);
    const token = await renovar({ accessToken: 'velho' });
    expect(token.erro).toBeDefined();
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it('uma recusa do Keycloak marca o erro e NÃO deita a sessão fora', async () => {
    // Expulsar alguém a meio de uma revisão por causa de dois segundos de
    // Keycloak em baixo é pior do que um 401 que se resolve a entrar de novo.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })),
    );
    const token = await renovar({ accessToken: 'velho', refreshToken: 'expirado' });
    expect(token.erro).toBe('renovacao_recusada');
    expect(token.accessToken).toBe('velho');
  });

  it('um Keycloak inacessível não rebenta a chamada', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const token = await renovar({ refreshToken: 'r' });
    expect(token.erro).toBe('keycloak_inacessivel');
  });
});
