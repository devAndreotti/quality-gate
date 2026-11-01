# Visão geral do Quality Gate

Quality Gate é um conjunto de scripts Node.js e workflows do GitHub Actions que bloqueia regressão de qualidade num repositório. Não é um serviço: roda local e no CI, sem conta paga obrigatória.

Este documento lista os módulos que existem hoje. Para o que está ligado por padrão, veja a seção "Política" no fim.

## Como uma mudança passa pelo gate

1. **Local (antes do push):** `scripts/local-validate.cjs --profile pr` roda as mesmas checagens do CI. Hooks opcionais (`scripts/git-hooks.cjs`) fazem o mesmo no pre-commit e no pre-push.
2. **PR aberto:** o workflow `quality-gate.yml` roda os jobs obrigatórios. Os de segurança, lint e testes precisam passar para o merge.
3. **Push na main:** Secret Scan, Quality Gate, CodeQL, Release Provenance (SLSA), Scorecard e dashboard rodam de novo.

## Obrigatórios no merge

Estes checks estão na proteção de branch e bloqueiam o merge: `Tests & ratchet`, `Lint`, `Security audit`, `Docker image gate`, `CodeQL` e `Dependency Review`.

## Módulos por área

**Cobertura e ratchet**
- `quality-gate.js`: ratchet (check, update, init). A cobertura só pode subir em relação a `scripts/baseline.json`.
- `test-coverage-ci.cjs`: converte o LCOV em resumo.
- `diff-coverage-gate.cjs`: exige 90% de cobertura nas linhas que o PR adiciona (bloqueante).
- `new-code-findings.cjs`: lista achados de lint só nas linhas que o PR adiciona (advisory).

**Segurança e dependências**
- `secret-scan.cjs`: procura credenciais na árvore (`--all`), no diff (`--diff`) e em todo o histórico (`--history`, com allowlist exata em `.quality-gate/secret-history-allow.json`).
- `lockfile-new-deps.cjs`: lista dependências novas ou alteradas no lockfile, com idade da versão (advisory).
- `install-scripts-audit.cjs`: avisa sobre pacotes novos com scripts de instalação.
- `license-audit.cjs`: auditoria estática de licenças.
- Workflows: CodeQL, Dependency Review, Semgrep (regras próprias em `.semgrep/`, advisory), Scorecard, Release Provenance (SLSA).

**Qualidade de código**
- `new-code-findings.cjs` e `ast-graph.cjs` (quebras de import entre arquivos).
- `boundary-gate.cjs`: impede imports proibidos entre camadas (desligado por padrão).
- Lint e formatação via scripts npm (`lint`, `format:check`, `typecheck`, `duplication`).

**Testes**
- `flaky-detect.cjs`: roda a suíte N vezes no mesmo checkout e separa testes instáveis, com lista de quarentena em `.quality-gate/flaky-quarantine.json` (advisory; workflow semanal, não roda em PR).
- `stryker.pilot.config.mjs`: piloto de mutation testing em duas bibliotecas (experimento, sem gate).

**Commits e PR**
- `commit-lint.cjs`: valida Conventional Commits.
- `pr-size.cjs`: conta linhas alteradas (desligado por padrão).
- `pr-snapshot.cjs`, `pr-comment.js`: resumo do estado do PR, em comentário sticky.
- `pr-inline-suggest.cjs`: achados como comentários inline (dry-run por padrão).

**Modelo local (opcional)**
- `pr-ai-review.cjs`: revisão de PR com modelo local. Veja `docs/MODELO-LOCAL.md`.
- `ai-evals-gate.cjs`: gate de evals de prompts e agentes (desligado por padrão).
- `lib/local-ai-client.cjs`: cliente comum para Ollama e 9Router.

**Frota e painel**
- `fleet.cjs`: audita vários repos (policy, baseline, hook, CI), somente leitura.
- `dashboard.cjs`: painel no terminal, com o último resultado de cada check do `main`.
- `dashboard-publish.cjs`: gera o HTML do Pages (workflow `quality-extras.yml`).
- `doctor.cjs`, `setup.js`, `bootstrap-repo.cjs`: auditoria e configuração do próprio pacote e da proteção de branch.

**Hooks e diagnóstico**
- `git-hooks.cjs`: instala pre-commit e pre-push gerenciados. O `install` sem argumento instala só o pre-push; use `--hook pre-commit` para o outro.
- `ci-diagnose.cjs`, `babysit-loop.cjs`: diagnóstico de falha de CI e acompanhamento de PR.
- `secret-scan.cjs` também roda como hook.

## Não existe (e não é promessa)

- Não há CLI única instalável: o `package.json` não tem `bin`. O uso é `node scripts/<nome>.cjs`.
- Não há classificação automática de falha de CI com IA.
- Não há histórico de métricas entre execuções; o dashboard mostra o estado atual.
- Não há mutation testing nem DAST como gate.

## Política

Valores em `.quality-gate/policy.json`:

- Cobertura ratchet: ligada.
- Diff coverage: ligado, bloqueante, mínimo 90%.
- Evals de IA: desligados.
- Limite de tamanho de PR: desligado.
- Boundary gate: desligado.
- SonarCloud: advisory (opcional).
