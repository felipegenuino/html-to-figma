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
4. **Volta ao topo + ASSENTA + revela** — `scrollTo(0,0)`, espera ~350ms (o
   parallax JS do hero estabiliza; o topo fica em vista, então não desmonta) e
   `forceRevealHidden()`.
5. **`walkElement(root)` com SCROLL-FOLLOWING** — reconstrói a árvore (estática,
   pulando os overlays), rolando cada elemento off-screen para a viewport antes
   de medir (re-monta conteúdo virtualizado, revela o que nasceu escondido).
   Resolve parallax (hero lido assentado no topo) e virtualização de uma vez.
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

## Scroll-following (implementado)

Resolve parallax E virtualização de uma vez: lê a geometria de cada elemento
**enquanto está na viewport**, descendo a página, em vez de um snapshot no topo.

- **`scrollIntoViewIfNeeded(el)`** no topo de `walkElement`: se o elemento está
  fora da viewport, `scrollIntoView` + espera (IO/mount/lazy) + `forceRevealSubtree`
  (re-montados podem nascer escondidos), e só então mede. Scroll monotônico
  (DFS ~ top-down) ⇒ ~`alturaPágina/viewport` scrolls; on-screen não rola.
- **Coordenadas com fixed**: `fixedScrollSuppressed` (contador de módulo) zera o
  offset de scroll dentro de subárvores `position:fixed` (presas à viewport), de
  forma que `pageRect`/`pseudoNode`/`untransformedRect` dão a posição "scroll-0".
  walkElement incrementa/decrementa ao entrar/sair de um fixed; fixos não rolam.
- **Hero**: lido primeiro, com a página assentada no topo ⇒ parallax correto.
  **Mid-page virtualizado**: re-montado ao ser alcançado ⇒ não some.

- **Sticky**: pode estar "grudado" (deslocado do fluxo) quando o walker chega
  nele. `walkElement` troca `position: sticky → relative` (mesmo layout de
  fluxo) durante a medição da subárvore e restaura depois — o elemento sai na
  posição natural, como a página é vista no scroll 0
  (spec: `docs/superpowers/specs/2026-07-07-sticky-scroll-following-design.md`).

Coberto headless por `test/fixture.html` (`.virt-test` desmonta off-screen via
IntersectionObserver; `.sticky-test` mede sticky grudado) + assert.

## Próximos passos
- Escala/skew em `transform` e `matrix3d`.
- `object-position`/`background-position`/`background-repeat` (imageTransform/TILE).
