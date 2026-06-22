# Design — Bordas por lado + gradientes radial/conic

Data: 2026-06-22
Branch: `feat/grid-pseudo-screenshot-relay`

## Objetivo

Fechar dois gaps comuns de fidelidade no pipeline HTML→Figma:

1. **Bordas por lado** — hoje a captura lê só `border-top-*` e aplica uniforme.
   Padrões reais (acento `border-left`, `border-bottom` de inputs, bordas com
   cores diferentes por lado) colapsam.
2. **Gradientes radial/conic** — hoje só `linear-gradient` é suportado; o resto
   vira `null`.

Escopo decidido: bordas com fidelidade **híbrida**; gradientes **radial + conic,
uma camada de background** (sem múltiplas camadas empilhadas nesta entrega).

## Schema (`packages/shared/src/index.ts`)

Bump `SCHEMA_VERSION` 3 → 4. Produtor (extensão) e consumidor (plugin) sobem
juntos, então não há migração — só o bump.

### Bordas

Substituir `border: Border | null` por per-side. Remover o tipo `Border`.

```ts
export interface SideBorder {
  width: number;
  color: string; // rgba()
  style: "solid" | "dashed" | "dotted";
}
export interface Borders {
  top: SideBorder | null;
  right: SideBorder | null;
  bottom: SideBorder | null;
  left: SideBorder | null;
}
```

`ElementStyles.border` → `borders: Borders | null` (null quando nenhum lado tem
borda visível).

### Gradiente

```ts
export interface Gradient {
  type: "linear" | "radial" | "conic";
  angle: number;                    // linear: direção; conic: from-angle; radial: 0
  center: { x: number; y: number }; // 0..1; radial/conic; linear ignora (default 0.5/0.5)
  stops: { color: string; position: number }[];
}
```

`center` sempre presente (default `{x:0.5,y:0.5}`).

## Captura (`packages/extension/src/capture.ts`)

- Novo helper `parseBorders(cs): Borders | null`. Para cada lado lê
  `border{Top,Right,Bottom,Left}{Width,Color,Style}`; um lado existe quando
  `width > 0 && style !== "none"`. Retorna `null` se nenhum lado existe.
  Substitui os dois blocos inline de borda (≈399 e ≈763).
- `parseGradient(v)` ganha três ramos, reusando `splitTopLevel` e o parse de
  stops existentes:
  - `linear-gradient(…)`: comportamento atual (`type:"linear"`, `center` default).
  - `radial-gradient(…)`: parseia prefixo opcional `[forma tamanho] at <pos>` →
    `center` (default 50%/50%); resto vira stops; `type:"radial"`, `angle:0`.
  - `conic-gradient(…)`: parseia `from <ângulo>` e `at <pos>` → `angle` + `center`;
    resto stops; `type:"conic"`.
  - Posições por keyword (`center`/`left`/`top`/…) mapeadas para 0/0.5/1.
- A checagem `hasBg` (≈376) passa a olhar `styles.borders` em vez de `styles.border`.

## Plugin (`packages/figma-plugin/src/code.ts`)

### `applyBorders(f, borders)` — substitui o bloco atual (96–105)

- Coleta os lados visíveis.
- **Cor + estilo iguais em todos os lados visíveis** → larguras nativas por lado:
  `f.strokeTopWeight/RightWeight/BottomWeight/LeftWeight` (0 nos ausentes), um
  único `f.strokes` com a cor, `f.strokeAlign = "INSIDE"`, `dashPattern` conforme
  o estilo. Caminho comum, barato. (Borda single-side cai aqui naturalmente.)
- **Cores/estilos divergentes** → não usa stroke do nó; cria um retângulo fino
  por lado visível, anexado **depois** dos filhos (topo da ordem de pintura),
  posicionado na aresta em coordenadas locais do frame:
  - top: `x=0, y=0, w=frameW, h=width`
  - bottom: `x=0, y=frameH-width, w=frameW, h=width`
  - left: `x=0, y=0, w=width, h=frameH`
  - right: `x=frameW-width, y=0, w=width, h=frameH`
  - Cada um com fill `SOLID` da cor do lado. Se o frame tem Auto Layout, os rects
    recebem `layoutPositioning = "ABSOLUTE"`.

### `gradientPaint(g)` — ramifica por `g.type`

- `linear` → `GRADIENT_LINEAR` (transform atual, `angle - 90`).
- `radial` → `GRADIENT_RADIAL`, `gradientTransform` centrado em `g.center`,
  escala ~0.5 cobrindo a caixa.
- `conic` → `GRADIENT_ANGULAR`, rotação a partir de `g.angle`, centro em `g.center`.

## Testes

- `test/fixture.html` ganha quatro casos novos:
  - elemento só com `border-bottom`;
  - elemento com borda multicolor (acento `border-left` azul + resto cinza);
  - background `radial-gradient`;
  - background `conic-gradient`.
- Novo `test/assert.mjs`: roda `run_capture.mjs`, parseia o JSON e afirma:
  - `borders` por lado presente, com o lado certo preenchido e os outros `null`
    no caso single-side; quatro lados com cores corretas no caso multicolor;
  - gradientes com `type:"radial"` e `type:"conic"`, `center` e `stops` corretos.
  - Sai com código ≠ 0 se alguma asserção falha. Cobre o lado da **captura**
    automaticamente.
- O lado do **plugin** (render no Figma) não é unit-testável fora do runtime do
  Figma → verificação manual: colar o JSON no plugin e conferir bordas e
  gradientes visualmente. Listado como passo de verificação no plano.

## Limitações assumidas (documentar no README)

- Borda multicolor: cantos arredondados ficam aproximados (overlays retangulares
  não seguem o raio); `dashed`/`dotted` vira sólido nos overlays.
- Radial/conic: forma/tamanho não-circular e posições por keyword são aproximados
  ao mapear para o `gradientTransform` do Figma.
- Múltiplas camadas de `background-image` continuam fora do escopo (só a primeira).
