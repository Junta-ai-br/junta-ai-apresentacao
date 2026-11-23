# Exportação fiel da apresentação

Implementação isolada na branch `fix/pdf-export-fidelity`, a partir de `origin/main`
`adae415`, após `git fetch origin`. A worktree fica em `.worktrees/pdf-export`.
O `index.html` permanece idêntico ao original. A publicação da branch e a PR
destinam-se à revisão; merge e deploy não fazem parte desta alteração.

## Diagnóstico

- A execução real de `?print-pdf` com Reveal.js 5.1.0 produziu **13 páginas**:
  os slides 2 e 3 têm três fragments cada. O padrão `pdfSeparateFragments: true`
  acrescenta três etapas de impressão a cada um desses slides.
- O HTML não define `@page`, `@media print` ou tratamento de cor para impressão.
  O fundo do navegador depende da opção de imprimir gráficos de fundo. O PDF
  de diagnóstico usa `printBackground: true`; por isso a falha de fundo branco
  relatada depende das opções do navegador e não foi atribuída a uma regra branca
  específica no modo `print-pdf`.
- O canvas `#bg` é fixo, ocupa a viewport e está **fora** de `.reveal .slides`.
  O Reveal reorganiza os slides em `.pdf-page`, mas não cria um canvas com o
  estado Three.js correspondente para cada página. O fundo depende do slide atual,
  do tempo e do ponteiro, e não representa sete fundos estáticos na impressão.
- A impressão usa um layout diferente do layout interativo: a escala da tela,
  a margem Reveal de 0.06 e o posicionamento centralizado não são uma garantia
  de composição idêntica no papel. SVGs, gradientes de texto, backdrop-filter e
  animações também dependem do estado de renderização; fontes externas precisam
  terminar de carregar antes de medir o layout.

A [documentação oficial](https://revealjs.com/pdf-export/) descreve tanto as
páginas adicionais de fragments quanto `pdfSeparateFragments: false` e
`pdfMaxPagesPerSlide: 1`. Esses ajustes resolvem a paginação, mas não reproduzem
o canvas global com o estado individual dos sete slides. Por isso a solução
principal é a captura da apresentação original em Chromium, sem redesenho.

## Estratégia

`scripts/export-pdf.mjs` serve o HTML original em endereço local temporário.
Somente o navegador de exportação recebe interceptação das URLs externas, usando
Reveal.js **5.1.0**, Three.js **0.160.0** e Noto Sans em dependências de desenvolvimento.
Isso evita depender do CDN e do Google Fonts durante a captura. O lockfile fixa
as versões instaladas. Nenhuma dependência é carregada pelo site em produção.

Cada slide é carregado em documento próprio, em 1280 × 720 com densidade 2
(captura PNG de 2560 × 1440). O processo espera Reveal e fontes, revela todos
os fragments, aguarda 1,8 segundo e congela as animações CSS e o renderizador.
O fundo é um frame real do Three.js, incluindo partículas, núcleo, órbita e linha
de tendência, respeitando o estado específico daquele slide. A semente das partículas
é fixa apenas no navegador de exportação. Não se usa um gradiente substituto.

Controles e progresso são removidos apenas da captura final. Os PNGs são embutidos
sem perdas em páginas de 960 × 540 pontos, sem margens. Os links HTML existentes
ganham anotações clicáveis sobre a imagem. Não há cabeçalhos, rodapés ou números
do navegador, pois não se usa a impressão para gerar o PDF final.

## Validação executada

- Sete seções originais; sete páginas finais, todas em 16:9.
- Reprodução das 13 páginas nativas, guardada em `artifacts/native-before.pdf`.
- Navegação por ArrowRight e revelação incremental de fragments verificadas.
- Zero erros JavaScript; zero fragments ocultos na captura final.
- Limites de títulos, parágrafos, cards, fórmulas, arquitetura, QR Code e botões
  conferidos contra a viewport. Nenhum transbordamento relevante detectado.
- Ausência de páginas vazias conferida por variação dos pixels.
- PDF reaberto por PDF.js, renderizado página por página a 2560 × 1440 e
  comparado às capturas. **Erro médio absoluto de pixels: 0 nas sete páginas**
  na execução validada (tolerância automatizada menor que 1 em escala 0–255).
- Revisão visual dos sete slides, com detalhe da arquitetura e do encerramento:
  cards completos, textos sem cortes, diagrama integral, QR Code e endereços visíveis.
- `git diff --exit-code origin/main -- index.html` confirma que o site não mudou.

Evidências geradas em `artifacts/`:

| Arquivo | Evidência |
| --- | --- |
| `reference-1.png` a `reference-7.png` | Apresentação original com fragments revelados, no mesmo frame da captura final |
| `slide-1.png` a `slide-7.png` | Capturas finais sem controles |
| `pdf-page-1.png` a `pdf-page-7.png` | Páginas renderizadas do PDF final |
| `contact-sheet.png` | Visão geral dos sete slides |
| `validation.json` | Paginação, limites, links e comparação de pixels |
| `Junta-ai_Apresentacao_Oficial.pdf` | PDF pronto para envio |

As referências são locais, obtidas do HTML original, com as bibliotecas nas mesmas
versões. Não são capturas da Vercel. A inspeção de sobreposições é visual; os testes
geométricos não substituem essa inspeção.

## Reprodução e limitações

Após `npm.cmd ci` e `npx.cmd playwright install chromium`, basta executar
`npm.cmd run export:pdf`. Use Node.js 22 ou superior. Em PowerShell os sufixos
`.cmd` evitam depender da política de execução de scripts. No Linux/macOS,
use `npm` e `npx`. Para usar um Chromium já instalado, defina `CHROMIUM_PATH`
com o caminho do executável. `PLAYWRIGHT_BROWSERS_PATH` também é respeitada.

O PDF contém imagens de alta resolução: textos não são selecionáveis e SVGs
deixam de ser vetoriais. Os dois links HTML existentes continuam clicáveis.
O QR Code permanece como imagem; sua leitura por dispositivo não foi testada.
O fundo é um frame estático e sua fase pode variar ligeiramente entre máquinas,
pois o relógio e o desempenho WebGL continuam reais. Noto Sans é empacotada
localmente; futuras atualizações do Google Fonts não afetam esta exportação.

Os artefatos e dependências estão ignorados no Git. O modo manual `?print-pdf`
permanece como no original; o comando acima é o mecanismo oficial desta correção.
