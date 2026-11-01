# Uso de modelo local no Quality Gate

O projeto aceita um modelo de linguagem local, mas só para duas coisas, e nenhuma delas bloqueia o merge hoje.

## Onde é usado

1. **Revisão de PR (`scripts/pr-ai-review.cjs`, workflow `ai-review.yml`)**
   - Lê o diff do PR, pede achados de bug, segurança e regressão de teste ao modelo, e mantém só os que apontam para linhas adicionadas.
   - Dry-run por padrão. `--post` posta comentários inline e exige `--pr`, `GITHUB_TOKEN` e o flag explícito.
   - Roda só sob demanda (`workflow_dispatch`), nunca em `pull_request`.
   - Precisa de um runner self-hosted com acesso ao provedor. Em runner hospedado pelo GitHub, sai como `skipped`.
   - Advisory: pode errar, e cada achado deve ser verificado.

2. **Gate de evals de IA (`scripts/ai-evals-gate.cjs`)**
   - Testa prompts e agentes contra um conjunto de casos fixo (`.quality-gate/evals/golden-dataset.json`) e bloqueia se a taxa de acerto ficar abaixo de `minScore`.
   - Desligado em `policy.json`. Sem provedor, sai como `skipped`, nunca como falha.

## Provedores

- **Ollama:** `QG_OLLAMA_URL` (padrão `http://localhost:11434`).
- **9Router:** `QG_9ROUTER_URL` (sem padrão).
- Modelo: `QG_AI_MODEL`, sempre vindo da lista do próprio provedor.

Nenhum dado é enviado a serviço externo. O código recusa provedores fora desses dois.

## O que foi medido

Tudo abaixo foi rodado com os modelos locais disponíveis, e os conjuntos são pequenos.

- **Revisão de PR:** funcionou ponta a ponta com `qwen2.5:7b` (achado em linha adicionada mantido, achado em linha inexistente descartado). Teve um achado inventado, e o resultado não é o mesmo entre execuções.
- **Triagem de falha de CI** (conjunto de 233 falhas rotuladas, a maioria automaticamente): o 7B acertou 53% no conjunto completo e 76% nos repos públicos. Acerta bem "real", mas quase não identifica flaky.
- **Flaky** (14 casos, 4 deles de experimento controlado): o 7B pegou 3 de 14, com precisão de 100% nesses 3. O baseline de sempre dizer "não flaky" acerta 63%, e o 7B ficou em 68%.
- **Evidência obrigatória** (pedir ao modelo a linha do log que comprova a causa): piorou o resultado, de 53% para 36%.

## Conclusão

Use o modelo local para revisão de PR como sugestão, manualmente, em runner próprio. Não use para decidir flaky nem para bloquear merge. Para classificação de falha, uma regra determinística (timeout explícito, `cancelled`, erro de rede no log) funciona melhor do que o modelo, e o modelo serve no máximo para explicar a causa.

Modelos testados: `qwen2.5:7b`, `qwen2.5:3b`, `qwen2.5-coder:3b` (retornou lista vazia em revisão de código com bugs plantados) e `qwen2.5:14b` (no Kaggle, 62% no subconjunto público, sem melhora sobre o 7B).
