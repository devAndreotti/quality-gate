# Plano - automacao dos gaps do Quality Gate

Data: 2026-05-26

## Objetivo

Transformar os gaps observados no uso real do Quality Gate em automacoes verificaveis dentro de `D:\Dev\Tooling\quality-gate`, reduzindo trabalho manual de agente e evitando falsos "PR pronto".

Este plano nasce de falhas reais vistas no fluxo com `tcc-free-plaud`:

- PR parecia pronto localmente, mas GitHub bloqueava merge por politica de base branch.
- `babysit-loop.cjs` podia concluir `ready` mesmo com estado de merge inadequado ou checagens consultadas de forma incompleta.
- Review threads resolvidas via GraphQL nao eram parte forte do snapshot.
- Validacao local dependia de comandos manuais espalhados.
- UI/Node podia ficar fora do Quality Gate mesmo quando o projeto tinha frontend real.
- `qg-chk` podia consumir cobertura stale se o pytest falhasse antes.
- No Windows, `pytest --basetemp .pytest-tmp-qg` podia gerar `PermissionError` por reuso/lock de diretorio.

## Revisao senior-second-pass

### Veredito

O plano anterior estava correto na direcao, mas fraco em contrato de prontidao. O erro principal era tratar "checks verdes" como sinonimo de "mergeavel". Isso nao basta.

Um Quality Gate util para agente precisa separar quatro verdades:

1. checks obrigatorios;
2. checks opcionais/advisory;
3. estado de merge e branch protection;
4. review threads/conversas bloqueantes.

Sem essa separacao, o script reduz trabalho em casos simples, mas ainda deixa o agente fazer investigacao manual nos casos caros.

### Findings

- **P1 - Prontidao de PR esta subespecificada.** `ready` so pode existir quando checks obrigatorios passaram, merge state e politica permitem merge, nao ha review thread bloqueante, e a branch nao esta draft.
- **P1 - Snapshot nao enxerga review threads como fonte canonica.** Inline comments e reviews nao substituem `reviewThreads` via GraphQL, porque uma thread pode seguir unresolved mesmo quando o comentario parece antigo ou outdated.
- **P1 - Validacao local nao e um comando unico.** O agente precisa lembrar `ruff`, `pytest`, `pip-audit`, `qg-chk`, `qg-doc`, `git diff --check` e ainda comandos UI. Isso deve virar script.
- **P1 - Cobertura stale pode gerar falso verde/vermelho.** `qg-chk` deve rodar somente depois de teste com sucesso e artefato de cobertura fresco.
- **P2 - UI e stack misto nao estao no contrato.** Projeto com `pipeline/` Python e frontend Node precisa de superficies declaradas ou detectadas.
- **P2 - Falha opcional nao deve bloquear igual falha obrigatoria.** Sonar ou qualquer check advisory deve aparecer como risco, nao como blocker automatico, salvo politica explicita.
- **P2 - Windows precisa caminho temporario unico.** Basetemp fixo e fragil por locks de arquivo.
- **P3 - Ruido de untracked conhecido atrapalha.** `samples/` e artefatos gerados precisam allowlist, sem mascarar mudancas reais.

### Gaps restantes

- Definir schema claro para `required`, `advisory`, `unknown` e `blocked`.
- Adicionar fixtures de GitHub com `mergeStateStatus=BLOCKED`, `UNSTABLE`, `CLEAN`, checks opcionais falhando e review threads unresolved.
- Padronizar onde os relatorios locais ficam: `.quality-gate/reports/`.
- Atualizar docs e skill `babysit-pr` para usar a nova verdade do script, nao heuristica manual.

## Contrato novo de prontidao

### Estados de PR

O snapshot deve emitir:

```json
{
  "merge": {
    "state": "CLEAN",
    "ready": true,
    "blockers": [],
    "advisories": []
  },
  "checks": {
    "required": [],
    "advisory": [],
    "unknown": []
  },
  "reviewThreads": {
    "status": "known",
    "unresolved": []
  },
  "actions": ["ready"]
}
```

### Regras

- `ready`: checks obrigatorios verdes, merge permitido, review threads conhecidas e resolvidas.
- `ready_with_advisory`: merge permitido, obrigatorios verdes, mas ha check opcional falhando.
- `wait_ci`: checks obrigatorios pendentes.
- `fix_required_check`: check obrigatorio falhou.
- `diagnose_optional_check`: check opcional falhou.
- `resolve_review_threads`: ha thread unresolved.
- `verify_review_threads_manual`: GraphQL falhou ou nao ha permissao para confirmar threads.
- `blocked_by_policy`: GitHub indica bloqueio de politica mesmo sem falha clara de check.
- `sync_branch`: branch esta atrasada ou merge queue exige atualizacao.
- `escalate_manual`: estado ambiguo ou permissao insuficiente.

## Slice 1 - Snapshot de PR com verdade de merge

### Meta

Fazer `scripts/pr-snapshot.cjs` parar de depender apenas de `gh pr checks` e campos superficiais.

### Mudancas

- Buscar `mergeStateStatus`, `mergeable`, `isDraft`, head/base e URL via `gh pr view`.
- Buscar branch protection quando permitido:
  - required status checks;
  - required review/conversation resolution quando disponivel;
  - fallback explicito quando API nao permitir.
- Buscar review threads via GraphQL:
  - `isResolved`;
  - `isOutdated`;
  - autor;
  - path/line quando existir;
  - ultimo comentario.
- Separar checks em:
  - `required`;
  - `advisory`;
  - `unknown`.
- Emitir `merge.blockers[]` e `merge.advisories[]`.

### Testes RED esperados

- `mergeStateStatus=BLOCKED` sem check falhando nao pode emitir `ready`.
- Sonar opcional falhando com required green deve emitir `ready_with_advisory`, nao `fix_required_check`.
- Thread unresolved deve emitir `resolve_review_threads`.
- GraphQL indisponivel deve emitir `verify_review_threads_manual`, nao `ready`.

### Validacao

```powershell
cd D:\Dev\Tooling\quality-gate
node --test scripts\pr-snapshot.test.cjs
node --check scripts\pr-snapshot.cjs
```

## Slice 2 - Babysit loop sem falso ready

### Meta

Fazer `scripts/babysit-loop.cjs` confiar no contrato novo de `pr-snapshot`, nao em lista generica de actions.

### Mudancas

- `decideLoopState(snapshot)` deve considerar `snapshot.merge.ready`.
- Terminal `ready` so quando `merge.ready === true`.
- Terminal `ready_with_advisory` permitido quando a politica aceitar advisory falho.
- Qualquer blocker vira estado nao terminal com motivo especifico.
- Mensagem final deve listar:
  - blocker principal;
  - comando sugerido;
  - se e problema local, CI, review ou politica GitHub.

### Testes RED esperados

- Snapshot com `actions=["ready"]`, mas `merge.ready=false`, nao pode retornar terminal ready.
- Snapshot com thread unresolved retorna `pending` ou `blocked`, motivo `unresolved_review_threads`.
- Snapshot com required pending retorna `pending`, motivo `required_checks_pending`.
- Snapshot com optional failed retorna advisory, nao blocker, quando politica permite.

### Validacao

```powershell
cd D:\Dev\Tooling\quality-gate
node --test scripts\babysit-loop.test.cjs
node --check scripts\babysit-loop.cjs
```

## Slice 3 - Diagnostico de CI com artefatos

### Meta

Reduzir ida manual ao GitHub Actions quando algo falha.

### Mudancas

- `scripts/ci-diagnose.cjs` deve baixar ou apontar artefatos relevantes quando disponiveis.
- Salvar relatorios em:

```text
.quality-gate/reports/ci/<run-id>/
```

- Classificar falhas em:
  - `lint`;
  - `tests`;
  - `coverage_ratchet`;
  - `security`;
  - `sonar`;
  - `docker`;
  - `infra`;
  - `unknown`.
- Para coverage ratchet, apontar arquivo de cobertura usado e se ele e fresco.
- Para Sonar, distinguir:
  - required blocker;
  - advisory;
  - token ausente;
  - quality gate real falhando.

### Testes RED esperados

- Log com falha Sonar opcional nao vira blocker obrigatorio.
- Falha por coverage stale recebe classificacao propria.
- Falha de infra nao recomenda patch no codigo.

### Validacao

```powershell
cd D:\Dev\Tooling\quality-gate
node --test scripts\ci-diagnose.test.cjs
node --check scripts\ci-diagnose.cjs
```

## Slice 4 - Validador local unico

### Meta

Criar um comando local que rode o que hoje o agente faz manualmente.

### Novo script

```text
scripts/local-validate.cjs
```

### Comandos desejados

```powershell
cd D:\Dev\Tooling\quality-gate
node scripts\local-validate.cjs --project D:\Dev\Repos\Own\tcc-free-plaud --profile pr --json
node scripts\local-validate.cjs --project D:\Dev\Repos\Own\tcc-free-plaud --profile pr --dry-run --json
```

### Perfil Python uv

Para projetos com `pipeline/pyproject.toml`:

```powershell
cd <project>\pipeline
uvx ruff check src tests --output-format=json > ..\coverage\ruff.json
uv run pytest --basetemp .pytest-tmp-qg-<timestamp>-<pid> -q --cov=src --cov-report=json:../coverage/coverage.json --cov-report=xml:../coverage/coverage.xml --cov-report=term-missing
uvx pip-audit --path .venv
cd <project>
qg-chk
qg-doc
git diff --check
git status --short --branch
```

### Regra de cobertura

- `qg-chk` so roda se `pytest` retornar `0`.
- `coverage.json` precisa ter timestamp posterior ao inicio do `pytest`.
- Se cobertura estiver stale, falhar com mensagem clara.

### Perfil Node UI

Para superficies com `package.json`:

```powershell
npm ci
npm run test --if-present
npm run lint --if-present
npm run build --if-present
npm audit --audit-level=moderate
```

### Saida JSON

```json
{
  "profile": "pr",
  "project": "D:\\Dev\\Repos\\Own\\tcc-free-plaud",
  "startedAt": "2026-05-26T00:00:00.000Z",
  "finishedAt": "2026-05-26T00:03:40.000Z",
  "status": "failure",
  "commands": [
    {
      "name": "pytest",
      "cwd": "D:\\Dev\\Repos\\Own\\tcc-free-plaud\\pipeline",
      "exitCode": 1,
      "durationMs": 41200,
      "artifact": ".quality-gate/reports/local/pytest.log"
    }
  ]
}
```

### Testes RED esperados

- Se pytest falha, `qg-chk` nao roda.
- Basetemp gerado deve ser unico por execucao.
- Projeto com UI detectado deve incluir comandos Node.
- `--dry-run` nao executa comandos, mas mostra plano.

### Validacao

```powershell
cd D:\Dev\Tooling\quality-gate
node --test scripts\local-validate.test.cjs
node scripts\local-validate.cjs --project D:\Dev\Repos\Own\tcc-free-plaud --profile pr --dry-run --json
node --check scripts\local-validate.cjs
```

## Slice 5 - Policy schema para projetos mistos

### Meta

Permitir que o Quality Gate saiba quais superficies existem no projeto.

### Schema proposto

```json
{
  "project": {
    "surfaces": [
      {
        "type": "python-uv",
        "root": "pipeline",
        "required": true,
        "coverageJson": "../coverage/coverage.json"
      },
      {
        "type": "node",
        "root": "front",
        "required": true,
        "commands": {
          "install": "npm ci",
          "test": "npm run test --if-present",
          "lint": "npm run lint --if-present",
          "build": "npm run build --if-present",
          "audit": "npm audit --audit-level=moderate"
        }
      }
    ]
  },
  "ci": {
    "advisoryChecks": ["SonarCloud Code Analysis"],
    "requiredChecks": ["quality-gate", "python-validation", "ui-validation"]
  },
  "localValidation": {
    "untrackedAllowlist": ["samples/**"],
    "pytestBasetempPattern": ".pytest-tmp-qg-${timestamp}-${pid}"
  }
}
```

### Mudancas

- `doctor.cjs` valida schema.
- `bootstrap-repo.cjs` gera config inicial detectando `pipeline/` e `package.json`.
- `quality-gate.cjs` respeita allowlist de untracked.
- `README.md` documenta exemplos Python-only, Node-only e mixed.

### Testes RED esperados

- Projeto com `front/package.json` e sem surface Node gera warning.
- `samples/**` allowlist remove ruido, mas nao mascara arquivo modificado rastreado.
- Check advisory falhando nao bloqueia se nao estiver em `requiredChecks`.

### Validacao

```powershell
cd D:\Dev\Tooling\quality-gate
node --test scripts\doctor.test.cjs
node --test scripts\bootstrap-repo.test.cjs
node --test scripts\quality-gate.test.cjs
```

## Slice 6 - Workflow template com UI validation

### Meta

Gerar GitHub Actions que acompanhe o schema de superficies.

### Mudancas

- Para `python-uv`, manter job Python atual.
- Para `node`, gerar job `ui-validation`.
- Para projeto mixed, workflow deve ter jobs separados:
  - `python-validation`;
  - `ui-validation`;
  - `security`;
  - `quality-gate-summary`.
- Comentario de PR deve mostrar cada superficie.

### Testes RED esperados

- Bootstrap em projeto mixed gera job UI.
- Projeto Python-only nao ganha job UI.
- Se UI e required no schema, ausencia do job falha doctor.

### Validacao

```powershell
cd D:\Dev\Tooling\quality-gate
node --test scripts\setup.test.cjs
node --test scripts\bootstrap-repo.test.cjs
node scripts\doctor.cjs --dry-run
```

## Slice 7 - Dependabot consolidation helper

### Meta

Reduzir trabalho manual quando Dependabot abre varios PRs no mesmo workflow/dependencia de CI.

### Novo script

```text
scripts/dependabot-consolidate.cjs
```

### V1 sem mutacao

O primeiro corte deve apenas diagnosticar e sugerir plano:

```powershell
node scripts\dependabot-consolidate.cjs --repo devAndreotti/tcc-free-plaud --dry-run --json
```

### Saida esperada

- PRs Dependabot abertos;
- arquivos tocados;
- conflitos provaveis;
- sugestao de consolidar;
- ordem de merge segura quando nao precisa consolidar.

### Testes RED esperados

- Dois PRs alterando `.github/workflows/quality-gate.yml` geram recomendacao de consolidacao.
- PR unico nao gera acao.
- PRs em arquivos independentes geram ordem sugerida, nao merge artificial.

## Slice 8 - Docs e skill babysit-pr

### Meta

Atualizar documentacao para o agente usar a automacao, nao repetir investigacao manual.

### Mudancas

- `README.md`:
  - novo `local-validate`;
  - novo contrato `ready`;
  - exemplos mixed project.
- `IMPLEMENTATION.md`:
  - arquitetura do snapshot;
  - limites entre script deterministico e skill.
- `babysit-pr/SKILL.md`:
  - usar `pr-snapshot` e `babysit-loop` como fonte de verdade;
  - parar quando `verify_review_threads_manual`;
  - nao dizer pronto quando `merge.ready=false`.

### Validacao

```powershell
cd D:\Dev\Tooling\quality-gate
node --test scripts\e2e-smoke.test.cjs
node scripts\doctor.cjs --dry-run
```

## Metricas esperadas

### Antes

Em PRs como os de `tcc-free-plaud`, o agente precisava rodar manualmente:

- `gh pr checks`;
- `gh pr view`;
- GraphQL para review threads;
- `gh run view`;
- inspecao de branch protection;
- validacao local Python;
- validacao local UI;
- checagem de cobertura stale;
- diagnostico manual de Sonar/advisory.

Estimativa realista: 6 a 10 comandos por ciclo problemático de PR.

### Depois

Fluxo esperado:

```powershell
node scripts\local-validate.cjs --project <repo> --profile pr --json
node scripts\babysit-loop.cjs --pr <numero> --once --json
```

Meta: reduzir o loop comum para 1 ou 2 comandos, com JSON acionavel.

### Indicadores de sucesso

- `babysit-loop` nunca retorna `ready` com `mergeStateStatus=BLOCKED`.
- Review thread unresolved sempre aparece em `merge.blockers`.
- Check opcional falho aparece em `merge.advisories`, nao como blocker, salvo politica.
- `qg-chk` nao roda depois de pytest falho.
- Basetemp de pytest e unico por execucao.
- Projeto mixed detecta UI e gera job/validacao correspondente.
- Relatorio local salvo em `.quality-gate/reports/local-validation.json`.

## Ordem recomendada

1. Slice 1 - Snapshot de PR com verdade de merge.
2. Slice 2 - Babysit loop sem falso ready.
3. Slice 3 - Diagnostico de CI com artefatos.
4. Slice 4 - Validador local unico.
5. Slice 5 - Policy schema para projetos mistos.
6. Slice 6 - Workflow template com UI validation.
7. Slice 7 - Dependabot consolidation helper.
8. Slice 8 - Docs e skill babysit-pr.

## Regras de parada

Parar e escalar se:

- GitHub GraphQL nao retornar review threads e nao houver fallback confiavel.
- Branch protection nao puder ser lida e o estado de merge vier ambiguo.
- O schema exigir decisao de produto sobre check advisory virar required.
- Um projeto tiver mais de uma UI e nao houver surface declarada.
- O script precisar de token novo ou permissao fora de `repo`, `workflow`, `read:org`.

## Nao fazer

- Nao transformar `babysit-loop` em ferramenta que edita codigo.
- Nao tornar Sonar obrigatorio por padrao.
- Nao rodar `qg-chk` com coverage antigo.
- Nao exigir UI em projeto que nao tem frontend.
- Nao esconder untracked real com allowlist ampla demais.
- Nao misturar consolidacao Dependabot mutavel na V1.

