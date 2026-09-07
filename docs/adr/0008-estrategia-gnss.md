# ADR-0008 — Abstracção `LocationProvider` para o GNSS

**Estado:** aceite · **Data:** 2026-09-05

## Contexto

O cadastro de redes eléctricas precisa de precisão sub-métrica, que o GPS
interno de um telefone não dá. Os técnicos usam receptores externos (Emlid,
Trimble, SinoGNSS), que se ligam por Bluetooth ou por NMEA sobre TCP/Wi-Fi.
Mas nem todos os trabalhos precisam disso, e nem todos os técnicos têm receptor.

## Decisão

Uma abstracção `LocationProvider` com implementações intermutáveis: GPS
interno, NMEA sobre TCP/Wi-Fi, e Bluetooth no Android (via mock location
provider). Em iOS o Bluetooth exige o programa MFi da Apple — assume-se TCP
como via principal.

Todo o ponto guardado leva `accuracy_m`, `fix_type` e `source` (restrição
inegociável 8), e são colunas `NOT NULL` com `CHECK` em `gps_fixes`.

Limiar de precisão por formulário (`max_accuracy_m`). Acima do limiar a app
avisa de forma visível e só grava **com justificação escrita**, que fica na
revisão. A precisão actual e a origem do fixo estão sempre no ecrã.

## Alternativas rejeitadas

**Só o GPS interno.** Rejeitada porque não serve o caso de uso que paga o
projecto. Um ponto com 5 m de erro num cadastro de rede de baixa tensão é um
ponto errado.

**Bloquear a gravação acima do limiar.** Foi a primeira intuição e está errada.
Um técnico debaixo de copado denso, com prazo, ou a fazer o levantamento de um
ponto que fisicamente não tem céu, ficaria impedido de trabalhar. O resultado
previsível é ele apontar no papel — e aí perdem-se os metadados todos. Gravar
com justificação escrita mantém o dado e mantém a rastreabilidade.

**Assumir só um modelo de receptor.** Rejeitada porque o parque de
equipamentos muda e porque nos prenderia a um fornecedor. NMEA é o
denominador comum de todos eles.

## Consequências

**Ganhamos:** um formulário pode exigir 2 cm ou 10 m sem alterar código; os
metadados do fixo ficam guardados e auditáveis; nenhum ponto entra na base sem
se saber com que qualidade foi medido.

**Pagamos:**

- O Bluetooth em Android por mock location provider exige que o utilizador
  active as opções de programador e escolha a app como fonte de localização
  simulada. É um passo de configuração que confunde os técnicos e que precisa
  de documentação com fotografias.
- Em iOS, sem MFi, o Bluetooth está fora. Quem usar iPhone fica limitado ao
  TCP/Wi-Fi, o que obriga o receptor a criar uma rede.
- Ler NMEA é trabalho aborrecido e cheio de casos particulares: cada fabricante
  tem as suas frases próprias, e o `fix_type` nem sempre vem onde devia.
- A justificação escrita é um campo de texto livre que alguém tem de ler. Se
  ninguém ler, o mecanismo vira teatro. Tem de aparecer nos relatórios de
  qualidade da F10.
