# Design — Blur (filter / backdrop-filter) → efeitos nativos

Data: 2026-06-22
Branch: `feat/grid-pseudo-screenshot-relay`

## Objetivo

Glassmorphism é onipresente em UI moderna. Hoje:
- `backdrop-filter: blur()` é **totalmente perdido** (`shouldScreenshot` só olha
  `filter`; a reconstrução normal ignora backdrop).
- `filter: blur()` vira screenshot rasterizado (perde vetor/edição).

Mapear ambos para os efeitos nativos do Figma: `LAYER_BLUR` (filter) e
`BACKGROUND_BLUR` (backdrop-filter).

## Schema (`packages/shared/src/index.ts`) — bump v7 → v8

`ElementStyles` ganha:

```ts
layerBlur: number;       // px (filter: blur); 0 = nenhum
backgroundBlur: number;  // px (backdrop-filter: blur); 0 = nenhum
```

## Captura (`packages/extension/src/capture.ts`)

- `parseBlur(value): number` — retorna o raio só quando o valor é **um único**
  `blur(Npx)` (regex `^blur\(([\d.]+)px\)$`); senão 0. Filtros compostos
  (`blur() brightness()`) → 0, caem no screenshot como antes.
- `elementStyles`/`pseudoStyles`/`defaultStyles`: `layerBlur = parseBlur(cs.filter)`,
  `backgroundBlur = parseBlur(cs.backdropFilter)`.
- `shouldScreenshot`: filtro só é candidato a screenshot se **não** for blur puro
  (`filter !== none && !blurPuro`). Canvas/vídeo seguem como antes.

## Plugin (`packages/figma-plugin/src/code.ts`)

- Em `buildElement`, montar `f.effects` = sombras (atual) + efeitos de blur:
  - `layerBlur > 0` → `{ type: "LAYER_BLUR", radius, visible: true, blurType: "NORMAL" }`
  - `backgroundBlur > 0` → `{ type: "BACKGROUND_BLUR", radius, visible: true, blurType: "NORMAL" }`

## Testes

- `test/fixture.html`: `.blurred` (`filter: blur(4px)`) e `.glass`
  (`backdrop-filter: blur(8px)`, fundo semi-transparente).
- `test/assert.mjs`: `.blurred` → `styles.layerBlur === 4`; `.glass` →
  `styles.backgroundBlur === 8`.
  - Nota: o harness headless não tem o background da extensão, então o screenshot
    falha e o elemento cai na reconstrução normal — o que permite afirmar
    `layerBlur` mesmo no caso `filter`. A exclusão do screenshot para blur puro é
    verificada por raciocínio + plugin real.
- Render no Figma: verificação via MCP.

## Limitações assumidas

- Só `blur()`; outros filtros (`brightness`, `grayscale`, `drop-shadow`, etc.)
  continuam no fallback de screenshot.
- `BACKGROUND_BLUR` só aparece se o fill tiver alpha < 1 (caso glassmorphism).
