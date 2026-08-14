# Plano - `qg` como operador interativo principal

Data: 2026-06-15

## Objetivo

Transformar `qg` no cockpit local do Quality Gate: uma entrada unica para
instalar, diagnosticar, validar, configurar GitHub, inspecionar PR e acionar
babysit sem depender de memoria manual do agente.

Hoje `qg` sem flags mostra ajuda. Alvo: `qg` sem flags abre menu interativo
seguro; flags continuam funcionando para automacao.

## Fronteira clara

Quality Gate faz:

- copia pacote local (`.github`, `scripts`, `.quality-gate`, `.codex`);
- detecta perfil do projeto (`node`, `python-uv`, futuro mixed);
- gera workflow e policy;
- compara cobertura contra baseline;
- roda doctor local;
- configura ruleset e branch protection quando GitHub permite;
- gera snapshot deterministico de PR;
- roda babysit loop sem editar codigo;
- comenta PR com status compacto e email-friendly.

IA / skill faz:

- decidir se blocker exige mudanca de codigo;
- alterar codigo do repo alvo;
- interpretar excecao de arquitetura ou produto;
- decidir se advisory vira required;
- resumir risco e orientar humano;
- acompanhar PR ate merge quando usuario pedir babysit.

## Regras de produto

- SonarCloud nao e obrigatorio por padrao. Sem org/token, fica `skipped` ou
  advisory, salvo policy explicita.
- Copilot Review nao e obrigatorio por padrao. Sem credito, sem review ou sem
  permissao, Quality Gate deve mostrar advisory/manual, nao travar merge.
- Docker gate so bloqueia quando Docker surface existe ou policy exige.
- `PR report` nunca deve ser required check por padrao; ele e visibilidade.
- `ready` so existe quando required checks verdes, merge state limpo, PR nao
  draft e review threads conhecidas/resolvidas.
- Token nunca deve ser salvo em repo, memoria ou plano.

## Uso ideal no terminal

### Instalar em projeto novo

```powershell
cd <repo>
qg
# menu: Install/repair Quality Gate
```

Fluxo esperado:

1. detectar stack;
2. copiar pacote;
3. ajustar `.gitignore`;
4. rodar doctor;
5. criar baseline se cobertura existir;
6. commitar opcional;
7. explicar GitHub setup:
   - se repo/branch remota existe, aplicar ruleset/protection;
   - se nao existe, instruir `git push -u origin <branch>` e marcar etapa como
     `skipped`, nao falha fatal.

### Validar antes de PR

```powershell
qg
# menu: Run local PR validation
```

Por baixo:

```powershell
node scripts\local-validate.cjs --project . --profile pr --json
```

### Configurar GitHub depois do primeiro push

```powershell
qg
# menu: Setup GitHub remote policy
```

Por baixo:

```powershell
node scripts\setup.js --repo=<owner/repo> --skip-sonar
```

Com Sonar:

```powershell
node scripts\setup.js --repo=<owner/repo> --sonar-org=<org> --sonar-token=<token>
```

### Acompanhar PR

```powershell
qg
# menu: PR snapshot / Babysit PR
```

Por baixo:

```powershell
node scripts\pr-snapshot.cjs --pr <numero> --json --output .quality-gate\reports\pr-snapshot.json
node scripts\babysit-loop.cjs --pr <numero> --once --json
```

## Slices e checklist

### Slice 1 - Corrigir fluxo Node real

- [x] `qg-init` detecta projeto Node e gera workflow de consumidor, nao workflow
  de self-test do pacote.
- [x] Workflow Node roda `npm ci`, lint/test/build opcionais, ratchet, audit,
  docker gate e PR report.
- [x] `doctor.cjs` aceita workflow Node legado quando surface equivalente existe.
- [x] Validado em repo lab com PR real.

Validacao:

```powershell
node --test scripts\configure-project.test.cjs
node --test scripts\doctor.test.cjs
```

### Slice 2 - Corrigir portabilidade Windows

- [x] `local-validate.cjs` executa `npm`, `uv` e `uvx` via `cmd.exe` no Windows
  para evitar `spawnSync EINVAL`.
- [x] Teste focado cobre wrapper Windows.

Validacao:

```powershell
node --test scripts\local-validate.test.cjs
```

### Slice 3 - PR tools sem `--repo` manual

- [x] `pr-snapshot.cjs` detecta repo via `git remote origin`.
- [x] `babysit-loop.cjs` passa `cwd` para snapshot.
- [x] `ci-diagnose.cjs` usa mesmo helper.
- [x] Lab validado sem `--repo` manual.

Validacao:

```powershell
node --test scripts\pr-snapshot.test.cjs
node --test scripts\babysit-loop.test.cjs
```

### Slice 4 - Evitar falso blocker no `PR report`

- [x] Quando branch protection API falha por permissao do `GITHUB_TOKEN`, snapshot
  usa `.quality-gate/policy.json` como fallback local.
- [x] Required checks sao deduplicados.
- [x] `PR report` fica `unknown`/nao required quando nao esta na policy.
- [x] Lab PR #6: snapshot retorna `merge.ready=true`.

Validacao:

```powershell
node --test scripts\pr-snapshot.test.cjs
node scripts\pr-snapshot.cjs --pr 6 --json
node scripts\babysit-loop.cjs --pr 6 --once --json
```

### Slice 5 - Atualizar actions para evitar Node 20 deprecation

- [x] Geradores usam `actions/checkout@v6`.
- [x] Geradores usam `actions/setup-node@v6`.
- [x] Geradores usam `actions/upload-artifact@v7`.
- [x] Geradores usam `actions/download-artifact@v8`.
- [x] Lab PR #6 passou sem annotations.

Validacao:

```powershell
rg "actions/(checkout|setup-node|upload-artifact|download-artifact)@v4" .
gh run watch <run-id> --repo <owner/repo> --exit-status
```

### Slice 6 - Preflight GitHub menos fragil

- [x] `setup.js` nao falha fatalmente quando branch default ainda nao existe no
  GitHub; branch protection vira `skipped` com detalhe acionavel.
- [x] `qg-init` detecta `GITHUB_TOKEN/GH_TOKEN` ativo e prefere token do `gh`
  keyring com env limpo quando disponivel.
- [x] `qg-init` restaura env original depois de executar `setup.js`.

Validacao:

```powershell
node --test scripts\setup.test.cjs
pwsh -NoProfile -Command '& { $code = Get-Content -LiteralPath ".\scripts\QualityGate.ps1" -Raw; [scriptblock]::Create($code) | Out-Null }'
```

### Slice 7 - Menu `qg` interativo

- [x] `qg` sem flags abre menu, nao apenas help.
- [x] Menu detecta se Quality Gate esta instalado no cwd.
- [x] Menu mostra estado resumido:
  - perfil;
  - repo remoto;
  - branch atual;
  - token env ativo;
  - ultimo report local;
  - PR detectado quando branch tem upstream.
- [x] Opcoes iniciais:
  - install/repair;
  - doctor;
  - local PR validation;
  - update baseline;
  - setup GitHub policy;
  - PR snapshot;
  - babysit PR once;
  - show report;
  - help.
- [x] Flags existentes continuam sem prompt.

Implementado via `Out-ConsoleGridView` (modulo `Microsoft.PowerShell.ConsoleGuiTools`,
instalado sob demanda em `Invoke-QgMenu`; se a instalacao falhar, cai para menu de
texto por `Read-Host`). Instalar/repair chama `Invoke-Init` (mesmo wizard do `-Init`,
extraido para funcao). Doctor/Update/Show report chamam `doctor.cjs`/`quality-gate.js`
diretamente no `$ProjectRoot`.

Teste alvo:

```powershell
pwsh -NoProfile -File scripts\QualityGate.ps1 -Help
pwsh -NoProfile -File scripts\QualityGate.ps1 -Doctor
```

### Slice 8 - Doctor de auth e remoto

- [x] Novo diagnostico mostra quando `GITHUB_TOKEN` ou `GH_TOKEN` esta ativo.
- [x] Diagnostico distingue:
  - token env ativo;
  - gh keyring disponivel;
  - repo remoto ausente;
  - repo remoto sem branch default.
- [ ] push sem permissao — nao verificado ativamente por `Get-QgAuthDiagnostic` (exigiria uma
  chamada de escrita de teste); hoje so aparece indiretamente quando `setup.js` falha durante
  o setup do GitHub. Gap real, nao implementado.
- [x] Mensagem sugere comando temporario seguro:

```powershell
$env:GITHUB_TOKEN=$null; $env:GH_TOKEN=$null; git push
```

### Slice 9 - Fluxo PR integrado

- [x] Menu pede numero do PR quando nao conseguir inferir (`Resolve-QgPrNumber`: tenta
  `gh pr view` na branch atual, senao pergunta).
- [x] `qg` salva snapshot em `.quality-gate/reports/pr-snapshot.json`.
- [x] Resultado humano mostra:
  - ready / blocked / waiting / advisory;
  - blockers;
  - next command;
  - link do PR/run.
- [x] `babysit once` chama `babysit-loop.cjs --once`.
- [x] Loop continuo fica opcional e explicito (menu so oferece `--once`; loop continuo
  continua exigindo `babysit-loop.cjs --pr N` sem `--once` fora do menu).

### Slice 10 - Docs e skill

- [x] README passa a recomendar `qg` como entrada primaria local.
- [x] `IMPLEMENTATION.md` documenta `qg` como wrapper humano, scripts como fonte
  deterministica.
- [x] Skill `babysit-pr` revisada: usar `qg`/scripts quando instalados; nao
  reinventar snapshot manual antes.
- [x] Docs deixam claro: email do GitHub nao e customizavel diretamente; o que
  controlamos e comentario, job summary, annotations e checks.

## Criterios de aceite finais

- `qg-init` em repo sem branch remota nao termina em erro bruto `Branch not found`.
- `qg-init` com token env ruim avisa e tenta keyring antes.
- `qg` sem flags guia usuario pelo proximo passo correto.
- PR com checks required verdes e `PR report` verde retorna `ready`.
- Sem Sonar ou Copilot Review nao vira blocker automatico.
- Lab repo continua passando CI real.
- Suite local completa passa:

```powershell
node --test scripts\*.test.cjs
node scripts\doctor.cjs --dry-run
node scripts\local-validate.cjs --project . --profile pr --json
git diff --check
```

## Stop conditions

- Parar se menu precisar armazenar token.
- Parar se GitHub API retornar permissao insuficiente para repo privado e nao
  houver `gh auth status` confiavel.
- Parar se branch protection existente tiver regras customizadas que o setup
  sobrescreveria sem diff/plano.
- Parar se policy do projeto exigir Sonar/Copilot como required e token/credito
  nao existir.

## Nao salvar como verdade permanente

- Tokens, org secrets, PR efemero, run id, estado momentaneo de CI.
- Branch temporaria do lab como regra geral.
- Credito atual do Copilot.
- Resultado de um snapshot antigo como readiness permanente.
