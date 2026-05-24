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
  doctor.cjs           # auditor read-only por padrao
  setup.js             # orquestrador GitHub atual
  babysit-loop.cjs     # ciclo snapshot + diagnostico sem corrigir codigo
  docker-gate.cjs      # detector Docker + wrapper Docker Image Doctor
  bootstrap-repo.cjs   # LICENSE/FUNDING/Dependabot/README scaffold
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
    "requiredChecks": ["Security audit", "Lint", "Tests & ratchet", "SonarCloud", "Docker image gate"],
    "coverageRatchet": true,
    "maxFileLines": 300
  },
  "bootstrap": {
    "license": { "enabled": true, "type": "MIT" },
    "funding": { "enabled": true, "buyMeACoffee": "ricardo230a" },
    "dependabot": { "enabled": true },
    "readme": { "enabled": true, "style": "devandreotti" }
  },
  "github": {
    "copilotReview": true,
    "branchProtection": true,
    "requireConversationResolution": true
  },
  "dockerImageDoctor": {
    "enabled": "auto",
    "runWhen": "docker-files-present",
    "scriptPath": "D:\\Dev\\Scripts\\seguranca\\18-Docker-Image-Doctor.ps1",
    "agentArgs": ["-Preset", "AI", "-ForAI", "-Json", "-FixPlan", "-NoPrompt"],
    "interactiveAllowed": false,
    "blockOn": ["Critical"],
    "warnOn": ["High", "Medium"],
    "fallbackWhenUnavailable": "static-advisory"
  }
}
```

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

- `pr-snapshot.cjs --pr N --json` coleta checks, mergeability, comentarios e
  artefatos com `gh` primeiro e fallback por API.
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
- Skill usa diagnostico pronto e decide correcao.
- `babysit-loop.cjs --pr N --once --json` une snapshot e diagnose em um ciclo
  deterministico. Ele nao corrige codigo; só retorna actions para a skill.

Aceite:

```bash
node --test scripts\ci-diagnose.test.cjs
node scripts\ci-diagnose.cjs --snapshot .quality-gate/reports/pr-snapshot.json --json
```

## Regras de alteracao

- Mudanca de comportamento precisa de teste primeiro.
- Nao adicionar dependencia sem motivo claro.
- Nao misturar bootstrap, PR snapshot e diagnose no mesmo patch.
- Nao baixar baseline automaticamente.
- Nao usar `state.json` como fonte de verdade.
