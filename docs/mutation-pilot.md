# Piloto de mutation testing (Stryker)

Experimento local e descartável. Não é gate, não tem job de CI, não é required check e não quebra build (`thresholds.break: null`).

Como rodar: `npm run mutation:pilot` (config em `stryker.pilot.config.mjs`; relatórios em `reports/mutation/`, ignorados pelo git).

## Versões

- `@stryker-mutator/core` `10.1.1` (exata, `--save-exact`), a versão mais recente estável no npm na data do piloto. Exige Node `>=22`; local: Node `v26.12.1`.
- `@stryker-mutator/command-runner` **não existe no npm** (retorna 404). Não foi adicionado. O `@stryker-mutator/core` já traz o test runner `command` embutido, que é o que o piloto usa.

## Escopo

- `scripts/lib/diff-coverage.cjs` (testes: `scripts/lib-diff-coverage.test.cjs`)
- `scripts/lib/console-ui.cjs` (testes: `scripts/lib-utilities.test.cjs`; é o mesmo arquivo que também cobre github e policy, sem filtro)

Ambas são bibliotecas puras, sem I/O. O comando de teste roda os dois arquivos de teste inteiros.

## Resultado medido

Execuções locais, `coverageAnalysis: off`. O conjunto de mutantes é o mesmo nas duas rodadas (361), porque o código de produção não mudou; só os testes.

### Antes (linha de base, commit `6376f60`)

| Arquivo | Mutantes | Mortos | Sobreviventes | Score |
|---|---|---|---|---|
| `scripts/lib/console-ui.cjs` | 102 | 61 | 41 | 59.80% |
| `scripts/lib/diff-coverage.cjs` | 259 | 90 | 169 | 34.75% |
| **Total** | **361** | **151** | **210** | **41.83%** |

- Tempo do Stryker (linha `Done in`): 48 s nesta rodada. O doc anterior registrava 40 s.
- Suíte completa (`node --test scripts/*.test.cjs`) antes: 458 testes (número do doc anterior, não medido de novo nesta rodada).

### Depois (este commit)

| Arquivo | Mutantes | Mortos | Sobreviventes | Score |
|---|---|---|---|---|
| `scripts/lib/console-ui.cjs` | 102 | 100 | 2 | 98.04% |
| `scripts/lib/diff-coverage.cjs` | 259 | 250 | 9 | 96.53% |
| **Total** | **361** | **350** | **11** | **96.95%** |

- Tempo do Stryker: 43 s na rodada final. As rodadas intermediárias ficaram entre 32 s e 53 s, então a variação de máquina é maior que qualquer diferença. Não há ganho de tempo mensurável.
- Suíte completa: 490 testes, todos passando. Gate de diff coverage (`--base origin/main`): 100% (21/21 linhas).

## Testes adicionados

Em `scripts/lib-diff-coverage.test.cjs`:

- `evaluateDiffCoverage` (era o trecho com os sobreviventes de `:186` e `:200`; o arquivo só testava `calculateDiffCoverage` e `parseDiffLineNumbers`):
  - linha com 0 hits não conta como coberta, e 1 hit conta;
  - todas as linhas com 0 hits dão 0%;
  - `passed` é verdadeiro exatamente no limiar (75 com 75%), falso em 75,01 e verdadeiro em 74,99;
  - limiar padrão de 90%;
  - nenhuma linha executável alterada dá 100% e passa;
  - arquivo sem registro no LCOV conta linhas não em branco como `no-coverage-record`, e ignora linhas só com espaços;
  - `include` com um e com vários prefixos;
  - casamento de caminho com limite de diretório nos dois sentidos (`scripts/ax.cjs` não casa com `x.cjs`; `x.cjs` casa com `scripts/x.cjs`).
- `calculateDiffCoverage`: limiar exato, casamento por sufixo nos dois sentidos, linha alterada sem entrada no LCOV não entra no cálculo, arquivo fora do LCOV é ignorado.
- `parseDiffLineNumbers` e `parseAddedLines`: hunks com vários dígitos e sem contagem, âncora `^` do hunk, cabeçalho `+++` repetido para o mesmo arquivo, `+++ /dev/null` no meio de um hunk, `+` antes de qualquer cabeçalho, barra invertida no caminho, linha removida antes de linha adicionada.
- `parseLcovCoverageMap`: espaço final no `SF:`, seções repetidas do mesmo arquivo mescladas.
- `isGatedSource`: extensões aceitas e recusadas, incluindo sufixos compostos (`.js.map`, `.cjsx`, `.ts.orig`).

Em `scripts/lib-utilities.test.cjs`:

- `displayWidth`: caracteres logo antes e logo depois de cada faixa de emoji (`0x1f300..0x1faff`, `0x2600..0x27bf`, `0x2b00..0x2bff`). Os limites `0x1f2ff`, `0x1fb00`, `0x25ff`, `0x27c0`, `0x2aff`, `0x2c00` têm largura 1; os limites inclusivos têm largura 2.
- U+FE0F tem largura zero.
- `renderTable`, `renderHeaderBox` e `renderSection` com saída exata (bordas, separadores, preenchimento, título maior que a caixa). Largura de emoji em célula de tabela.
- `stryker.pilot.config.mjs`: o teste importa a config e confere `mutate`, `thresholds.break: null`, `testRunner` e `coverageAnalysis`. Motivo: o arquivo é novo nesta PR e nenhum teste o carregava, então o gate de diff coverage falhava com 0% (0/21 linhas). Não foi feita exclusão no gate nem no stryker config.

## Sobreviventes restantes (11)

Todos os 11 são mutantes equivalentes ou quase equivalentes para as entradas que o código recebe. Não há teste que os mate sem fixar comportamento sem sentido:

- `console-ui.cjs:25` (`visible >= width` virou `>`): com `visible === width`, `' '.repeat(0)` devolve a mesma string. Equivalente.
- `console-ui.cjs:48` (`' '.repeat(tailPad)` virou `""`): `tailPad` é sempre 0 em `renderHeaderBox`, porque o preenchimento de `pad` já leva a linha até `width` ou, com título longo, a `pad = 1`. Equivalente.
- `diff-coverage.cjs:10`, `:39`, `:119` (`String(x || '')` virou literal de texto): o texto sentinela não casa com nenhum prefixo de cabeçalho, hunk ou LCOV, e não há arquivo ativo para atribuir linhas. Equivalente.
- `diff-coverage.cjs:11` e `:120` (`$` removido de `/^\+\+\+ b\/(.+)$/`): só difere para uma linha com `\r` no meio, que o `split(/\r?\n/)` não remove. Não ocorre em diffs reais.
- `diff-coverage.cjs:66` (`lcovFile === diffFile` virou `false`): o mesmo caso já é coberto por `lcovFile.endsWith(diffFile)`. Equivalente.
- `diff-coverage.cjs:106` (`$` removido de `\.(?:test|spec)\.[a-zA-Z0-9]+$`): só difere para nomes como `x.test.foo.js`. Nenhum arquivo do repo tem esse padrão; é decisão de política, não coberta de propósito.

## Limitações

- O runner oficial do Stryker não tem integração com `node:test`. O piloto usa o runner `command`, que roda `node --test ...` uma vez por mutante e considera morto quando o exit code é diferente de 0.
- Sem seleção por teste: cada mutante carrega os dois arquivos de teste inteiros (`Ran 1.00 tests per mutant`). Por isso `coverageAnalysis` fica `off`. Escalar para mais libs multiplica esse custo.
- `lib-utilities.test.cjs` mistura console-ui, github e policy. Sem filtro por nome, o sinal fica diluído e o tempo sobe.
- O lockfile ganhou 183 entradas novas (das dependências do Stryker) e nenhuma entrada existente foi removida ou alterada.

## Recomendação revisada

Continuar não adotando como gate. O que mudou:

- Nas duas libs, a lacuna de teste que o piloto apontou foi fechada. O score subiu de 41,83% para 96,95%, e os 11 sobreviventes restantes são equivalentes ou quase equivalentes. A ferramenta já deu o sinal que tinha para dar nessas libs.
- O custo não mudou. Cada mutante ainda roda os dois arquivos de teste inteiros, e o tempo ficou na mesma faixa (43 s contra 48 s, com rodadas entre 32 s e 53 s).
- O gate de diff coverage tratou `stryker.pilot.config.mjs` como código de produção. Enquanto a config não tiver teste, qualquer PR que a crie ou altere vai falhar o gate. Vale decidir se configs de ferramenta devem ficar fora do gate, em vez de cada uma ganhar um teste.

Próximos passos, nesta ordem:

1. Filtrar os testes por lib (arquivo dedicado ou `--test-name-pattern`) para o comando de cada mutante ficar menor.
2. Só depois avaliar uma terceira lib, com números novos.
3. Decidir a política de configs `.mjs` no gate de diff coverage antes de qualquer adoção.
