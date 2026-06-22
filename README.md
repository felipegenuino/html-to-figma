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

- Gradientes: só `linear-gradient` simples; borda uniforme (usa `border-top`).
- Pseudo-elementos: geometria aproximada (sem caixa real no DOM); `content`
  com `url()`/`counter()` não é resolvido.
- `transform`: só rotação (escala/skew/`matrix3d` ignorados); conteúdo aninhado
  de elementos rotacionados pode ficar levemente desalinhado.
- Screenshot por elemento só funciona se o elemento couber no viewport visível.
- `iframes` continuam ignorados; fontes precisam existir no Figma (senão, Inter).

## Próximos passos

- Grid com posicionamento explícito (`grid-row`/`grid-column`) e tracks não-uniformes.
- Escala/skew em `transform` e suporte a `matrix3d`.
- Screenshot de elementos maiores que o viewport (stitching de múltiplas capturas).
- `radial-gradient`/`conic-gradient` e bordas por lado.
