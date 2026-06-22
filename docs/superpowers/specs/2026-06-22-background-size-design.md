# Design — background-size por camada (cover/contain → FILL/FIT)

Data: 2026-06-22

## Objetivo

Camadas de imagem de background hoje entram sempre como `scaleMode: FILL`, então
`background-size: contain` (logos/ícones) renderiza esticado. Mapear o size por
camada: `cover → FILL`, `contain → FIT`, demais → FILL.

## Schema (v8 → v9)

Variante de imagem de `BackgroundLayer` ganha `scaleMode`:

```ts
| { kind: "image"; src: string; scaleMode: "FILL" | "FIT" }
```

## Captura

- `parseBackgroundLayers` passa a receber também `cs.backgroundSize`, dividido por
  `splitTopLevel` e alinhado por índice às camadas de `background-image`.
- `cover → "FILL"`, `contain → "FIT"`, qualquer outro (auto, px) → "FILL".

## Plugin

- Fill de imagem usa `layer.scaleMode` em vez do `"FILL"` fixo.

## Testes

- Fixture `.bg-contain` (`background-size: contain`); assert camada
  `scaleMode === "FIT"`. A `.bg` existente (`cover`) → `FILL`.

## Limitações

- `background-position`, `background-repeat` (TILE) e tamanhos explícitos em px
  ficam para depois (exigem `imageTransform`/`scalingFactor` com dimensões
  naturais da imagem).
