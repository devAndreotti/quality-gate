---
name: babysit-pr
description: |
  Monitora e itera sobre um pull request do GitHub até ele estar pronto para merge.
  Use esta skill SEMPRE que o usuário pedir para "monitorar", "acompanhar", "babysitar",
  "ficar de olho", "cuidar", "resolver comentários" ou "deixa rodando" em relação a um PR.
  Também ativa quando o usuário diz "me avisa quando passar", "resolve os comentários",
  "cuida do PR pra mim", "fica de olho no CI", ou qualquer variação de acompanhar um PR.
  A skill mantém um loop contínuo verificando: CI (GitHub Actions), quality gate (ratchet
  + SonarCloud), Copilot Review, e revisores humanos — corrigindo e pushando quando
  possível, escalando para o usuário apenas quando encontra um bloqueador que não
  consegue resolver sozinho.
---

# Babysit PR

Loop contínuo até um desfecho terminal: PR mergeado, fechado, ou bloqueador humano.

## Início rápido

1. Identifique o PR (número ou URL) na mensagem do usuário.
2. Se não foi especificado, use `gh pr list` para mostrar os PRs abertos.
3. Rode `node scripts/babysit-loop.cjs --pr N --once --json`.
4. Se precisar de detalhe bruto, rode `pr-snapshot.cjs` e `ci-diagnose.cjs`.
5. Leia `references/fix-playbook.md` apenas para a action retornada.
6. **Entre no loop imediatamente** — não peça confirmação.

## O loop

```
loop até desfecho terminal:
  ciclo = babysit-loop.cjs       # snapshot + diagnose
  ações = ciclo.actions          # classifica falhas determinísticas
  fix(ações)                     # corrige código, commit, push
  wait_ci()                      # polling até próximo ciclo
```

## Snapshot — fonte de verdade do ciclo

Prefira sempre o script:

```bash
node scripts/babysit-loop.cjs --pr $PR_NUMBER --once --json
```

Para artefatos persistidos:

```bash
node scripts/pr-snapshot.cjs --pr $PR_NUMBER --json --output .quality-gate/reports/pr-snapshot.json
```

Se `latestRun.id` existir e `ci.overall == "failure"`:

```bash
node scripts/ci-diagnose.cjs --snapshot .quality-gate/reports/pr-snapshot.json --json --output .quality-gate/reports/ci-diagnose.json
```

Use os comandos manuais de `references/pr-watcher.md` só quando o script falhar.

```json
{
  "pr": {
    "number": 42,
    "branch": "feature/codex-xyz",
    "mergeable": "MERGEABLE",
    "mergeStateStatus": "BLOCKED"
  },
  "ci": {
    "overall": "failure",
    "jobs": {
      "security": "success",
      "lint": "failure",
      "test": "success",
      "sonar": "failure",
      "report": "success"
    }
  },
  "copilotBlockers": ["src/auth.ts:42 - sem tratamento de erro"],
  "humanBlockers": [],
  "latestRun": { "id": 123456789 },
  "artifacts": [{ "name": "coverage-report" }],
  "actions": ["fix_lint", "diagnose_sonar"]
}
```

O campo `actions` dita as correções deste ciclo.

## Tabela de actions

| Action | Quando | O que fazer |
|--------|--------|-------------|
| `fix_lint` | ESLint falhou | `npx eslint src --fix` + corrigir manualmente o que sobrar |
| `fix_security` | npm audit critical | `npm audit fix`, testar, verificar breaking changes |
| `fix_ratchet` | coverage regrediu | ver arquivos com menor % em coverage-summary.json, adicionar testes |
| `diagnose_ci` | job genérico falhou | ler logs do job, classificar (código vs infra), corrigir |
| `process_copilot` | Copilot comentou "Bloqueador:" | implementar correção sugerida, um commit por comentário |
| `process_human` | revisor pediu mudança | implementar, manter o reviewer informado |
| `diagnose_sonar` | SonarCloud falhou | ler comentário do sonarcloud[bot] no PR, corrigir issues |
| `diagnose_docker` | Docker image gate falhou | ler `.quality-gate/reports/docker-image-doctor.json` ou logs do job |
| `rerun_flaky` | falha de infra/timeout | `gh run rerun $RUN_ID --failed` (máx 3x) |
| `wait_ci` | CI rodando | aguardar com polling a cada 30s |
| `ready` | tudo verde e sem blockers | reportar PR pronto |
| `escalate` | bloqueador ambíguo | reportar ao usuário com contexto completo |

## Regras de commit/push

- Commit e push após **cada** correção, nunca acumule vários fixes sem push.
- Formato: `fix(babysit): [tipo] [descrição curta]`
  - Exemplos: `fix(babysit): eslint no-unused-vars em useAuth.ts`
  - `fix(babysit): cobertura de branches em userReducer.test.ts`
  - `fix(babysit): sonar code smell em api/client.ts`
- Nunca force-push. Sempre commits normais sobre a branch do PR.
- Após push, aguardar CI completar antes do próximo snapshot.

## Onde o agente encontra os artefatos de erro

O CI faz upload de dois artefatos que o agente deve ler para diagnóstico:

**coverage-report** — gerado pelo job `test`:
- `coverage/coverage-summary.json` — métricas por arquivo (ver quais regrediram)
- `coverage/lcov.info` — para o SonarCloud
- `coverage/eslint-report.json` — violations do ESLint em JSON

```bash
# Baixar artefatos do run mais recente
gh run download $(gh run list --branch $(gh pr view $PR --json headRefName -q .headRefName) \
  --json databaseId -q '.[0].databaseId') --dir /tmp/ci-artifacts
```

**Sticky comment no PR** — sempre atualizado pelo job `report`:
- Mostra status de todos os jobs
- Tabela de coverage vs baseline
- Top 3 arquivos com menor cobertura

## Desfechos terminais

| Condição | O que fazer |
|----------|-------------|
| PR mergeado ou fechado | Encerrar, reportar resumo ao usuário |
| CI verde + Sonar ok + sem blockers | Reportar "PR pronto" e parar o loop |
| Conflito de merge complexo | Escalate — decisão humana de arquitetura |
| 3 re-runs sem sucesso no mesmo job | Escalate — provavelmente infra |
| 10 ciclos sem progresso | Escalate com histórico de tentativas |
| Comentário humano pede decisão de design | Escalate imediato |

## Escalate — template

Ao escalar, inclua sempre:

```
🚨 Babysit PR #[N] — preciso da sua atenção

O que foi feito nesta sessão:
- [lista de commits feitos]

O que está bloqueando:
- [erro exato]

Hipótese do motivo:
- [análise]

O que você precisa decidir/fazer:
- [ação específica necessária]
```

## Referências

- `references/pr-watcher.md` — todos os comandos `gh` para snapshot e polling
- `references/fix-playbook.md` — receitas detalhadas de correção por tipo de falha
