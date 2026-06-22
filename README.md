# HTML → Figma

Clone do html.to.design: extensão Chrome (MV3) captura DOM + estilos computados + geometria → JSON no clipboard → plugin do Figma reconstrói os nós.

## Estrutura

```
packages/
  shared/        Tipos do JSON intermediário (CaptureDocument, CapturedNode…)
  extension/     Extensão MV3 — popup, content script de captura, picker de elemento
  figma-plugin/  Plugin do Figma — cola o JSON e reconstrói frames/textos/imagens/SVGs
  relay/         Servidor WebSocket local (sem deps) — transfere capturas grandes
```

## Pipeline

1. **Extensão** percorre o DOM: `getComputedStyle` + `getBoundingClientRect` (coordenadas absolutas da página), converte imagens em data URLs, serializa em `CaptureDocument` e copia para o clipboard.
2. **Plugin** valida o marcador `h2f-capture`, e mapeia: `element` → Frame (fills, strokes, radius, shadows, clipsContent), `text` → TextNode (fonte com fallback Inter), `image` → Rectangle com image fill, `svg` → `createNodeFromSvg`.

## Build

```bash
npm install
npm run build
```

## Instalação

**Extensão:** `chrome://extensions` → modo desenvolvedor → "Carregar sem compactação" → `packages/extension/dist`.

**Plugin:** Figma desktop → Plugins → Development → "Import plugin from manifest…" → `packages/figma-plugin/manifest.json`.

## Uso

1. Na página alvo, clique na extensão → "Capturar página inteira" ou "Selecionar elemento…" (Esc cancela).
2. No Figma, rode o plugin, cole o JSON (Ctrl+V) e clique em "Importar".

### Transferência via servidor (opcional, para payloads grandes)

Capturas com muitas imagens estouram o clipboard. Rode o relay local:

```bash
npm run relay   # ws://localhost:7341 (porta via H2F_RELAY_PORT)
```

Com ele no ar, a extensão envia a captura direto pelo WebSocket e o plugin do
Figma **importa automaticamente** (o indicador "Servidor: conectado" fica verde).
Se o relay não estiver rodando, tudo cai no fluxo de clipboard normalmente.

## Já resolvido (v0.14)

- **Estilo de `<img>`**: imagens (`<img>`) agora também levam `border`,
  `box-shadow` e `opacity` — antes só `src`/`object-fit`/`border-radius`.

## Já resolvido (v0.13)

- **Texto com gradiente**: `background-clip: text` (+ gradiente) aplica o gradiente
  como fill do TextNode e limpa o background do elemento — em vez de texto
  transparente sobre um retângulo.

## Já resolvido (v0.12)

- **text-shadow**: vira `DROP_SHADOW` no TextNode (offset, blur, cor) — múltiplas
  sombras suportadas.

## Já resolvido (v0.11)

- **mix-blend-mode**: mapeado para o `blendMode` nativo do Figma (multiply,
  screen, overlay, etc.). `normal` não altera o nó.

## Já resolvido (v0.10)

- **background-size**: `cover` → `FILL` e `contain` → `FIT` por camada de imagem
  (antes tudo era `FILL`, esticando `contain`).

## Já resolvido (v0.9)

- **Blur**: `filter: blur()` vira `LAYER_BLUR` e `backdrop-filter: blur()` vira
  `BACKGROUND_BLUR` (glassmorphism) — efeitos nativos do Figma, sem rasterizar.
  Antes o `backdrop-filter` era perdido e `filter: blur` virava screenshot.

## Já resolvido (v0.8)

- **Grid com posicionamento explícito**: a célula de cada item (`grid-column`/
  `grid-row` e spans) é derivada da geometria real e aplicada no Figma via
  posicionamento MANUAL (`setGridChildPosition` + `gridColumnSpan`/`gridRowSpan`).
  Grids de auto-flow comum continuam no auto-flow (sem regressão).

## Já resolvido (v0.7)

- **Grid com tracks não-uniformes**: `grid-template-columns/rows` é capturado com
  o tamanho px de cada track (já resolvido pelo computed style, inclusive `fr`) e
  aplicado como tracks `FIXED` no Figma — `1fr 2fr 1fr`, `200px 1fr` etc. deixam
  de virar colunas iguais.

## Já resolvido (v0.6)

- **Múltiplas camadas de background**: `background-image` com várias camadas
  (ex.: gradiente sobre imagem, gradientes empilhados) é capturado como lista
  ordenada e empilhado como `fills` no Figma, na ordem correta de pintura.

## Já resolvido (v0.5)

- **Bordas por lado**: cada lado (`top`/`right`/`bottom`/`left`) é capturado com
  largura/cor/estilo próprios. No Figma, lados com a mesma cor usam larguras
  nativas por lado (`strokeTopWeight`…); cores divergentes (acento `border-left`,
  etc.) viram retângulos finos por lado para preservar a cor exata.
- **Gradientes radial/conic**: `radial-gradient` → `GRADIENT_RADIAL` e
  `conic-gradient` → `GRADIENT_ANGULAR` (com centro e from-angle), além do
  `linear-gradient` já existente.

## Já resolvido (v0.4)

- **Grid**: `display: grid` vira Grid layout nativo do Figma (`layoutMode = GRID`)
  com contagem de colunas/linhas e gaps; `flex-direction: *-reverse` é mapeado
  invertendo a ordem dos filhos.
- **Pseudo-elementos**: `::before`/`::after` com `content` viram TextNodes (texto)
  ou frames decorativos (background/border), posicionados de forma aproximada.
- **transform**: rotação (`rotate`/`matrix`) é extraída e aplicada via
  `node.rotation`, usando a caixa não-transformada para preservar o centro.
- **Screenshot por elemento**: `<canvas>`, `<video>` e elementos com `filter`
  são rasterizados via `captureVisibleTab` (recorte ×DPR) como fallback.
- **Relay WebSocket**: servidor local sem dependências transfere capturas grandes
  fora do clipboard, com buffer da última captura para o plugin que conecta depois.

## Já resolvido (v0.3)

- **Auto Layout**: `display: flex` (row/column) vira Auto Layout no Figma —
  gap, padding, align-items, justify-content e wrap mapeados; filhos
  `position: absolute/fixed` recebem `layoutPositioning: ABSOLUTE`.
- **Lazy load**: a captura rola a página inteira antes (dispara
  IntersectionObservers) e volta ao topo — sem mais seções vazias.

## Já resolvido (v0.2)

- Ordem de pintura aproximada por z-index (overlays/fixed pintam por cima).
- `position: fixed/sticky`: scroll é resetado para (0,0) antes da captura.
- Texto: um TextNode por linha visual (sem re-wrap no Figma).
- Imagens: fetch via service worker (bypassa CORS), conversão webp/avif→PNG/JPEG,
  downscale para o tamanho exibido ×DPR (cap 2048px), JPEG quando sem alpha.

## Limitações conhecidas

- Gradientes radial/conic: forma/tamanho não-circular e posições por keyword são
  aproximados. `background-size`/`background-position` por camada não são aplicados
  (imagens usam `scaleMode FILL`); só a ordem de empilhamento é fiel.
- Bordas multicolor: cantos arredondados ficam aproximados (overlays retangulares
  não seguem o raio); `dashed`/`dotted` viram sólido nos overlays.
- Pseudo-elementos: geometria aproximada (sem caixa real no DOM); `content`
  com `url()`/`counter()` não é resolvido.
- `transform`: só rotação (escala/skew/`matrix3d` ignorados); conteúdo aninhado
  de elementos rotacionados pode ficar levemente desalinhado.
- Screenshot por elemento só funciona se o elemento couber no viewport visível.
- Só `blur()` vira efeito nativo; outros filtros (`brightness`, `grayscale`,
  `drop-shadow`…) continuam no fallback de screenshot.
- `iframes` continuam ignorados; fontes precisam existir no Figma (senão, Inter).

## Próximos passos

- Escala/skew em `transform` e suporte a `matrix3d`.
- Screenshot de elementos maiores que o viewport (stitching de múltiplas capturas).
- `background-position`/`background-repeat` (TILE) e `background-size` em px por
  camada (hoje só `cover`/`contain`; exigem `imageTransform`/`scalingFactor`).
