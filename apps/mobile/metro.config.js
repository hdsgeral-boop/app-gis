// Metro num monorepo pnpm.
//
// Sem isto, o bundler não encontra os pacotes internos (@cvforms/form-core) nem
// os módulos no `node_modules` da raiz: o pnpm não achata a árvore como o npm.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projeto = __dirname;
const raiz = path.resolve(projeto, '../..');

const config = getDefaultConfig(projeto);

config.watchFolders = [raiz];
config.resolver.nodeModulesPaths = [
  path.resolve(projeto, 'node_modules'),
  path.resolve(raiz, 'node_modules'),
];
// NÃO desligar a procura hierárquica. É o conselho que anda por aí para
// monorepos npm/yarn, mas com o pnpm parte tudo: as dependências transitivas
// vivem dentro do `.pnpm`, e é precisamente a procura hierárquica que as
// encontra a partir de lá.
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
