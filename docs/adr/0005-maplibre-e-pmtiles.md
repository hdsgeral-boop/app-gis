# ADR-0005 — MapLibre + PMTiles para o mapa offline

**Estado:** aceite · **Data:** 2026-09-05

## Contexto

O técnico precisa de ver onde está e o que já recolheu, em zonas rurais sem
rede. Isso exige mosaicos guardados no telefone.

## Decisão

**MapLibre GL Native**, com mosaicos próprios em **PMTiles** (ou MBTiles) num
ficheiro no telefone. O Google Maps, se existir, é uma camada online opcional e
isolada, e os seus mosaicos **nunca** são guardados (restrição inegociável 1).

## Alternativas rejeitadas

**Google Maps com mosaicos pré-carregados.** Rejeitada porque os termos da
Google Maps Platform o proíbem explicitamente. Não é uma questão de risco
calculado: é uma violação de licença que põe o cliente em causa. O job
`restricoes` do CI verifica isto automaticamente, porque é o tipo de coisa que
alguém faz de boa fé, sem saber.

**Mapbox.** Tecnicamente muito bom, com offline de primeira. Rejeitada pelo
modelo de preços por utilizador activo, que numa frota de técnicos de campo
cresce de forma difícil de prever, e pela dependência de um serviço externo
para uma função que tem de funcionar sem rede.

**MBTiles em vez de PMTiles.** MBTiles é SQLite e é mais conhecido. PMTiles é
um único ficheiro servível por intervalos HTTP, o que permite servir o mesmo
ficheiro online e offline sem o converter. Ficamos com PMTiles como omissão;
o MBTiles continua suportado porque muitos mosaicos existentes vêm nesse
formato.

## Consequências

**Ganhamos:** offline sem violar licença nenhuma; sem custo por utilizador;
o mesmo ficheiro serve online e offline.

**Pagamos:**

- Alguém tem de **produzir** os mosaicos. Não vêm de graça: é um passo de
  preparação por área de trabalho, e tem de haver ferramenta e documentação
  para isso.
- Os mosaicos são grandes. Distribuí-los para telefones de gama baixa com
  armazenamento limitado é um problema logístico real, e provavelmente
  resolve-se por cartão SD ou por transferência em Wi-Fi antes de sair para o
  terreno.
- A imagem de satélite de alta resolução, que os técnicos vão querer, é a parte
  cara. Ou se compra, ou se usa uma fonte aberta com menos resolução.
- O MapLibre GL Native em React Native tem menos gente a usá-lo do que as
  alternativas comerciais. Quando houver um problema, a resposta não vai estar
  no Stack Overflow.
