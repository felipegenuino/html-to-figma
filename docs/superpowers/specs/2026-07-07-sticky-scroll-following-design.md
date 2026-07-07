# Sticky durante o scroll-following — design

**Data:** 2026-07-07
**Status:** aprovado

## Problema

Durante o scroll-following da captura (`walkElement` rola cada elemento
off-screen até a viewport antes de medir), um elemento `position: sticky`
que está **grudado** é medido na posição da viewport onde travou (ex.:
`top: 0`). O `pageRect` soma o scroll atual, então o elemento é gravado em
`y = scrollY + topGrudado` — um valor arbitrário que depende de onde a
página estava quando o walker passou por ele, não de onde o elemento vive
no layout. Filhos, pseudo-elementos e screenshots da subárvore herdam o
mesmo deslocamento.

## Semântica escolhida

O sticky aparece no frame do Figma na sua **posição natural de fluxo**
(como a página é vista com scroll no topo) — consistente com o resto da
captura, que é um snapshot "scroll 0". Um header sticky que nasce no topo
fica no topo; um sidebar sticky fica onde começa no fluxo.

Alternativas descartadas:

- **Posição grudada / tratar como fixed** (nota antiga do ARCHITECTURE.md):
  gravaria o sticky em `y≈0` mesmo quando sua posição natural é mid-page —
  só funciona por acidente para headers que já nascem no topo.
- **Nó extra com estado grudado** (como os overlays de "click"): mais
  completo, porém mais complexidade e ruído no output. YAGNI.

## Solução: forçar `position: relative` durante a medição

`position: sticky` é, por definição, "relative no fluxo + offset quando
grudado": o elemento **ocupa espaço no fluxo normalmente** (diferente de
fixed). Logo, trocar `sticky → relative` não altera o layout de nenhum
outro elemento — só faz o elemento "desgrudar" e voltar à posição natural.

Em `walkElement` (packages/extension/src/capture.ts):

1. Se `getComputedStyle(el).position === "sticky"`, aplicar
   `forceStyle(el, "position", "relative", undo)` (helper já existente)
   **antes** de medir o rect.
2. Executar o walk normal da subárvore — filhos, pseudo-elementos e
   screenshots saem certos de graça, sem matemática de coordenadas.
3. Restaurar o estilo original em `try/finally`.

Interações:

- **`scrollIntoViewIfNeeded`**: continua funcionando — relative rola
  normalmente com a página.
- **Sticky dentro de subárvore fixed** (`fixedScrollSuppressed > 0`):
  o swap vira no-op inofensivo (relative dentro de fixed não desloca nada).
- **Sticky não-grudado no momento da medição**: o swap também é no-op
  posicional — pode ser aplicado incondicionalmente a todo
  `position: sticky`, sem detectar o estado "grudado".
- **Freeze de animations**: já ativo durante a captura, mitiga JS/CSS que
  reagiria à mudança de estilo inline (risco residual raro).

## Teste

Em `test/fixture.html`: adicionar um sticky mid-page — ex.: `nav` com
`position: sticky; top: 0` dentro de uma section alta, precedido de
conteúdo alto o bastante para forçar o walker a rolar (deixando o sticky
grudado no momento da medição). No `test/assert.mjs`, assert de que o `y`
capturado é a posição natural de fluxo, não a grudada.

## Docs

- `docs/ARCHITECTURE.md`: remover o item de "Próximos passos", registrar a
  decisão (posição natural via relative-swap) na seção da captura.
- `README.md`: idem em "Próximos passos".
