# Fotografias do manual

Grava aqui as imagens do `docs/MANUAL-DO-TECNICO.md`, com os nomes exactos que
a última secção do manual lista (`01-instalar-permissao.png` a
`22-tudo-sincronizado.png`).

## Como as tirar

No telefone, **ligar + baixar volume** ao mesmo tempo. Ou, com o cabo ligado e
o `adb` no PATH:

```bash
adb exec-out screencap -p > docs/imagens/03-entrar.png
```

## Antes de tirar

- **Fecha o que estiver a flutuar por cima** (vídeos em picture-in-picture,
  bolhas de mensagens). Aparecem na captura.
- **Fecha o menu de programador** do Expo — se aparecer, toca no ✕.
- Usa dados de demonstração, nunca dados de um cliente a sério: uma imagem num
  manual acaba sempre por sair da empresa.
- Telefone em português, para o que se vê na imagem bater com o texto.
