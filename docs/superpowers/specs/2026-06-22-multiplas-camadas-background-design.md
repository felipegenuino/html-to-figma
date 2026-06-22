# Design — Múltiplas camadas de background-image

Data: 2026-06-22
Branch: `feat/grid-pseudo-screenshot-relay`

## Objetivo

Hoje a captura trata `background-image` como **uma** coisa: ou uma `url()`
(imagem) ou um gradiente. CSS permite várias camadas separadas por vírgula
(ex.: `linear-gradient(...) , url(...)` — overlay de gradiente sobre imagem, o
padrão de hero section). Suportar a lista completa, empilhada na ordem certa.

## Schema (`packages/shared/src/index.ts`) — bump v4 → v5

Substituir os dois campos paralelos `backgroundImage: string|null` e
`gradient: Gradient|null` por uma lista ordenada de camadas:

```ts
export type BackgroundLayer =
  | { kind: "image"; src: string }          // data URL
  | { kind: "gradient"; gradient: Gradient };
```

`ElementStyles.backgroundLayers: BackgroundLayer[]` (vazio quando não há
background-image). Ordem = ordem do CSS: índice 0 é a camada **mais ao topo**
(visualmente na frente). `backgroundColor` continua separado (pinta atrás de tudo).

## Captura (`packages/extension/src/capture.ts`)

- Novo helper `parseBackgroundLayers(bgi, resolveImage)`:
  - `splitTopLevel(bgi)` separa as camadas respeitando parênteses.
  - Para cada parte: `url(...)` → `await resolveImage(url)` → `{kind:"image"}`
    (descarta se a conversão falhar); senão `parseGradient(parte)` →
    `{kind:"gradient"}` (descarta se null).
  - `resolveImage` é injetado porque o tamanho-alvo difere: pseudo usa `(w,h)`,
    elemento usa o `getBoundingClientRect`.
- Os dois blocos inline (`pseudoStyles` ≈392 e o styles principal ≈740) passam a
  chamar o helper e devolver `backgroundLayers`.
- A checagem `visible` do pseudo (≈378) passa a olhar `backgroundLayers.length`.

## Plugin (`packages/figma-plugin/src/code.ts`)

- `buildElement` monta os `fills` na ordem de pintura do Figma (último = topo):
  1. `backgroundColor` (se houver) — fundo.
  2. as camadas em **ordem reversa** do CSS (CSS camada 0 = topo → vai por último
     no array de fills).
  - imagem → `{type:"IMAGE", imageHash, scaleMode:"FILL"}`; gradiente →
    `gradientPaint(...)` (já suporta linear/radial/conic).
- Remove os ramos antigos baseados em `s.gradient` / `s.backgroundImage`.

## Testes

- `test/fixture.html`: nova seção com dois gradientes empilhados
  (`linear-gradient(...) , radial-gradient(...)`) e, se prático, gradiente sobre
  `url(data:...)`.
- `test/assert.mjs`: afirma `backgroundLayers.length === 2` na seção empilhada,
  com `kind` e ordem corretos (camada 0 = o primeiro gradiente do CSS).
- Render no Figma: verificação manual (empilhamento de fills não é testável fora
  do runtime do Figma).

## Limitações assumidas

- `background-size`/`background-position` por camada não são aplicados (todas as
  imagens usam `scaleMode FILL`); só a ordem de empilhamento é fiel.
