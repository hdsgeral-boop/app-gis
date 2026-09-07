import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `standalone` põe no `.next/standalone` um servidor com só as dependências
  // que são mesmo usadas. Sem isto, a imagem de produção leva o `node_modules`
  // inteiro do monorepo — mais de 1 GB para servir meia dúzia de páginas.
  output: 'standalone',
  // Num monorepo, o Next tem de saber onde a raiz está para copiar os ficheiros
  // certos; sem isto adivinha e deixa metade de fora.
  //
  // `fileURLToPath` e NÃO `.pathname`: no Windows o `pathname` de um URL de
  // ficheiro vem `/C:/…`, com a barra à frente. O Next trata isso como um
  // caminho relativo e escreve a saída numa pasta `xampp/htdocs/…` dentro do
  // repositório — que é onde isto foi descoberto.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  // O form-core é código do monorepo, não um pacote publicado: o Next tem de o
  // transpilar em vez de o tratar como dependência externa já compilada.
  transpilePackages: ['@cvforms/form-core'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
