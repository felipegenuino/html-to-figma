# Arquitetura da captura HTML → Figma

Visão geral do pipeline, do schema e das decisões/limites descobertos testando
contra um site real (leandroboeira.com). Serve de mapa para retomar o trabalho.

## Pipeline (extensão → JSON → plugin)

```
página viva ──[content script: capture()]──► CaptureDocument (JSON)
                                                   │ clipboard ou relay WS
                                                   ▼
                                          plugin Figma ──► nós (frames/text/img/svg)
```

### `capture(root)` — `packages/extension/src/capture.ts`

Ordem atual (cada passo existe por um motivo descoberto na marra):

1. **`freezeAnimations()`** — injeta `*{transition:none; animation-duration:1ms}`
   para animações de entrada (translate/scale ao revelar) saltarem ao estado
   final, em vez de serem capturadas no meio (ex.: imagem do hero parando fora
   da caixa).
2. **`preloadLazyContent()`** — rola até o footer em 2 passadas (esperas por
   passo + assenta no rodapé), disparando lazy-load, IntersectionObservers e
   componentes que só montam quando entram na viewport. Recalcula `scrollHeight`
   no loop (conteúdo montado aumenta a altura).
3. **`findOverlayRoots()`** — detecta overlays interativos escondidos
   (menu/modal/drawer) ainda no footer (já montados): ocultos + `fixed/absolute`
   cobrindo área grande, ou casando `[role=dialog]`/`[aria-modal]`/`.overlay`/
   `.menu`/`.modal`/`.drawer`; sobe para o container mais externo (junta menu
   fatiado) e remove aninhados.
4. **Volta ao topo + revela RÁPIDO** — `scrollTo(0,0)` e `forceRevealHidden()`
   logo em seguida. Conteúdo virtualizado desmonta ao sair da viewport; capturar
   rápido evita perdê-lo (esperar demais aqui = seções do meio somem).
5. **`walkElement(root)`** — reconstrói a árvore (estática, pulando os overlays).
6. **Estado "click"** — para cada overlay: `forceOverlayVisible()` + `walkElement`,
   incluído só se tiver conteúdo real (`hasVisibleContent`: texto ou imagem
   raster; SVG sozinho não conta — descarta lightbox vazio).
7. **`finally`** — restaura reveal/freeze, limpa `skipInWalk`, volta o scroll.

### `forceRevealHidden(exclude)`
Passe no DOM forçando visível só estados **totalmente** escondidos
(`opacity:0`, `visibility:hidden`, `content-visibility:auto`) — preserva opacity
parcial (ex.: 0.8) e `transform` (rotação). Devolve um desfazer (restaura inline).

### `walkElement(el)`
DFS: pula `SKIP_TAGS` e `skipInWalk`; `isInvisible` corta zero-área/escondido;
`SVGSVGElement`→svg, `HTMLImageElement`→image, `shouldScreenshot` (canvas/video/
filter não-blur que cabe no viewport)→rasteriza; senão monta `element` com
filhos (texto por linha visual; pseudo `::before/::after`; reorder por paint
order/z-index). `computeGridAreas` deriva a célula de cada filho de grid pela
geometria real.

## Schema (`packages/shared/src/index.ts`, v14)

`CaptureDocument { marker, version, source, root, overlays }`. Nós: `element`
(styles + children), `text` (1 por linha visual), `image` (src dataURL,
objectFit, borders, boxShadow, opacity), `svg` (outerHTML). `ElementStyles`
cobre bg color/layers, borders por lado, radius, boxShadow, layerBlur/
backgroundBlur, blendMode, opacity, overflow, layout (flex/grid c/ tracks),
rotation. Coordenadas **absolutas à página**; cores `rgba()`; unidades px.

## Plugin (`packages/figma-plugin/src/code.ts`)
`buildRoot` cria o frame principal; cada `overlays[]` vira um frame "▸ overlay N"
à direita. `buildElement/Text/Image/Svg` mapeiam para nós Figma (fills, strokes
por lado, efeitos, blendMode, GRID/Auto Layout, gradientes linear/radial/conic).

## Testes
- `npm test` → `test/assert.mjs`: roda a captura em Chrome headless (CDP, via
  `run_capture.mjs`) contra `test/fixture.html` e afirma o shape do JSON para
  cada feature. **Cobre o lado da captura**, não o render no Figma.
- `npm run typecheck` → `tsc --noEmit` nos dois pacotes.
- Render no Figma: verificado manualmente via MCP a cada iteração (o loop que
  pegou a maioria dos bugs de runtime).

## Tensão de timing conhecida (snapshot único no topo)

Capturar tudo num único snapshot no topo tem requisitos conflitantes:

| Espera antes de capturar | Conteúdo virtualizado (desmonta) | Hero com parallax JS |
|---|---|---|
| rápido (~2 frames) | ✅ presente | ❌ deslocado (não assentou) |
| ~150ms | ⚠️ às vezes perde o último | ~melhor |
| 400ms | ❌ desmonta (some) | ✅ assentado |

- **Parallax via JS** (transform por rAF lendo o scroll): o `freezeAnimations`
  só controla CSS, não JS — o hero pode ficar alguns px fora.
- **Virtualização** (React desmonta off-screen): precisa ser pego antes do
  desmonte.

Escolha atual: **capturar rápido** (conteúdo completo > pixel do hero).

## Próximo grande passo: capturar durante o scroll

Resolve parallax E virtualização de uma vez: ler a geometria de cada elemento
**enquanto ele está na viewport**, descendo a página, em vez de um snapshot no
topo. Design proposto (implementar COM verificação via MCP):

1. **`walkElement(el, inFixed)`** — propaga um booleano `inFixed` (true quando o
   elemento ou um ancestral é `position:fixed`).
2. **`pageRect(r, inFixed)`** — para `inFixed`, `y = r.top` (sem somar `scrollY`),
   pois fixos são presos à viewport; a posição "scroll-0" é `r.top`. Threadar
   `inFixed` por svg/image/text/pseudo também (a fixação propaga para a subárvore).
3. **Scroll-following** — no topo de `walkElement`, se `!inFixed` e o elemento
   está abaixo da viewport, `scrollIntoView` + `await frame` + revelar a
   subárvore (re-montados podem nascer escondidos), e só então ler `r`. Scroll
   monotônico (DFS ~ top-down) ⇒ ~`alturaPágina/viewport` scrolls.
4. **Hero**: lido primeiro, com a página assentada no topo ⇒ parallax correto.
   **Mid-page**: re-montado ao ser alcançado ⇒ não some.
5. **`sticky`**: limite — quando "grudado" durante o scroll pode ficar deslocado;
   tratar como `fixed` quando detectar que está preso, ou aceitar aproximação.

Riscos a validar no site real: posição de `fixed/sticky`, performance (esperas
por viewport) e semântica de parallax em elementos do meio. Por isso **não foi
implementado às cegas** — requer o loop de verificação MCP.
