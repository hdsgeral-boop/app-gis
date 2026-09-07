# Consul Colect — manual do técnico

**Para quem vai recolher dados no terreno.** Não é preciso saber nada de
informática para seguir isto do princípio ao fim.

> ### Como inserir as fotografias
>
> Ao longo do manual há blocos como este:
>
> ```
> ![Ecrã de entrada](imagens/01-entrar.png)
> ```
>
> Cada um diz **o que a fotografia tem de mostrar**. Tira a imagem do telefone
> (botão de ligar + baixar volume ao mesmo tempo), grava-a em
> `docs/imagens/` com o nome indicado, e a imagem aparece aqui sozinha. Os
> nomes estão numerados pela ordem do manual para não te enganares.

---

## Índice

1. [O mais importante](#1-o-mais-importante)
2. [Instalar a app](#2-instalar-a-app)
3. [Entrar pela primeira vez](#3-entrar-pela-primeira-vez)
4. [Escolher o receptor de posição](#4-escolher-o-receptor-de-posição)
5. [Antes de sair para o campo](#5-antes-de-sair-para-o-campo)
6. [Recolher um registo](#6-recolher-um-registo)
7. [O ponto GPS](#7-o-ponto-gps)
8. [Fotografias](#8-fotografias)
9. [Guardar e submeter](#9-guardar-e-submeter)
10. [A lista de registos](#10-a-lista-de-registos)
11. [Procurar um registo](#11-procurar-um-registo)
12. [Corrigir um registo já submetido](#12-corrigir-um-registo-já-submetido)
13. [Sincronizar](#13-sincronizar)
14. [Quando corre mal](#14-quando-corre-mal)
15. [Antes de entregar o telefone](#15-antes-de-entregar-o-telefone)
16. [Cartão de bolso](#16-cartão-de-bolso)

---

## 1. O mais importante

Três frases. Se só leres esta página, lê estas três.

1. **Nada se perde por não haver rede.** Tudo o que gravas fica no telefone. A
   app envia sozinha quando apanhar sinal, mesmo que sejam dias depois.
2. **Gravar é sempre seguro.** Se um campo estiver mal preenchido, a app avisa
   e **grava à mesma**. Nunca perdes uma visita por causa de um erro num campo.
3. **Na dúvida, grava.** Vale mais um registo repetido do que uma visita que
   ficou por registar. Duplicados resolvem-se no escritório; uma visita perdida
   obriga alguém a voltar lá.

---

## 2. Instalar a app

A app **não está na Play Store**. É instalada a partir de um ficheiro `.apk`
que a tua empresa te dá.

1. Copia o ficheiro `cvforms.apk` para o telefone (por cabo, por Bluetooth, ou
   descarrega-o do link que te derem).
2. Abre o ficheiro no telefone. O Android vai dizer que não instala aplicações
   de origem desconhecida.
3. Toca em **Definições** nesse aviso e liga **Permitir desta origem**.
4. Volta atrás e toca em **Instalar**.

> ![Aviso de origem desconhecida do Android, com a opção «Permitir desta origem»](imagens/01-instalar-permissao.png)

> ![Ecrã final da instalação, com o botão «Abrir»](imagens/02-instalar-concluido.png)

**Se aparecer «aplicação não instalada»:** o telefone pode já ter uma versão
antiga com outra assinatura. Desinstala primeiro a antiga — mas só depois de
teres a certeza de que não tem registos por sincronizar (ver a
[secção 15](#15-antes-de-entregar-o-telefone)).

---

## 3. Entrar pela primeira vez

**Faz isto com rede**, uma vez. Depois disso podes trabalhar dias inteiros sem
rede nenhuma.

1. Abre a app **Consul Colect**.
2. Toca em **entrar**.
3. Abre-se uma página de login. Escreve o teu utilizador e a tua senha — são os
   mesmos que usarias no painel do computador.
4. A app volta sozinha e mostra o teu nome.

> ![Ecrã inicial da app antes de entrar, com o botão «entrar»](imagens/03-entrar.png)

> ![Página de login com os campos de utilizador e senha](imagens/04-login.png)

> ![Ecrã inicial já com sessão iniciada, a mostrar o nome do técnico](imagens/05-sessao-iniciada.png)

Logo a seguir a app descarrega os formulários que te foram atribuídos. Isto
demora alguns segundos.

**Só aparecem os formulários que são teus.** Se falta algum, não é avaria da
app — fala com quem administra a plataforma. Ninguém vê um formulário que não
lhe foi atribuído, e isso é de propósito.

---

## 4. Escolher o receptor de posição

Esta é a única definição que muda o que fica gravado. Vale a pena perceber.

No ecrã inicial, toca em **definições do receptor**.

> ![Ecrã de definições, com as duas opções de receptor](imagens/06-definicoes-receptor.png)

Há duas opções:

| Opção                        | Quando usar                                                 | Precisão típica       |
| ---------------------------- | ----------------------------------------------------------- | --------------------- |
| **GPS do telefone**          | O dia a dia. Não precisa de mais nada.                      | 3 a 8 m em céu aberto |
| **Receptor externo (Wi-Fi)** | Quando precisas de precisão a sério (cadastro, implantação) | 2 cm a 50 cm          |

### Se usares receptor externo

1. Liga o receptor (Emlid, Trimble ou equivalente) e espera que ele arranque.
2. Nas definições de **Wi-Fi do telefone**, liga-te à rede do receptor.
3. Volta à app, escolhe **Receptor externo** e confirma o endereço e a porta.
   O valor por omissão (`192.168.42.1`, porta `9001`) serve para a maioria dos
   Emlid.
4. Olha para a linha **Estado agora**. Em poucos segundos deve passar de
   «sem ligação» para uma precisão em metros.

> ![Definições com o receptor externo escolhido e o campo de endereço visível](imagens/07-receptor-externo.png)

> ![Linha «Estado agora» a mostrar uma precisão de ±0.02 m e o tipo «fixed»](imagens/08-receptor-ligado.png)

**Se ficar em «sem ligação»:** o telefone não está no Wi-Fi do receptor, ou o
endereço está errado. Não é a app.

---

## 5. Antes de sair para o campo

Com rede, ainda no escritório ou em casa. Cinco minutos que poupam um dia
perdido:

- [ ] Abre a app e espera que os formulários actualizem.
- [ ] **Bateria cheia.** O GPS gasta muito. Leva um carregador portátil.
- [ ] Confirma que a lista de registos não tem nada com ⏳ do dia anterior.
- [ ] Se usas receptor externo, liga-o e confirma que o telefone o encontra.
- [ ] Espaço no telefone: as fotografias ocupam. Se estiver quase cheio,
      sincroniza tudo antes de sair.

---

## 6. Recolher um registo

1. No ecrã inicial, toca em **formulários**.
2. Toca no formulário que vais preencher.
3. Toca em **novo registo**.

> ![Lista de formulários atribuídos](imagens/09-lista-formularios.png)

> ![Primeiro ecrã de um formulário, com as primeiras perguntas](imagens/10-formulario-inicio.png)

### Como ler o formulário

- Perguntas com **\*** são **obrigatórias**.
- Perguntas com texto mais pequeno por baixo têm uma **dica** — lê-a.
- **Algumas perguntas só aparecem depois de responderes a outras.** É normal:
  o formulário esconde o que não se aplica ao teu caso. Não é a app a falhar.
- Se o formulário tiver **secções**, os botões em baixo passam de uma para a
  outra. O número de erros de cada secção aparece ao lado do nome.

> ![Barra de secções em baixo, com o contador de erros numa delas](imagens/11-seccoes.png)

### Listas que se repetem

Alguns formulários têm blocos que se repetem — por exemplo, vários contadores
no mesmo local. Toca em **acrescentar** para cada um, e no **✕** para remover
um que acrescentaste por engano.

> ![Bloco repetível com duas instâncias e o botão «acrescentar»](imagens/12-repetivel.png)

---

## 7. O ponto GPS

Toca em **obter posição**. A app mostra três coisas, e as três interessam:

```
-8.838300, 13.234400
±0.02 m · fixed · external_tcp
```

> ![Campo de geometria com coordenadas, precisão, tipo de fixo e origem](imagens/13-ponto-bom.png)

| O que vês                   | O que quer dizer                                 |
| --------------------------- | ------------------------------------------------ |
| `±0.02 m`                   | O erro esperado. Quanto menor, melhor.           |
| `fixed`                     | A melhor qualidade possível. Centímetros.        |
| `float`                     | Boa, mas não a melhor. Dezenas de centímetros.   |
| `dgps`                      | Razoável. Menos de um metro.                     |
| `single`                    | GPS normal, sem correcções. Metros.              |
| `internal` / `external_tcp` | De onde veio: o telefone, ou o receptor externo. |

### Quando a precisão não chega

Se aparecer **um aviso a laranja**, a precisão está pior do que este trabalho
exige. **Podes gravar na mesma** — mas tens de escrever porquê.

> ![Aviso de precisão acima do limiar, com a caixa de justificação por baixo](imagens/14-ponto-acima-do-limiar.png)

Escreve a verdade, em poucas palavras:

- «sem céu aberto, junto ao muro do PT»
- «árvores por cima»
- «receptor sem correcções»
- «chuva forte, o fixo não estabilizou»

**Isto não é burocracia.** Quem for usar este ponto para decidir onde se põe
equipamento precisa de saber que este é menos fiável do que os outros. O que
escreves aparece num relatório que alguém vai ler.

### Se a posição não vier

1. Sai para um sítio com céu aberto.
2. Espera meio minuto sem te mexer — a precisão melhora sozinha.
3. Tenta outra vez.

Se continuar a não vir: **grava o resto do registo à mesma** e volta lá depois
para acrescentar o ponto. O registo não se perde.

---

## 8. Fotografias

Toca em **tirar fotografia**. A câmara abre; tira a foto e confirma.

> ![Campo de fotografia antes de tirar, com o botão «tirar fotografia»](imagens/15-anexo-vazio.png)

> ![Campo de fotografia com dois anexos já tirados e o botão «remover»](imagens/16-anexo-com-fotos.png)

A app **reduz a foto sozinha** antes de a guardar, para não gastar os teus
dados. Não precisas de fazer nada.

Regras que vale a pena saber:

- As fotos sobem **só quando houver Wi-Fi**, por omissão, e **depois** dos
  dados. Os dados são o que interessa e são leves.
- Um registo **sincroniza mesmo com fotos por subir**. Não esperes por elas.
- Enganaste-te na foto? Toca em **remover** e tira outra.
- Alguns campos têm um limite de fotos. Quando chegas ao limite, o botão diz-te.

---

## 9. Guardar e submeter

Há dois botões, e a diferença importa:

| Botão                | O que faz                                             |
| -------------------- | ----------------------------------------------------- |
| **guardar rascunho** | Fica no telefone para continuares depois. Não sobe.   |
| **submeter**         | Dá o registo por terminado. Entra na fila para subir. |

> ![Barra inferior com os botões «guardar rascunho» e «submeter»](imagens/17-guardar-submeter.png)

**Um rascunho nunca se perde**, mesmo que feches a app ou o telefone se
desligue a meio de uma frase. A app grava enquanto escreves.

Mas **só o que está submetido chega ao escritório**. No fim do dia, submete o
que estiver por submeter.

Se tentares submeter com campos obrigatórios por preencher, a app mostra-te
quais são e leva-te lá. Se mesmo assim não conseguires preencher — porque a
informação não existe — grava como rascunho e explica ao teu supervisor.

---

## 10. A lista de registos

No ecrã do formulário, toca em **ver registos**.

> ![Lista de registos com as marcas de estado à direita](imagens/18-lista-registos.png)

Cada registo tem uma marca:

| Marca | O que quer dizer                                 |
| ----- | ------------------------------------------------ |
| 📝    | Rascunho. Ainda não foi submetido.               |
| ⏳    | Submetido, à espera de rede. **Só existe aqui.** |
| ✅    | Já está no servidor. Seguro.                     |
| ⚠️    | Precisa de ser visto por alguém no escritório.   |

O ⏳ é a marca mais importante deste manual. Enquanto lá estiver, aquele
trabalho existe **num sítio só**: neste telefone.

---

## 11. Procurar um registo

Na lista, escreve na caixa de procura em cima. Procura pelos campos que o
formulário marcou como pesquisáveis — normalmente o código do local ou o nome.

> ![Caixa de procura com um código escrito e um resultado](imagens/19-procurar.png)

Não distingue maiúsculas de minúsculas. Basta escrever um pedaço do código.

**Se procuras um registo que sabes que existe e não aparece:** pode ser um
registo antigo, recolhido antes de aquele campo passar a ser pesquisável.
Avisa quem administra — há uma forma de reconstruir a procura.

---

## 12. Corrigir um registo já submetido

Abre-o na lista e corrige. Ao gravar, fica uma **versão nova**.

**A versão antiga não desaparece.** É propositado: o histórico é o que permite
perceber o que mudou, quando e por quem. Ninguém vai apagar o teu trabalho.

Se o registo foi recolhido com uma **versão antiga do formulário**, a app
avisa-te e continua a mostrar as perguntas com que ele foi recolhido. Também é
de propósito: mudar as perguntas por baixo de respostas já dadas mudava o
significado do que lá está.

> ![Aviso de que o registo foi recolhido com uma versão anterior do formulário](imagens/20-versao-antiga.png)

---

## 13. Sincronizar

**Não tens de fazer nada.** Quando o telefone apanha rede, a app envia sozinha,
em segundo plano.

O que a app faz sozinha:

- Envia os registos submetidos, um a um, pela ordem em que foram feitos.
- Se a rede cair a meio, retoma de onde ficou. **Nunca duplica.**
- Se falhar, espera um pouco e tenta outra vez — cada vez espera mais, até
  cinco minutos.
- As fotografias vão a seguir, e só em Wi-Fi.

O que **tu** tens de fazer: olhar para a lista e confirmar que os ⏳ vão
desaparecendo.

> ![Lista com registos a passar de ⏳ para ✅](imagens/21-sincronizado.png)

Se ao fim de uns dias com rede continuar tudo em ⏳, **avisa**. É problema para
resolver, não para ignorar.

---

## 14. Quando corre mal

**Fiquei sem bateria a meio de um registo.**
Não perdeste nada. A app grava enquanto escreves. Carrega o telefone, abre
outra vez e continua de onde ias.

**A app fechou-se sozinha.**
O mesmo. Abre outra vez. Se acontecer muitas vezes, avisa — pode ser falta de
memória no telefone.

**Dois de nós recolhemos o mesmo local.**
Não faz mal. As duas versões ficam guardadas, o registo fica com ⚠️, e alguém
no escritório vê as duas lado a lado e decide qual vale. **Nunca** se perde
nenhuma das duas.

**Um formulário desapareceu da lista.**
Deixou de te estar atribuído. O que já recolheste com ele **sobe na mesma** —
esse trabalho não se perde.

**O telefone diz «sem posição» e o receptor está ligado.**
Confirma, por esta ordem: (1) o telefone está no Wi-Fi do receptor;
(2) o receptor tem vista para o céu; (3) o endereço nas definições está certo.
Se a app disser «o receptor está ligado mas não deu posição», o problema é do
receptor, não da app.

**Enganei-me no formulário e preenchi o errado.**
Grava como rascunho e não submetas. Diz ao teu supervisor — um rascunho não
submetido não vai para lado nenhum.

**Não consigo entrar.**
Precisas de rede para entrar da primeira vez. Se já entraste antes, a app
funciona sem rede. Se a senha não é aceite, é da tua conta e não da app.

---

## 15. Antes de entregar o telefone

Isto aplica-se sempre que o telefone muda de mãos, vai para reparação, ou vais
desinstalar a app.

1. Liga-te a uma rede.
2. Abre a lista de registos de **todos** os formulários.
3. Confirma que **não há nenhum ⏳**.
4. Só depois entrega o telefone.

> ![Lista sem nenhum registo em ⏳, tudo em ✅](imagens/22-tudo-sincronizado.png)

**Um telefone entregue com registos por sincronizar é a única forma conhecida
de perder trabalho de campo nesta plataforma.** Tudo o resto está protegido;
isto não.

---

## 16. Cartão de bolso

Para imprimir e levar no bolso.

```
┌──────────────────────────────────────────────────────┐
│  Consul Colect — o essencial                               │
├──────────────────────────────────────────────────────┤
│  NA DÚVIDA, GRAVA.                                   │
│  Um registo repetido resolve-se. Uma visita          │
│  perdida obriga alguém a voltar lá.                  │
├──────────────────────────────────────────────────────┤
│  MARCAS DA LISTA                                     │
│    📝 rascunho — ainda não submetido                 │
│    ⏳ à espera de rede — SÓ EXISTE NESTE TELEFONE    │
│    ✅ no servidor — seguro                           │
│    ⚠️ alguém no escritório tem de ver                │
├──────────────────────────────────────────────────────┤
│  QUALIDADE DO PONTO (melhor → pior)                  │
│    fixed → float → dgps → single                     │
│    Aviso laranja = escreve porquê. Podes gravar.     │
├──────────────────────────────────────────────────────┤
│  SEM POSIÇÃO?                                        │
│    céu aberto · esperar 30 s · tentar outra vez      │
│    Não vem? Grava o resto e volta lá depois.         │
├──────────────────────────────────────────────────────┤
│  NUNCA entregues o telefone com ⏳ na lista.         │
└──────────────────────────────────────────────────────┘
```

---

## Lista das fotografias a inserir

Grava todas em `docs/imagens/`. O manual referencia-as por estes nomes exactos.

| Ficheiro                       | O que tem de mostrar                             |
| ------------------------------ | ------------------------------------------------ |
| `01-instalar-permissao.png`    | Aviso do Android sobre origem desconhecida       |
| `02-instalar-concluido.png`    | Ecrã final da instalação, com «Abrir»            |
| `03-entrar.png`                | Ecrã inicial antes de entrar                     |
| `04-login.png`                 | Página de login do Keycloak                      |
| `05-sessao-iniciada.png`       | Ecrã inicial com sessão iniciada                 |
| `06-definicoes-receptor.png`   | Definições, as duas opções de receptor           |
| `07-receptor-externo.png`      | Definições com o endereço do receptor visível    |
| `08-receptor-ligado.png`       | «Estado agora» com uma precisão real             |
| `09-lista-formularios.png`     | Lista de formulários atribuídos                  |
| `10-formulario-inicio.png`     | Primeiro ecrã de um formulário                   |
| `11-seccoes.png`               | Barra de secções com o contador de erros         |
| `12-repetivel.png`             | Bloco repetível com duas instâncias              |
| `13-ponto-bom.png`             | Campo de geometria com um ponto de boa qualidade |
| `14-ponto-acima-do-limiar.png` | Aviso laranja e caixa de justificação            |
| `15-anexo-vazio.png`           | Campo de fotografia sem anexos                   |
| `16-anexo-com-fotos.png`       | Campo de fotografia com dois anexos              |
| `17-guardar-submeter.png`      | Barra inferior com os dois botões                |
| `18-lista-registos.png`        | Lista de registos com as marcas                  |
| `19-procurar.png`              | Procura com um resultado                         |
| `20-versao-antiga.png`         | Aviso de versão antiga do formulário             |
| `21-sincronizado.png`          | Registos a passar de ⏳ para ✅                  |
| `22-tudo-sincronizado.png`     | Lista sem nenhum ⏳                              |
