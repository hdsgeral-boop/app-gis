# Instalar o Consul Colect num telefone

O ficheiro `.apk` desta pasta instala-se à mão. **Não está na Play Store**, e é
de propósito: uma app de trabalho interno não precisa de passar pela loja, e a
revisão dela demoraria dias a cada correcção.

---

## Instalar

1. Copia o `.apk` para o telefone — por cabo, por Bluetooth, por cartão, ou
   partilha o ficheiro num link.
2. Abre o ficheiro no telefone. O Android vai avisar que não instala aplicações
   de origem desconhecida.
3. Toca em **Definições** nesse aviso e liga **Permitir desta origem**.
4. Volta atrás e toca em **Instalar**.

Depois de instalada, o ícone é o losango vermelho, amarelo e preto, com o nome
**Consul Colect**.

## Se aparecer «aplicação não instalada»

Quase sempre é uma versão antiga com outra assinatura ainda instalada.
Desinstala a antiga primeiro — **mas só depois de confirmares que ela não tem
registos por enviar**. Abre a app antiga, vai a **Por enviar**, e confirma que
está a zero.

## Qual é o ficheiro certo

| Ficheiro                             | Para quê                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `consul-colect-<versão>-debug.apk`   | testes. Traz ferramentas de diagnóstico e é maior; precisa do servidor de desenvolvimento a correr no computador. |
| `consul-colect-<versão>-release.apk` | terreno. Menor, mais rápido, e aponta para o servidor de produção.                                                |

Para dar a técnicos, é sempre o **release**. Ver `docs/CENARIOS-DE-PRODUCAO.md`
para o gerar com o endereço do teu servidor.

## Primeira utilização

Precisas de rede **uma vez**, para entrar. A partir daí trabalha-se dias
inteiros sem rede nenhuma.

O manual completo, para dar aos técnicos, está em
`docs/MANUAL-DO-TECNICO.md`.
