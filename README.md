# HTML → Figma

Clone do html.to.design: extensão Chrome (MV3) captura DOM + estilos computados + geometria → JSON no clipboard → plugin do Figma reconstrói os nós.

## Estrutura

```
packages/
  shared/        Tipos do JSON intermediário (CaptureDocument, CapturedNode…)
  extension/     Extensão MV3 — popup, content script de captura, picker de elemento
  figma-plugin/  Plugin do Figma — cola o JSON e reconstrói frames/textos/imagens/SVGs
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

## Já resolvido (v0.2)

- Ordem de pintura aproximada por z-index (overlays/fixed pintam por cima).
- `position: fixed/sticky`: scroll é resetado para (0,0) antes da captura.
- Texto: um TextNode por linha visual (sem re-wrap no Figma).
- Imagens: fetch via service worker (bypassa CORS), conversão webp/avif→PNG/JPEG,
  downscale para o tamanho exibido ×DPR (cap 2048px), JPEG quando sem alpha.

## Limitações conhecidas

- Posicionamento absoluto (sem Auto Layout).
- Gradientes: só `linear-gradient` simples; borda uniforme (usa `border-top`).
- Pseudo-elementos (`::before`/`::after`), `transform`, `filter` e iframes são ignorados.
- Fontes precisam existir no Figma; senão cai para Inter.

## Próximos passos

- Auto Layout a partir de flex/grid detectado.
- Captura de pseudo-elementos e `transform`.
- Screenshot por elemento como fallback de fidelidade.
- Transferência via WebSocket/servidor local em vez de clipboard (payloads grandes).
