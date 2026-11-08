# Resultado: conjunto de defeitos semeados v1

- Pré-registro: docs/avaliacao/seeded-prereg.md (hash confere com o manifesto revelado em seeded-manifest-revelado.json)
- Data da medição: 2026-11-08
- Casos: 5 defeitos, 3 controles. Arquivos em quality-gate-lab, branches seed/seed01 a seed/seed08.

## Ferramentas medidas

Só duas, com o que está disponível localmente e sem conta:

1. **Semgrep 1.182.1** com as regras do próprio repo (`.semgrep/quality-gate.yml` de main), `--metrics=off`.
2. **secret-scan.cjs** do próprio repo, modo `--all`.

**Não medidos:** CodeQL, SonarCloud, Codacy, Socket. CodeQL não roda nos PRs de laboratório, e os outros exigem conta ou token que não foram autorizados.

## Resultado

| Caso | CWE | Semgrep (regras do repo) | secret-scan | Observação |
|---|---|---|---|---|
| seed01 | CWE-78 | não detectou | não aplicável | regra `qg-js-child-process-dynamic-command` só casa `cp.execSync` ou `execSync` nu; o caso usa `execSync` importado por desestruturação, e a regra não casa |
| seed02 | CWE-95 | **detectou** (linha 3) | — | correto |
| seed03 | CWE-22 | não detectou | — | a regra de taint `qg-js-argv-fs-path` tem `paths.include: scripts/`, e o caso está em `eval-seeded/`. Limitação de escopo, não de análise. |
| seed04 | CWE-798 | — | não detectou | valor contém "EXEMPLO_INVALIDO", que o detector trata como placeholder. **Falha do conjunto**: o caso deveria parecer uma credencial real. |
| seed05 | CWE-338 | não detectou | — | não há regra de Math.random no conjunto |
| seed06 a 08 (controles) | — | 0 achados | 0 achados | sem falso positivo |

## Métricas (n pequeno, medem ordem de grandeza)

- **Revocação combinada:** 1 de 5 (20%).
- **Precisão:** 1 de 1 achado emitido (100%), mas com um só achado não há significado estatístico.
- **Falsos positivos nos controles:** 0 de 3.

## O que isso diz sobre o próprio gate

- O Semgrep do repo é **pior do que a nota de SAST sugeria**: detecta só o caso mais direto. A regra de execução de comando não cobre a forma importada, que é comum.
- A regra de caminho de argv tem escopo tão restrito que não vê arquivos fora de `scripts/`.
- O `secret-scan` considera placeholder qualquer valor com palavras como "EXEMPLO". Isso é útil para evitar falso positivo em documentação, mas torna o detector cego a um caso de teste mal construído.

## Limitações

- Conjunto de 5 defeitos, todos simples, de padrão conhecido. Não mede bug de lógica.
- Só duas ferramentas, e as duas são do próprio repo, então não há comparação com concorrentes ainda.
- O caso 04 foi mal desenhado, e isso foi descoberto depois do pré-registro. A correção é versão 2 do conjunto, não alterar o v1.
