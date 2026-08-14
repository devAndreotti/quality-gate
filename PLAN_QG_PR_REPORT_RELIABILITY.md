# Plano - PR Report confiavel e email-friendly

Data: 2026-06-11

## Objetivo

Corrigir o fluxo de visibilidade do Quality Gate em pull requests para que o
comentario sticky, o email gerado pelo GitHub e os reports do Actions sejam
claros, acionaveis e nao induzam falso "PR pronto".

O gatilho deste plano foi o comentario atual do `github-actions[bot]`, que mostra
uma tabela simples de jobs e coverage, mas:

- parece visualmente pobre no email/comentario;
- diz "Todos os checks passaram" sem provar `snapshot.merge.ready`;
- mostra metricas Python que nao representam exatamente o que foi medido;
- depende de detalhes implicitos do workflow e de aliases locais.

Este plano segue Akita Way:

- comportamento antes de implementacao;
- teste RED antes do patch sempre que houver superficie testavel;
- mudancas pequenas e revertiveis;
- scripts deterministas antes de julgamento de agente;
- validacao focada, depois suite ampla.

## Regra de uso deste arquivo

- Marcar `[x]` somente depois de implementar, testar e validar a entrega.
- Nao marcar `[x]` se teste focado passou mas suite ampla quebrou.
- Se uma entrega mudar escopo, registrar em "Notas de execucao" antes de seguir.
- Nao implementar dois slices no mesmo patch quando eles alterarem contratos
  diferentes.

## Estado inicial verificado

- [x] `node --test scripts\*.test.cjs` executado antes do primeiro patch.
- [x] `node scripts\doctor.cjs --dry-run` executado antes do primeiro patch.
- [x] `node scripts\doctor.cjs --release` executado e resultado registrado.
- [x] `node scripts\local-validate.cjs --project . --profile pr --dry-run --json`
  executado e resultado registrado.

Ultima verificacao antes deste plano:

- `node --test scripts\*.test.cjs`: 96 testes passaram.
- `node scripts\doctor.cjs --dry-run`: 10 ok, 1 aviso, 0 falhas.
- `node scripts\doctor.cjs --release`: falha esperada por baseline zerado.
- `local-validate --dry-run`: planeja `qg-chk`, `qg-doc`, `git diff --check`,
  `git status`.

## Fontes de verdade

Arquivos que devem ser lidos antes de cada slice relevante:

- `README.md`
- `IMPLEMENTATION.md`
- `.quality-gate/policy.json`
- `.github/workflows/quality-gate.yml`
- `scripts/pr-comment.js`
- `scripts/pr-comment.test.cjs`
- `scripts/pr-snapshot.cjs`
- `scripts/pr-snapshot.test.cjs`
- `scripts/ci-diagnose.cjs`
- `scripts/local-validate.cjs`
- `scripts/quality-gate.js`
- `scripts/lib/workflow.cjs`
- `scripts/configure-project.cjs`
- `scripts/bootstrap-repo.cjs`
- `scripts/QualityGate.ps1`

## Nao fazer

- Nao tentar customizar template de email do GitHub como se fosse controlavel
  pelo repositorio. O repositorio controla comentario, job summary, annotations
  e checks; o email e derivado da notificacao do GitHub.
- Nao depender de `gh` no job `report` para montar o comentario se a informacao
  necessaria ja existe no contexto do workflow.
- Nao declarar PR pronto apenas por jobs verdes.
- Nao esconder erro de visibilidade sem pelo menos warning claro.
- Nao adicionar dependencia externa para renderizar Markdown.
- Nao misturar upgrade/migration de repos instalados com melhoria do comentario
  no mesmo slice.

## Contrato alvo do PR Report

O PR report deve responder no topo:

1. `Can merge?`
   - `yes`: `snapshot.merge.ready === true`.
   - `advisory`: required checks e merge policy ok, mas ha advisory.
   - `no`: existe blocker.
   - `unknown`: nao foi possivel confirmar merge/review threads.
2. `Next action`
   - comando ou acao humana concreta.
3. `Required checks`
   - somente checks requeridos pela policy/workflow.
4. `Advisories`
   - Sonar/Docker warning/outros opcionais sem bloquear por padrao.
5. `Coverage`
   - metricas reais, sem inventar `functions` para Python.
6. `Links`
   - run do Actions, PR snapshot/report quando existir.

O corpo precisa ser "email-friendly":

- resumo importante antes de qualquer `<details>`;
- tabelas pequenas;
- mensagens curtas;
- nomes de arquivos em monospace;
- detalhes longos dobraveis somente depois do resumo.

## Slices de implementacao

### Slice 1 - Report usa required checks explicitos no workflow raiz

Problema:

- `.github/workflows/quality-gate.yml` nao passa `REQUIRED_CHECKS` ao
  `pr-comment.js`.
- `pr-comment.js` cai para `JOB_ORDER`, que inclui jobs nao requeridos em alguns
  perfis.

Comportamento esperado:

- Workflow raiz passa `REQUIRED_CHECKS` coerente com `.quality-gate/policy.json`.
- `buildBody` continua funcionando quando `REQUIRED_CHECKS` existe.
- Comentario nao mostra jobs que nao fazem parte do contrato requerido.

Teste RED:

- [x] Adicionar teste em `scripts/pr-comment.test.cjs` ou `doctor.test.cjs`
  provando que workflow raiz expõe `REQUIRED_CHECKS`.
- [x] O teste deve falhar no estado atual.

Implementacao:

- [x] Atualizar `.github/workflows/quality-gate.yml`.
- [x] Se necessario, atualizar `scripts/lib/workflow.cjs` para manter workflow
  gerado com quoting correto.
- [x] Se necessario, atualizar `scripts/configure-project.cjs`.

Validacao:

- [x] `node --test scripts\pr-comment.test.cjs`
- [x] `node --test scripts\doctor.test.cjs`
- [x] `node scripts\doctor.cjs --dry-run`

Done:

- [x] Slice 1 entregue e validado.

### Slice 2 - Comentario sticky fica snapshot-aware

Problema:

- `pr-comment.js` calcula `allGreen` usando apenas resultados de jobs.
- Mensagem atual "Todos os checks passaram. Aguardando Copilot Review." pode
  parecer "pronto para merge", mesmo quando branch protection, review threads ou
  merge state bloqueiam.

Comportamento esperado:

- `buildBody` aceita um objeto opcional `snapshot` ou `snapshotPath`.
- Quando snapshot existe, status principal vem de `snapshot.merge.status`.
- `snapshot.merge.ready === true` e `ready` gera mensagem de pronto.
- `ready_with_advisory` mostra pronto com risco explicito.
- `blocked`, `review_threads_unknown`, `blocked_by_policy`,
  `unresolved_review_threads`, `required_check_pending` e
  `required_check_failed` aparecem como "nao pronto" ou "verificacao manual".
- Sem snapshot, comentario deve usar linguagem conservadora:
  "Required checks passed; merge readiness not verified".

Teste RED:

- [x] `buildBody` com jobs success e snapshot `merge.ready=false` nao pode conter
  "Todos os checks passaram" nem "ready".
- [x] `buildBody` com `blocked_by_policy` mostra blocker principal.
- [x] `buildBody` sem snapshot usa fallback conservador.

Implementacao:

- [x] Criar helper de leitura opcional de snapshot em `pr-comment.js`.
- [x] Criar helper `summarizeMergeState(snapshot, jobs)`.
- [x] Atualizar texto do topo do comentario.
- [x] Atualizar exports somente se testes precisarem.

Validacao:

- [x] `node --test scripts\pr-comment.test.cjs`
- [x] `node --test scripts\pr-snapshot.test.cjs`
- [x] `node --test scripts\babysit-loop.test.cjs`

Done:

- [x] Slice 2 entregue e validado.

### Slice 3 - Report job gera e injeta snapshot

Problema:

- Mesmo que `pr-comment.js` aceite snapshot, workflow precisa gerar o arquivo no
  job `report`.
- `pr-snapshot.cjs` pode precisar de `GITHUB_REPOSITORY`, `PR_NUMBER` e token.

Comportamento esperado:

- Job `report` roda `node scripts/pr-snapshot.cjs --pr $PR_NUMBER --json --output .quality-gate/reports/pr-snapshot.json`.
- Se snapshot falhar por permissao ou GraphQL, report ainda posta comentario
  com `unknown/manual verification`, nao some.
- `pr-comment.js` consome `.quality-gate/reports/pr-snapshot.json` quando existir.

Teste RED:

- [x] Teste de workflow ou renderer prova que `SNAPSHOT_PATH` e passado ao
  `pr-comment.js`.
- [x] Teste de `buildBody` com snapshot desconhecido mostra manual verification.

Implementacao:

- [x] Atualizar `.github/workflows/quality-gate.yml`.
- [x] Atualizar `scripts/lib/workflow.cjs`.
- [x] Atualizar `scripts/configure-project.cjs` para workflow Python/uv.
- [x] Atualizar docs de troubleshooting.

Validacao:

- [x] `node --test scripts\pr-comment.test.cjs`
- [x] `node --test scripts\bootstrap-repo.test.cjs`
- [x] `node --test scripts\configure-project.test.cjs`
- [x] `node scripts\doctor.cjs --dry-run`

Done:

- [x] Slice 3 entregue e validado.

### Slice 4 - Markdown email-friendly

Problema:

- Screenshot mostra layout pobre: texto solto, tabela estreita, details
  possivelmente ruins em email, baixo sinal de proxima acao.

Comportamento esperado:

- Topo com uma linha de status:
  `Quality Gate: blocked | waiting | ready | ready with advisory`.
- Bloco `Next action` curto e copiable.
- Tabela de required checks com label consistente.
- Coverage resumido no corpo principal.
- Detalhes de arquivos piores em `<details>` depois do resumo.
- Texto em portugues consistente ou configuravel por env/policy futura.

Teste RED:

- [x] Snapshot blocked gera `**Next action:**`.
- [x] Ready with advisory gera secao `Advisories`.
- [x] Comentario final contem marker sticky e link do run.
- [x] Comentario final nao depende de heading unico para semantica.

Implementacao:

- [x] Refatorar `buildBody` em helpers pequenos:
  - `renderHeader`
  - `renderNextAction`
  - `renderChecksTable`
  - `renderCoverageSummary`
  - `renderFooter`
- [x] Manter arquivo abaixo de limite razoavel; se passar de 300 linhas,
  considerar `scripts/lib/pr-report.cjs`.

Validacao:

- [x] `node --test scripts\pr-comment.test.cjs`
- [x] `node --check scripts\pr-comment.js`

Done:

- [x] Slice 4 entregue e validado.

### Slice 5 - Job summary do Actions

Problema:

- Comentario de PR/email nao deve carregar todos os detalhes.
- GitHub Actions tem `GITHUB_STEP_SUMMARY`, melhor lugar para relatorio completo
  do run.

Comportamento esperado:

- `pr-comment.js` ou novo helper consegue escrever Markdown no path
  `process.env.GITHUB_STEP_SUMMARY` quando existir.
- Summary contem tabela completa de checks, coverage e blockers.
- Comentario fica compacto e aponta para run completo.

Teste RED:

- [x] Teste cria arquivo temporario como `GITHUB_STEP_SUMMARY` e prova escrita.
- [x] Sem env var, nada quebra.

Implementacao:

- [x] Adicionar helper `writeStepSummary`.
- [x] Chamar no `main` ou em fluxo controlado.
- [x] Atualizar workflow se precisar de env.

Validacao:

- [x] `node --test scripts\pr-comment.test.cjs`
- [x] `node scripts\pr-comment.js` com env fake em teste unitario via fetch mock
  quando aplicavel.

Done:

- [x] Slice 5 entregue e validado.

### Slice 6 - Annotations para falhas acionaveis

Problema:

- Falhas importantes ficam enterradas no comentario/log.
- GitHub Actions suporta `::notice`, `::warning`, `::error` para anotar arquivo
  e linha quando houver dados.

Comportamento esperado:

- Coverage worst files podem gerar `::warning title=Low coverage,file=...`.
- Blockers sem arquivo viram warning geral.
- Required check failed pode gerar warning geral com proxima acao.
- Limitar quantidade para evitar spam.

Teste RED:

- [x] Helper `renderAnnotations` retorna no maximo limite configurado.
- [x] File path e mensagem sao escapados para workflow command.
- [x] Sem dados de linha, annotation continua valida.

Implementacao:

- [x] Criar helper puro para workflow commands.
- [x] Integrar no `main` sem poluir `buildBody`.
- [x] Documentar limite.

Validacao:

- [x] `node --test scripts\pr-comment.test.cjs`
- [x] `node --check scripts\pr-comment.js`

Done:

- [x] Slice 6 entregue e validado.

### Slice 7 - Coverage Python honesta

Problema:

- `quality-gate.js` e `pr-comment.js` copiam `percent_covered` para
  `statements` e `functions` em coverage Python.
- Isso cria tabela falsa: lines/statements/functions iguais.

Comportamento esperado:

- Python coverage mostra `lines` e `branches` quando disponiveis.
- `statements` e `functions` aparecem como `n/a` ou ficam omitidas para Python.
- Ratchet nao deve falhar por metricas Python inexistentes, salvo se baseline
  explicitamente exigir.

Teste RED:

- [x] `readCoverageSection` com coverage.py nao mostra `functions` como 88.5%.
- [x] `runQualityGate` com coverage.py nao inventa `functions`.
- [x] Baseline antigo com `functions` nao quebra de forma ambigua; resultado deve
  ser documentado.

Implementacao:

- [x] Ajustar `collectPythonCoverage` em `quality-gate.js`.
- [x] Ajustar `readPythonCoverage` em `pr-comment.js`.
- [x] Ajustar `compareMetrics` para ignorar metricas `null`/`n/a` ou tratar por
  profile.
- [x] Atualizar fixtures de teste.

Validacao:

- [x] `node --test scripts\quality-gate.test.cjs`
- [x] `node --test scripts\pr-comment.test.cjs`
- [x] `node --test scripts\*.test.cjs`

Done:

- [x] Slice 7 entregue e validado.

### Slice 8 - `local-validate` portavel sem aliases Scriply

Problema:

- `local-validate.cjs` chama `qg-chk` e `qg-doc`.
- Esses aliases existem no ambiente Scriply, mas nao em clone limpo.

Comportamento esperado:

- Validador usa `node scripts/quality-gate.js check`.
- Validador usa `node scripts/doctor.cjs --dry-run`.
- Se scripts nao existirem no target, erro deve explicar instalacao incompleta.
- Aliases podem continuar documentados como conveniencia, nao dependencia.

Teste RED:

- [x] `buildValidationPlan` deve conter comandos `node scripts/quality-gate.js check`
  e `node scripts/doctor.cjs --dry-run`, nao `qg-chk`/`qg-doc`.
- [x] Execucao fake deve usar `process.execPath` ou `node` com args portaveis.

Implementacao:

- [x] Atualizar `local-validate.cjs`.
- [x] Atualizar `local-validate.test.cjs`.
- [x] Atualizar README onde chama `qg-chk/qg-doc` como caminho preferido.

Validacao:

- [x] `node --test scripts\local-validate.test.cjs`
- [x] `node scripts\local-validate.cjs --project . --profile pr --dry-run --json`

Done:

- [x] Slice 8 entregue e validado.

### Slice 9 - Sticky comment robusto com paginacao e failure mode

Problema:

- Busca somente os primeiros 100 comentarios.
- Erro ao postar comentario termina com exit 0, escondendo falha.

Comportamento esperado:

- Busca comentarios paginando ate achar marker ou acabar.
- `COMMENT_FAILURE_MODE=warn|fail` controla exit code.
- Modo default deve ser `warn` para nao quebrar merge por instabilidade do
  comentario, mas precisa emitir `::warning`.

Teste RED:

- [x] Mock com marker na pagina 2 atualiza comentario existente.
- [x] Erro de API em mode `fail` retorna/propaga falha.
- [x] Erro de API em mode `warn` nao quebra, mas registra warning.

Implementacao:

- [x] Criar `listIssueComments` paginado.
- [x] Criar `handleCommentError`.
- [x] Atualizar `main`.

Validacao:

- [x] `node --test scripts\pr-comment.test.cjs`
- [x] `node --check scripts\pr-comment.js`

Done:

- [x] Slice 9 entregue e validado.

### Slice 10 - Upgrade/migration para repos ja instalados

Problema:

- `bootstrap-repo.cjs` preserva workflow/policy existentes.
- Isso e seguro para nao destruir customizacao, mas impede atualizar repos ja
  instalados com novo PR report.

Comportamento esperado:

- Novo comando dry-run mostra diff/plano de upgrade do Quality Gate.
- Nao sobrescreve arquivo customizado sem markers ou confirmacao explicita.
- Pode atualizar blocos gerenciados ou arquivos 100% gerenciados.
- Registra versao de pacote instalada se houver metadata.

Teste RED:

- [x] Repo fixture com workflow antigo recebe plano `would update managed workflow`.
- [x] Repo fixture com workflow customizado recebe `manual review required`.
- [x] Dry-run nao escreve.

Implementacao:

- [x] Decidir se sera `bootstrap-repo.cjs --upgrade` ou novo
  `upgrade-repo.cjs`.
- [x] Adicionar metadata/marker de versao onde seguro.
- [x] Atualizar README.

Validacao:

- [x] `node --test scripts\bootstrap-repo.test.cjs`
- [x] `node --test scripts\e2e-smoke.test.cjs`

Done:

- [x] Slice 10 entregue e validado.

## Ordem recomendada

1. Slice 1 - `REQUIRED_CHECKS` no workflow raiz.
2. Slice 2 - comentario snapshot-aware.
3. Slice 3 - report job gera/injeta snapshot.
4. Slice 4 - Markdown email-friendly.
5. Slice 7 - coverage Python honesta.
6. Slice 8 - `local-validate` portavel.
7. Slice 9 - sticky comment robusto.
8. Slice 5 - job summary.
9. Slice 6 - annotations.
10. Slice 10 - upgrade/migration.

Motivo:

- Primeiro remove falso positivo de prontidao.
- Depois melhora apresentacao.
- Depois corrige metricas e portabilidade.
- Por fim adiciona canais extras e migracao.

## Gates por slice

Cada slice deve seguir:

1. Declarar comportamento alterado.
2. Escrever teste RED.
3. Rodar teste focado e confirmar falha esperada.
4. Implementar menor patch.
5. Rodar teste focado ate verde.
6. Rodar suite do blast radius.
7. Rodar `node scripts\doctor.cjs --dry-run` se workflow/policy/docs mudarem.
8. Revisar diff para escopo acidental.
9. Marcar `[x]` neste arquivo.

## Validacao final da fase

- [x] `node --test scripts\*.test.cjs`
- [x] `node scripts\doctor.cjs --dry-run`
- [x] `node scripts\doctor.cjs --release` executado e resultado registrado.
- [x] `node scripts\bootstrap-repo.cjs --project . --dry-run`
- [x] `node scripts\docker-gate.cjs --project . --json`
- [x] `node scripts\local-validate.cjs --project . --profile pr --dry-run --json`
- [x] `git diff --check`

## Criterios de aceite finais

- [x] Comentario nao declara PR pronto se `snapshot.merge.ready=false`.
- [x] Comentario mostra blockers de policy/review threads/required checks.
- [x] Comentario com required checks verdes mas snapshot ausente usa linguagem
  conservadora.
- [x] Workflow raiz e workflows gerados passam `REQUIRED_CHECKS`.
- [x] Python coverage nao inventa `functions`.
- [x] `local-validate` funciona em clone limpo com Node, sem Scriply aliases.
- [x] Sticky comment nao duplica por marker fora da primeira pagina.
- [x] Falha de comentario fica visivel por warning ou falha configuravel.
- [x] Job summary existe ou esta explicitamente adiado.
- [x] README documenta novo comportamento.

## Notas de execucao

Use esta area durante implementacao:

- 2026-06-11: plano criado; nenhuma entrega implementada ainda.
- 2026-06-11: baseline pre-patch executado. Suite passou com 96 testes.
  `doctor --dry-run` passou com 1 aviso. `doctor --release` falhou por
  baseline zerado, resultado esperado e ja documentado. `local-validate`
  dry-run executado.
- 2026-06-11: Slice 1/2 entregues. RED confirmado em `pr-comment.test.cjs`
  para `REQUIRED_CHECKS` ausente e falso pronto sem snapshot. GREEN validado
  com `pr-comment`, `pr-snapshot`, `babysit-loop`, `doctor.test`,
  `doctor --dry-run` e `node --check scripts/pr-comment.js`.
- 2026-06-11: Slice 3 entregue. RED confirmado em workflow raiz, bootstrap e
  configure-project sem `SNAPSHOT_PATH`. GREEN validado com `pr-comment`,
  `bootstrap-repo`, `configure-project` e `doctor --dry-run`. README documenta
  fallback conservador e permissao `issues: write`.
- 2026-06-11: Slice 4 entregue. RED confirmado para coverage resumido fora de
  `<details>`. GREEN validado com `pr-comment.test` e `node --check`.
  `pr-comment.js` passou de 300 linhas; extracao para `scripts/lib/pr-report.cjs`
  foi considerada, mas adiada para evitar refactor amplo antes das correcoes de
  contrato restantes.
- 2026-06-11: Slice 7 entregue. RED confirmado para Python coverage inventando
  `statements/functions` e baseline antigo falhando. GREEN validado com
  `quality-gate.test`, `pr-comment.test`, `node --check` e suite completa
  `node --test scripts\*.test.cjs` com 104 testes.
- 2026-06-11: Slice 8 entregue. RED confirmou dependencia de `qg-chk/qg-doc`.
  GREEN trocou por `node scripts/quality-gate.js check` e
  `node scripts/doctor.cjs --dry-run`, com erro claro para instalacao
  incompleta. Validado com `local-validate.test`, dry-run JSON e `doctor`.
- 2026-06-11: Slice 9 entregue. RED confirmou marker fora da primeira pagina
  e ausencia de `COMMENT_FAILURE_MODE`. GREEN adicionou paginacao e
  `warn|fail`, validado com `pr-comment.test` e `node --check`.
- 2026-06-11: Slice 5 entregue. RED confirmou helper ausente para
  `GITHUB_STEP_SUMMARY`. GREEN adicionou `writeStepSummary` e chamada no
  `main`, validado com `pr-comment.test` e `node --check`.
- 2026-06-11: Slice 6 entregue. RED confirmou ausencia de annotations. GREEN
  adicionou `renderAnnotations`, escaping de workflow commands e limite default
  5, validado com `pr-comment.test` e `node --check`.
- 2026-06-11: Slice 10 entregue. RED confirmou ausencia de `--upgrade` e de
  plano para workflow gerenciado/custom. GREEN adicionou
  `bootstrap-repo.cjs --upgrade`, marker `# quality-gate:managed-workflow` e
  manual review para workflow sem marker. Validado com `bootstrap-repo.test`,
  `e2e-smoke.test` e `doctor --dry-run`.
- 2026-06-11: validacao final executada. Suite passou com 113 testes.
  `doctor --dry-run`, `bootstrap-repo --dry-run`, `docker-gate --json`,
  `local-validate --dry-run --json` e `git diff --check` passaram.
  `doctor --release` foi executado e falhou apenas por `baseline.json real`
  zerado, blocker ja conhecido neste pacote.
- 2026-06-11: `.codex/skills/babysit-pr` atualizado para refletir sticky comment
  snapshot-aware, `GITHUB_STEP_SUMMARY` e annotations.
