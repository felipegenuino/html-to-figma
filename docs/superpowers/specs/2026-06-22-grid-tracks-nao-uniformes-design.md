# Design — Grid com tracks não-uniformes

Data: 2026-06-22
Branch: `feat/grid-pseudo-screenshot-relay`

## Objetivo

Hoje o mapeamento de grid usa só a **contagem** de colunas/linhas
(`gridColumnCount`/`gridRowCount`), então toda track vira FLEX uniforme. Um grid
`grid-template-columns: 1fr 2fr 1fr` ou `200px 1fr` renderiza como 3 colunas
iguais — errado. Capturar os **tamanhos** de cada track e aplicá-los como tracks
`FIXED` no Figma.

`getComputedStyle().gridTemplateColumns/Rows` já resolve tudo em px (inclusive
`fr` e `auto`), então o snapshot fica fiel ao que foi renderizado.

Fora de escopo (follow-up imediato): posicionamento explícito por linha
(`grid-column`/`grid-row`) e spans — precisa emular o auto-placement do CSS para
grids mistos. Documentado como limitação.

## Schema (`packages/shared/src/index.ts`) — bump v5 → v6

`AutoLayout` ganha os tamanhos de track (px), mantendo `columns`/`rows`:

```ts
columnSizes: number[]; // px por coluna; vazio = manter FLEX uniforme
rowSizes: number[];    // px por linha; vazio = manter FLEX/auto
```

## Captura (`packages/extension/src/capture.ts`)

- Novo `parseTracks(template): number[]` (substitui/complementa `countTracks`):
  remove nomes de linha `[...]`, separa as tracks e converte cada uma em px
  (`parseFloat`); descarta o que não resolve em número.
- `gridLayout` passa a preencher `columnSizes = parseTracks(gridTemplateColumns)`
  e `rowSizes = parseTracks(gridTemplateRows)`; `columns = columnSizes.length`,
  `rows = max(rowSizes.length, 1)`.
- `flexLayout` e os defaults preenchem `columnSizes: []`, `rowSizes: []`.

## Plugin (`packages/figma-plugin/src/code.ts`)

- No ramo grid de `applyLayout`, depois de setar `gridColumnCount`/`gridRowCount`:
  - para cada track em `L.columnSizes`, setar `f.gridColumnSizes[i].type = "FIXED"`
    e `.value = px`;
  - idem `L.rowSizes` / `f.gridRowSizes`.
  - Tracks sem tamanho capturado ficam no default (FLEX), preservando o
    comportamento atual.

## Testes

- `test/fixture.html`: nova seção grid com colunas não-uniformes
  (`grid-template-columns: 1fr 2fr 1fr` → resolve para px distintos).
- `test/assert.mjs`: afirma `layout.columnSizes` com 3 valores e que os do meio
  são maiores que os das pontas (proporção 1:2:1).
- Render no Figma: verificação via MCP (re-importar e conferir larguras das
  colunas).

## Limitações assumidas

- Tracks viram `FIXED` px (perde responsividade `fr`/`auto`) — correto para um
  snapshot estático, que é o propósito da ferramenta.
- Posicionamento explícito (`grid-column`/`grid-row`) e spans ainda não; itens
  seguem o auto-flow do Figma (`ROW_AUTO_FLOW`).
