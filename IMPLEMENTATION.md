# Quality Gate — Implementacao Akita Way

Este documento e o contrato de implementacao do Quality Gate. Ele separa o que
deve ser script deterministico do que ainda precisa de julgamento por skill/IA.

## Objetivo

Reduzir uso de contexto de agente movendo tarefas mecanicas para scripts Node.js
nativos, mantendo skills apenas para julgamento contextual.

## Stack e comandos oficiais

- Runtime: Node.js nativo, sem dependencias externas por padrao.
- Scripts mutaveis precisam aceitar `--dry-run`.
- Scripts de auditoria precisam emitir saida clara com `✅`, `⚠️` e `❌`.
- Testes locais:

```bash
node --test scripts\doctor.test.cjs
node --test scripts\setup.test.cjs
node --test scripts\quality-gate.test.cjs
node --test scripts\bootstrap-repo.test.cjs
node --test scripts\docker-gate.test.cjs
node --test scripts\pr-snapshot.test.cjs
node --test scripts\ci-diagnose.test.cjs
node --test scripts\babysit-loop.test.cjs
node --test scripts\local-validate.test.cjs
node --test scripts\dependabot-consolidate.test.cjs
node --test scripts\e2e-smoke.test.cjs
node scripts\doctor.cjs --dry-run
node scripts\doctor.cjs --release
node scripts\bootstrap-repo.cjs --project . --dry-run
node scripts\docker-gate.cjs --project . --json
node --check scripts\doctor.cjs
```

## Fronteira script vs skill

Script faz:

- criar/atualizar arquivos padrao;
- validar JSON/config/workflow;
- chamar GitHub API ou `gh`;
- comparar metricas;
- gerar relatorios machine-readable;
- baixar e resumir artefatos de CI.

Skill faz:

- escolher perfil de qualidade;
- escrever texto especifico do README sem inventar feature;
- julgar excecao de baseline ou policy;
- resolver conflito arquitetural;
- corrigir codigo do repo alvo;
- escalar decisao humana.

## Arquitetura alvo

```text
.quality-gate/
  policy.json          # estado desejado; versionado
  policy.schema.json   # contrato validavel; versionado
  state.json           # estado detectado; gerado

scripts/
  QualityGate.ps1      # wrapper humano interativo (qg); scripts .cjs/.js abaixo sao a fonte deterministica que ele chama
  doctor.cjs           # auditor read-only por padrao
  setup.js             # orquestrador GitHub atual
  babysit-loop.cjs     # ciclo snapshot + diagnostico sem corrigir codigo
  dependabot-consolidate.cjs # plano dry-run para PRs Dependabot
  docker-gate.cjs      # detector Docker + wrapper Docker Image Doctor
  bootstrap-repo.cjs   # LICENSE/FUNDING/Dependabot/README scaffold
  local-validate.cjs   # validacao local unica para PR
  pr-snapshot.cjs      # JSON para babysit-pr
  ci-diagnose.cjs      # diagnostico deterministico de CI
  lib/
    policy.cjs         # ler/validar policy e escrever state
    docker-detect.cjs  # detectar Dockerfile/compose/.dockerignore
```

## Contrato de dados

`policy.json` e fonte de verdade. `state.json` nunca deve ser editado manualmente.
Ele precisa conter hash da policy e timestamp para evitar estado velho.

Campos minimos da policy:

```json
{
  "schemaVersion": 1,
  "profile": "strict-node",
  "ci": {
    "requiredChecks": ["Security audit", "Lint", "Tests & ratchet", "Docker image gate"],
    "advisoryChecks": ["SonarCloud", "SonarCloud Code Analysis"],
    "coverageRatchet": true,
    "maxFileLines": 300
  },
  "github": { "branchProtection": true },
  "bootstrap": { "license": { "enabled": true, "type": "MIT" } },
  "dockerImageDoctor": { "enabled": "auto", "blockOn": ["Critical"] }
}
```

O exemplo acima mostra formato, nao substitui `.quality-gate/policy.json`.

## Fases de implementacao

### Fase 1 — Policy/State

Status: implementada.

Comportamento:

- `doctor.cjs` valida que `.quality-gate/policy.json` existe e e coerente.
- `policy.ci.requiredChecks` precisa bater com jobs do workflow.
- `setup.js` branch protection precisa bater com `policy.ci.requiredChecks`.
- `doctor.cjs --write-state` gera `.quality-gate/state.json`.
- `state.json` inclui `policyHash`, `generatedAt`, `checks`, `summary`.
- `doctor.cjs --release` falha se houver Sonar placeholder, baseline zerado
  ou outro aviso bloqueante para uso real.

Aceite:

```bash
node --test scripts\doctor.test.cjs
node scripts\doctor.cjs --dry-run
node scripts\doctor.cjs --json
```

### Fase 2 — Docker Image Doctor Gate

Status: implementada.

Comportamento:

- `docker-gate.cjs` detecta primeiro se o repo usa Docker.
- Se nao houver Dockerfile, `.Dockerfile`, `.dockerignore`, `compose.yaml` ou
  `docker-compose.yaml`, retorna `skipped` e nao chama Docker Image Doctor.
- Se houver Docker, chama o helper local de forma nao interativa:

```powershell
& "D:\Dev\Scripts\seguranca\18-Docker-Image-Doctor.ps1" `
  -Project "<repo>" -Preset AI -ForAI -Json -FixPlan -NoPrompt
```

- `ddoctor-menu` fica somente para humano. Nunca usar em CI/agente.
- Resultado JSON entra em `.quality-gate/reports/docker-image-doctor.json` ou
  no `state.json` como ponteiro.
- Default inicial e advisory: bloqueia apenas `Critical`; `High` e `Medium`
  entram como aviso ate cada repo escolher modo estrito.
- Se helper local nao existir, fallback e `static-advisory`: checks Node
  simples sem Syft/Grype/Dive.

Motivo:

- Docker Doctor atual e bom, mas se rodar em repo sem Docker cria falso positivo
  de `.dockerignore` ausente. Por isso a deteccao precisa vir antes do scan.
- Ferramenta local grava logs em `C:\ProgramData\Scriply\Logs\Docker-Image-Doctor`
  e estado em `C:\ProgramData\Scriply\State\Docker-Image-Doctor`; Quality Gate
  deve copiar/sumarizar o JSON, nao depender de estado global velho.
- Escopo e build-time hardening. Nao controlar container, volume, porta,
  Dockhand, Hawser, `compose up/down`, prune ou live logs.

Aceite:

```bash
node --test scripts\docker-gate.test.cjs
node scripts\docker-gate.cjs --project . --json
node scripts\docker-gate.cjs --project . --dry-run
```

### Fase 3 — Bootstrap mecanico

Status: implementada.

Comportamento:

- `bootstrap-repo.cjs` cria/atualiza LICENSE, FUNDING e Dependabot.
- README ganha scaffold com markers para conteudo mecanico.
- README existente sem markers nao e sobrescrito.
- Workflow existente so e atualizado por `bootstrap-repo.cjs --upgrade` quando
  contem `# quality-gate:managed-workflow`; sem marker vira manual review.
- `setup.js` chama o bootstrap local antes de tocar GitHub API.
- `--skip-readme`, `--skip-funding`, `--skip-license`,
  `--skip-dependabot`, `--skip-bootstrap`, `--dry-run`.
- Resultado entra em `.quality-gate/reports/bootstrap-repo.json`.

Aceite:

```bash
node --test scripts\bootstrap-repo.test.cjs
node scripts\bootstrap-repo.cjs --project . --dry-run
node scripts\bootstrap-repo.cjs --project . --json
```

### Fase 4 — PR Snapshot

Status: implementada.

Comportamento:

- `pr-snapshot.cjs --pr N --json` coleta checks, mergeability, comentarios,
  review threads e artefatos com `gh` primeiro e fallback por API.
- Snapshot separa `checks.required`, `checks.advisory`, `checks.unknown`,
  `merge.blockers`, `merge.advisories` e `reviewThreads`.
- `ready` so existe quando `merge.ready === true`.
- Sonar falho entra como advisory quando nao estiver em branch protection ou
  policy required.
- `babysit-pr` passa a consumir snapshot JSON.

Aceite:

```bash
node --test scripts\pr-snapshot.test.cjs
node scripts\pr-snapshot.cjs --pr 42 --json --output .quality-gate/reports/pr-snapshot.json
```

### Fase 5 — CI Diagnose

Status: implementada.

Comportamento:

- `ci-diagnose.cjs --run ID --json` classifica lint, audit, coverage, Sonar e
  falha de infra.
- Sonar advisory vira `diagnose_optional_check`, nao blocker obrigatorio.
- Coverage stale vira categoria propria para impedir `qg-chk` com artefato velho.
- Artefatos de run apontam para `.quality-gate/reports/ci/<run-id>/`.
- Skill usa diagnostico pronto e decide correcao.
- `babysit-loop.cjs --pr N --once --json` une snapshot e diagnose em um ciclo
  deterministico. Ele nao corrige codigo; so retorna actions para a skill.
  O loop nao aceita `actions=["ready"]` se `merge.ready=false`.

Aceite:

```bash
node --test scripts\ci-diagnose.test.cjs
node scripts\ci-diagnose.cjs --snapshot .quality-gate/reports/pr-snapshot.json --json
```

### Fase 6 — Local Validate

Status: implementada.

Comportamento:

- `local-validate.cjs --project <repo> --profile pr --json` roda validacao local
  em uma unica entrada.
- Detecta `pipeline/pyproject.toml` e surfaces Node via `package.json`.
- Pytest usa `--basetemp .pytest-tmp-qg-<timestamp>-<pid>`.
- `node scripts/quality-gate.js check` so roda depois de pytest verde e
  `coverage/coverage.json` fresco.
- `node scripts/doctor.cjs --dry-run` e usado diretamente; aliases Scriply
  (`qg-chk`, `qg-doc`) sao conveniencia humana, nao dependencia do validador.
- Relatorio final vai para `.quality-gate/reports/local-validation.json`.

Aceite:

```bash
node --test scripts\local-validate.test.cjs
node scripts\local-validate.cjs --project . --profile pr --dry-run --json
```

### Fase 7 — Policy mixed e workflow

Status: implementada.

Comportamento:

- Policy aceita `project.surfaces`, `ci.advisoryChecks` e `localValidation`.
- `bootstrap-repo.cjs` detecta Python/uv e Node, grava policy inicial e workflow.
- Workflow gerado inclui `Python validation` e `UI validation` quando necessario.
- `doctor.cjs` avisa surface detectada sem policy e falha se surface required nao
  tiver job de workflow.

Aceite:

```bash
node --test scripts\doctor.test.cjs
node --test scripts\bootstrap-repo.test.cjs
```

### Fase 8 — Dependabot consolidation

Status: implementada V1 dry-run.

Comportamento:

- `dependabot-consolidate.cjs --repo OWNER/REPO --dry-run --json` lista PRs
  Dependabot abertos, arquivos tocados e conflitos provaveis.
- Dois PRs no mesmo workflow geram recomendacao `consolidate`.
- PRs independentes geram ordem sugerida de merge.

Aceite:

```bash
node --test scripts\dependabot-consolidate.test.cjs
node scripts\dependabot-consolidate.cjs --repo OWNER/REPO --dry-run --json
```

## Regras de alteracao

- Mudanca de comportamento precisa de teste primeiro.
- Nao adicionar dependencia sem motivo claro.
- Nao misturar bootstrap, PR snapshot e diagnose no mesmo patch.
- Nao baixar baseline automaticamente.
- Nao usar `state.json` como fonte de verdade.
