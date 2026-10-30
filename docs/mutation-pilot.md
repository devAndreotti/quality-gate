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

Execução única, local, `coverageAnalysis: off`.

| Arquivo | Mutantes | Mortos | Sobreviventes | Score |
|---|---|---|---|---|
| `scripts/lib/console-ui.cjs` | 102 | 61 | 41 | 59.80% |
| `scripts/lib/diff-coverage.cjs` | 259 | 90 | 169 | 34.75% |
| **Total** | **361** | **151** | **210** | **41.83%** |

- Tempo: 40 s de execução do Stryker (41,7 s de wall time, incluindo o startup).
- Suíte completa (`node --test scripts/*.test.cjs`): 458 testes, 458 passando.

### Sobreviventes que valem a pena

- `diff-coverage.cjs:186`: `fileCoverage.get(lineNum) > 0` virou `>= 0` e sobreviveu. Nenhum teste distingue uma linha com 0 hits de uma linha coberta, que é a fronteira central da métrica.
- `diff-coverage.cjs:200`: `pct >= minDiffCoverage` virou `>` e sobreviveu. Não há teste exatamente no limiar. Mutantes em `passed` também sobreviveram.
- `console-ui.cjs:10-12`: fronteiras das faixas de emoji em `displayWidth` (`0x1f300`, `0x1faff`, `0x2600`, `0x27bf`, `0x2b00`, `0x2bff`) sobreviveram. Faltam casos nos limites dos intervalos.
- Os sobreviventes em `renderHeaderBox`/`renderSection` são literais de decoração. Baixo valor.

## Limitações

- O runner oficial do Stryker não tem integração com `node:test`. O piloto usa o runner `command`, que roda `node --test ...` uma vez por mutante e considera morto quando o exit code é diferente de 0.
- Sem seleção por teste: cada mutante carrega os dois arquivos de teste inteiros (`Ran 1.00 tests per mutant`). Por isso `coverageAnalysis` fica `off`. Escalar para mais libs multiplica esse custo.
- `lib-utilities.test.cjs` mistura console-ui, github e policy. Sem filtro por nome, o sinal fica diluído e o tempo sobe.
- O lockfile ganhou 183 entradas novas (das dependências do Stryker) e nenhuma entrada existente foi removida ou alterada.

## Recomendação: ajustar

Não adotar como gate. A ferramenta roda em cerca de 40 s para duas libs puras e produz sinal útil nas fronteiras. Mas o score atual (41,83%) é baixo, e o próprio custo do runner `command` cresce a cada lib. Antes de qualquer decisão de adoção:

1. Criar arquivos de teste focados por lib, ou filtrar com `--test-name-pattern`, para o comando de cada mutante ficar pequeno.
2. Escrever testes para as fronteiras listadas acima e rerodar o piloto para medir o ganho real.
3. Só então avaliar uma terceira lib e reconsiderar, com números novos, a adoção.
