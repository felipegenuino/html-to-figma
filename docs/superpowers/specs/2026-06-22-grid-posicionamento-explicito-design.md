# Design — Grid com posicionamento explícito + spans

Data: 2026-06-22
Branch: `feat/grid-pseudo-screenshot-relay`

## Objetivo

Itens de grid com `grid-column`/`grid-row` (placement explícito) ou spans hoje
caem no auto-flow do Figma, perdendo posição/tamanho (ex.: um item que ocupa 2
colunas, um hero que abrange 2 linhas). Reconstruir a célula real de cada item.

## Abordagem: geometria, não auto-placement

Em vez de emular o algoritmo de auto-placement do CSS, derivamos a célula de
cada item casando sua geometria real contra os offsets cumulativos das tracks
(que já capturamos — `columnSizes`/`rowSizes`, com linhas implícitas incluídas
pelo computed style). Funciona igual para itens explícitos e auto-posicionados,
porque lê onde o browser de fato colocou cada um.

## Schema (`packages/shared/src/index.ts`) — bump v6 → v7

`BaseNode` ganha placement opcional (preenchido só para filhos de grid não
`absolute`):

```ts
gridArea?: {
  columnStart: number; // índice 0-based
  columnSpan: number;  // >= 1
  rowStart: number;
  rowSpan: number;
};
```

## Captura (`packages/extension/src/capture.ts`)

- Em `walkElement`, quando `layout.mode === "grid"`, calcular `gridArea` de cada
  filho de elemento (pular `absolute`):
  - origem do content-box = `rect` do container + `border` + `padding`.
  - fronteiras das colunas: `colLeft[i]` cumulativo (`+ columnSizes + columnGap`),
    `colRight[i] = colLeft[i] + columnSizes[i]`; idem linhas.
  - `columnStart` = índice de `colLeft` mais próximo de `left` do item (relativo);
    `columnSpan = nearest(colRight, right) - columnStart + 1` (clamp ≥ 1). Idem
    linhas.
- Helper `computeGridAreas(layout, containerRect, cs, children)`.

## Plugin (`packages/figma-plugin/src/code.ts`)

- Em `buildElement`, após anexar os filhos, se o pai é grid:
  - Coletar os `gridArea` dos filhos. Se **todos** forem 1×1 e seguirem a ordem
    row-major natural (`row = ⌊k/cols⌋`, `col = k%cols`) → manter auto-flow atual
    (sem regressão).
  - Senão (algum span > 1 ou placement não-sequencial) → `gridItemsPositioning =
    "MANUAL"`; para cada filho com `gridArea`: `setGridChildPosition(rowStart,
    columnStart)` e setar `gridColumnSpan`/`gridRowSpan`.
  - Defensivo: ampliar `gridRowCount`/`gridColumnCount` para cobrir o maior
    `start + span`.
  - Filhos `absolute` (overlays de borda, itens out-of-flow) ficam
    `layoutPositioning = "ABSOLUTE"`, isentos do placement.

## Testes

- `test/fixture.html`: grid 3×2 com `.wide` (`grid-column: 1/3`), `.tall`
  (`grid-column: 3; grid-row: 1/3`) e dois itens auto.
- `test/assert.mjs`: `.wide` → `columnSpan === 2`, `rowStart === 0`; `.tall` →
  `rowSpan === 2`, `columnStart === 2`.
- Render no Figma: verificação via MCP.

## Limitações assumidas

- Placement derivado da geometria renderizada — itens sobrepostos (mesma célula)
  ou fora das fronteiras das tracks são casados pelo índice mais próximo.
- `grid-template-areas` nomeadas não são lidas diretamente, mas o resultado
  geométrico é o mesmo.
