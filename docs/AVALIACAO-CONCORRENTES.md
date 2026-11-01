# Avaliação do Quality Gate contra concorrentes

Esta avaliação combina o que o código faz (verificado no repo) com a pesquisa de out/2026 sobre concorrentes. O que está como "não verificado" não foi confirmado em fonte oficial.

## Nota geral

O Quality Gate está forte em bloqueio local e determinístico, sem lock-in, e fraco em visibilidade, histórico e triagem assistida. Para um projeto pessoal ou de time pequeno que quer controle, é uma escolha defensável. Para um time que quer painel e histórico sem manutenção, ainda perde para SaaS maduros.

A nota de 22,5/25 registrada antes foi autoavaliação por capacidade. Ela não é objetiva, e não deve ser comparada com nota de outras ferramentas.

## Comparação

Legenda: **sim**, **parcial**, **não**, **nv** (não verificado).

| Capacidade | Quality Gate | SonarCloud | Codacy | Codecov | Qlty | Semgrep | Socket |
|---|---|---|---|---|---|---|---|
| Ratchet de cobertura (só sobe) | sim | nv | nv | não (target auto) | parcial | não | não |
| Cobertura das linhas novas bloqueante | sim | parcial (new code) | parcial | parcial (patch, status check) | sim (no Free) | não | não |
| Segredos no histórico git | sim | nv | parcial | não | sim (Free) | não (secrets é add-on) | não |
| SAST com regras próprias | parcial (3 regras, advisory) | sim | sim | não | sim | sim | não |
| Análise de pacotes (install scripts, autor novo) | parcial (install-scripts, lockfile) | não | nv | não | não | não | sim |
| SBOM | sim | nv | parcial | não | não | não | parcial |
| Proveniência SLSA | sim | não | nv | não | não | não | não |
| Scorecard | sim | não | nv | não | não | não | não |
| Hooks locais | sim (opt-in) | não | não | não | sim | não | não |
| Roda sem conta nem SaaS | sim | não | não | não | parcial (CLI local, análise na nuvem) | parcial (CLI local; `semgrep ci` exige conta) | não |
| Painel e histórico | parcial (estado atual, sem histórico) | sim | sim | sim | parcial | sim | sim |
| Revisão de PR com IA | parcial (local, manual, advisory) | não | sim | não | sim (nuvem) | parcial | não |
| Mutation testing | parcial (piloto) | não | não | não | não | não | não |
| Gerenciamento de fila (merge queue) | não | não | não | não | não | não | não |
| Flaky com quarentena | parcial (advisory, semanal) | não | não | não | não | não | não |
| Bootstrap de proteção de branch | sim | não | não | não | não | não | não |
| Frota multi-repo | sim (leitura) | não | não | não | não | não | não |

Para SonarCloud, Codacy, Codecov, Qlty, Semgrep e Socket, as células vêm da pesquisa de out/2026. Várias delas são "nv" porque a fonte oficial não confirmou o plano gratuito para repo público. Não trate uma célula nv como "não existe".

## Onde o Quality Gate ganha

- **Controle local e sem lock-in:** o bloqueio roda sem conta, sem token e sem internet. Nenhum concorrente da tabela oferece isso para o gate bloqueante.
- **Ratchet explícito e diff coverage bloqueante:** cobertura que só sobe, e um teto para o que o PR adiciona.
- **Escopo amplo no mesmo lugar:** segredos no histórico, SLSA, Scorecard, SBOM e Dependency Review num único conjunto.
- **Bootstrap e frota:** configura a proteção de branch e audita vários repos, o que nenhum concorrente da lista faz.

## Onde perde

- **Painel e histórico:** o dashboard mostra só o estado atual. SonarCloud, Codacy e Codecov mostram tendência e o time vê a evolução sem esforço.
- **Análise profunda:** Semgrep e CodeQL fazem fluxo de dados mais profundo do que as três regras próprias do Quality Gate. Hoje só o CodeQL cobre isso como bloqueante.
- **Revisão com IA:** Codacy, CodeRabbit e Qlty entregam revisão contínua e integrada. O Quality Gate tem uma versão local, manual e advisory.
- **Pacotes maliciosos:** Socket cobre comportamento de pacote. O Quality Gate só avisa sobre install scripts e lista dependências novas.
- **Manutenção:** o projeto tem muitas partes, e algumas estão em advisory ou desligadas por padrão. Um time precisa de documentação e de dono, o que não existe ainda.

## O que faria para subir a nota

1. **Histórico de métricas:** guardar o resultado de cada run (cobertura, achados, tempo) num arquivo versionado ou numa branch de métricas, e mostrar tendência no dashboard.
2. **Painel com o resultado de todas as checagens:** já foi feito nesta rodada para o `main`, mas só mostra o último commit.
3. **Decidir o que é obrigatório:** Semgrep e flaky estão advisory. Vale definir quais viram bloqueantes após alguns dias estáveis.
4. **Consolidar a configuração:** hoje há vários arquivos de política e de workflow. Um único ponto de configuração diminui erro.
5. **Ajustar o modelo local:** só entra como sugestão. Não vale investir em triagem automática enquanto flaky não for medido com um conjunto maior.

## O que não copiar

- Dependência de SaaS no gate bloqueante (perde a propriedade principal).
- Pontuação agregada sem critério (o SonarCloud e o Codacy usam nota; o Quality Gate usa limites explícitos, que é mais honesto).
- Revisão de IA como bloqueio (falso positivo é esperado).

## Fontes

As fontes da pesquisa de out/2026 estão nos relatórios desta sessão. Para cada concorrente, as páginas oficiais de preço e de funcionalidades devem ser conferidas antes de decidir.
