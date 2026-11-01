# Plano: histórico, análise profunda, IA, Socket e CLI

Investigação feita sobre `origin/main` (commit `6c3e4ff` e posteriores). Cada afirmação abaixo
aponta para o arquivo onde foi verificada. Nada aqui é estimativa de números: métricas
futuras devem vir de dados reais do repositório.

## 1. Estado atual (fatos verificados)

| Item                        | Situação hoje                                                                                                                                       | Onde                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Painel: histórico           | **Inexistente**. O painel é um retrato do momento: estado local + checks do último commit de `origin/main`. Nenhuma série temporal.                 | `scripts/dashboard.cjs` (234 linhas, `collectState`, `collectChecks`)          |
| Painel: HTML público        | Gerado por `dashboard-publish.cjs` (202 linhas) e publicado no Pages pelo job `dashboard` de `quality-extras.yml`. Sem gráficos.                    | `scripts/dashboard-publish.cjs`                                                |
| Painel: TUI                 | Fonte Ink em `dashboard-src/app.jsx` (105 linhas), compilada para `scripts/dashboard-tui.mjs`. Reusa a coleta do modo texto.                        | `dashboard-src/app.jsx`                                                        |
| Histórico que já existe     | Só na frota: `fleet-github.cjs` grava `fleet-history.jsonl` fora do repo. O formato existe e é reutilizável.                                        | `scripts/fleet-github.cjs` (`appendHistory`, `readHistory`)                    |
| Semgrep e CodeQL            | Ambos sobem SARIF para code scanning. **O painel não lê esses alertas.** `new-code-findings.cjs` só exclui caminhos.                                | `.github/workflows/semgrep.yml`, `codeql.yml`, `scripts/new-code-findings.cjs` |
| Alertas Dependabot          | Contados só pela frota, não pelo painel do projeto.                                                                                                 | `scripts/fleet-github.cjs` (`countAlerts`)                                     |
| Revisão com IA              | Só `workflow_dispatch`. Não roda em PR. Em runner hospedado pelo GitHub sai como `skipped` (o modelo local não é alcançável). Não é required check. | `.github/workflows/ai-review.yml`, `scripts/pr-ai-review.cjs`                  |
| Socket (pacotes maliciosos) | **Nenhuma integração.** A única ocorrência de "socket" é de Docker e de testes de rede.                                                             | busca no repo                                                                  |
| CLI                         | `scripts/qg.cjs` despacha 8 comandos com saída de texto puro. Não tem `--json` nem `qg status`.                                                     | `scripts/qg.cjs` (PR #75)                                                      |

Conclusão da investigação: três das cinco frentes pedidas (histórico, análise profunda com
Semgrep/CodeQL, Socket) estão **do zero no painel**, mas já existe o que reaproveitar
(formato de histórico da frota, leitura de alertas por `gh api`, SARIF que já é enviado).
A IA está montada, mas fora do fluxo de PR. A CLI funciona, mas só como despachante.

## 2. Decisões que dependem de você

1. **Onde guardar o histórico.** Opções:
   - (a) branch dedicado `qg-metrics` com um `.jsonl` por dia, lido pelo painel. Versionado, público, sem servidor.
   - (b) artefato de workflow com retenção de 90 dias. Sem tendência de longo prazo.
   - (c) fora do repo, como a frota. Privado, mas não aparece no painel público.
     **Recomendação: (a).** Os dados são de cobertura e contagem de alertas, não há segredo. Confirme se o repositório público pode ter esse branch.
2. **Socket.** Exige instalar o app Socket nos repositórios e um token. Só você consegue fazer isso.
3. **Runner para IA.** Exige um runner self-hosted com acesso ao Ollama ou ao 9Router, ou então a IA fica só local.

## 3. Plano por fase

Cada fase fecha com testes, lint e a verificação de cobertura de linhas novas (gate de 90%).
Fases 1 e 2 são pré-requisito da 3.

### Fase 1: histórico do projeto (base de tudo)

- Criar `scripts/history.cjs`: um snapshot por execução com data, commit, cobertura (de `scripts/baseline.json`), resultado dos checks de `origin/main`, contagem de alertas de code scanning e de Dependabot.
- Reutilizar `appendHistory` / `readHistory` do `fleet-github.cjs` (mover para `scripts/lib/history.cjs`).
- Workflow agendado (`cron` diário) que escreve no branch `qg-metrics`. Sem escrita em `main`.
- Testes: formato do snapshot, leitura com linhas corrompidas (ignorar, não quebrar), acumulação sem duplicar o mesmo commit.
- **Critério de pronto:** após 7 dias de execuções, o `qg-metrics` tem 7 linhas por projeto, e `history.cjs --summary` mostra a tendência real.

### Fase 2: análise profunda (Semgrep e CodeQL no painel)

- Ler alertas de code scanning por `gh api repos/<repo>/code-scanning/alerts?state=open`, separados por ferramenta (`tool.name`), severidade e regra.
- Mostrar: abertos, novos desde o último snapshot, fechados, e os 10 mais antigos.
- Não bloqueia nada. Só visibilidade, para não criar um segundo gate.
- Dependabot: mesma seção, já com o `countAlerts` existente.
- Testes com respostas fixas de `gh api` (sem rede), inclusive paginação e alerta sem severidade.
- **Critério de pronto:** o painel mostra a contagem por ferramenta, batendo com a aba Security do GitHub.

### Fase 3: painel com tendência

- Gráficos em SVG inline gerados por `dashboard-publish.cjs`: cobertura ao longo do tempo, alertas abertos por ferramenta, status dos checks por dia. Sem CDN, para funcionar offline e no Pages.
- Antes de desenhar, aplicar a paleta e as regras da skill `dataviz` (cores de série, contraste claro e escuro).
- Seções: Histórico, Análise (Semgrep/CodeQL/Dependabot), Checks atuais. A TUI usa a mesma coleta.
- **Atenção:** eu não verifiquei visualmente o HTML no navegador. Cada entrega visual precisa de captura de tela ou de um teste de estrutura antes de ser dada como pronta.
- **Critério de pronto:** a página publicada mostra série temporal real, e a estrutura HTML fecha (divs e tags balanceadas).

### Fase 4: revisão com IA, advisory, fora do caminho crítico

- Manter `ai-review.yml` sem `pull_request`. Adicionar um rótulo opt-in (`ai-review`) que dispara o job em runner self-hosted.
- Saída como comentário único, só com `--post`. Nunca required check.
- Antes de ampliar, medir a utilidade: o `docs/MODELO-LOCAL.md` já registra que o modelo local é fraco em detecção de flaky. Só expandir se a taxa de achados úteis for medida, não estimada.
- **Critério de pronto:** em 10 PRs com o rótulo, a proporção de comentários que alguém marca como útil está registrada.

### Fase 5: Socket (piloto antes de decidir)

- Piloto em um repositório de teste, com o app instalado por você.
- Ler o resultado pela API do Socket só se houver token, sempre como job advisory.
- Decidir depois de ver falsos positivos reais. Sem bloqueio no piloto.
- **Critério de pronto:** relatório de 2 semanas no repositório de teste com achados classificados.

### Fase 6: CLI (`qg`)

- Adicionar `--json` em cada comando, para o painel e a CI consumirem o mesmo dado.
- `qg status`: resumo que combina checks, alertas e cobertura atual.
- Saída com cor só quando a saída é TTY e `NO_COLOR` não está definido.
- Testes: `--json` é JSON válido, `NO_COLOR` remove escapes, `qg status` sem rede falha de forma explícita.
- **Critério de pronto:** `qg status --json | jq` funciona em um repositório real.

## 4. Ordem recomendada e o que não fazer

Ordem: **1 → 2 → 3 → 6**, depois **4** e **5** em paralelo, porque não dependem do painel.

Não fazer agora:

- Não tornar o Socket, nem a IA, em required check. Isso criaria dependência de um serviço externo para o merge.
- Não ampliar o histórico para dados de pessoas ou de repositórios que não são do projeto.
- Não criar um segundo painel para a frota. A frota continua fora do repositório público.

## 5. Próximo passo sugerido

Você decide os três itens da seção 2. Com a decisão 2.1, a Fase 1 começa imediatamente.
Não criei o artefato de design (`/design`) desta rodada: a parte visual entra na Fase 3, depois que os dados existirem.
