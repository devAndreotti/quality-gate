# Plano de implementação — gaps de IA e extensões do Quality Gate

**Data:** 2026-10-28
**Base:** `PLAN_QG_AI_GAPS_EVOLUTION.md` (spec, PR #15)
**Filosofia:** Akita Way — determinismo em CPU na base (custo $0); IA só nas exceções arquiteturais, sempre opt-in.

Este plano transforma as 7 fases da spec em fatias pequenas, cada uma em PR independente, com critério de aceite verificável. Nada aqui foi implementado ainda.

---

## 0. Pré-requisitos (antes da Fase 1)

1. **Alinhar o schema de `policy.json`.** A spec (seção 4.1) põe `requiredChecks`, `diffCoverage` e `architectureBoundary` no topo. O formato real do projeto usa `ci.requiredChecks`, `ci.advisoryChecks` e `ci.coverageRatchet` (ver `.quality-gate/policy.json`). Novas chaves devem seguir o mesmo padrão: `ci.diffCoverage`, `ci.architectureBoundary`, `ci.bundleBudget`, `ci.aiEvals`. Atualizar a seção 4.1 da spec antes de codar.
2. **Atualizar `policy.schema.json`** com as chaves novas, todas `enabled: false` por padrão. Isso mantém o comportamento atual para repos que não usam os recursos.
3. **Decisões tomadas:**
   - **Parser AST (Fase 3): `oxc-parser`**, versão exata fixada. Motivo: parse rápido (necessário para a meta de <2s em repos grandes) e cobre JS, TS e JSX. Descartados: `typescript` (pesado, ~20 MB, mais lento) e tree-sitter (binários nativos por plataforma, mais superfície). É a única dependência de runtime nova do plano. Carregamento lazy: se o pacote não estiver instalado, o gate reporta `skipped` com instrução de instalação, nunca `failed`. Antes de fixar a versão, conferir que ela tem pelo menos 2 semanas de idade.
   - **Provedores de IA (Fase 6): 9Router e Ollama, ambos locais.** Ordem padrão: 9Router (`http://127.0.0.1:20128/v1`, API compatível com OpenAI), depois Ollama (`http://localhost:11434`, endpoint compatível em `/v1`). Nenhum provedor de nuvem neste plano. Se nenhum estiver no ar, o gate fica `skipped`.
   - **Catálogo da Fase 4:** `.quality-gate/fleet.json` local, fora do git. Só `fleet.example.json` é versionado.

## 1. Regras transversais

- Cada fase: testes em `scripts/*.test.cjs` no padrão `node --test`, sem dependência nova de runtime salvo decisão registrada.
- Cada gate novo nasce em modo **advisory** (não bloqueia) e só vira `requiredChecks` depois de uma rodada verde em um repo real.
- Ratchet upward-only onde houver métrica (diff coverage, bundle, evals): o baseline só sobe, nunca desce; atualização via `update`, nunca manual.
- Sem segredos e sem fixtures isentas do `secret-scan` (ver `gotchas/secret-scan-test-fixtures.md`).
- Cada PR tem Co-Authored-By do agente quando feito por IA, e a descrição segue o template do repo.

## 2. Ordem de execução

A ordem prioriza valor com risco baixo. Fases 1 e 7 reaproveitam código ou são simples; 3, 5 e 6 exigem decisões.

| Ordem | Fase | Complexidade | Depende de |
| :---: | --- | :---: | --- |
| 1 | Fase 1 — Diff coverage no CI | Baixa | pré-requisitos 0.1 e 0.2 |
| 2 | Fase 7 — Bundle budget | Baixa | 0.1 e 0.2 |
| 3 | Fase 2 — Architecture boundary | Média | 0.1 e 0.2 |
| 4 | Fase 4 — Fleet governance | Média | catálogo local (0.3) |
| 5 | Fase 3 — AST graph cross-file | Média | decisão de parser (0.3) |
| 6 | Fase 5 — Inline suggestions | Alta | Fase 3 (para achados precisos) |
| 7 | Fase 6 — AI evals gate | Alta | decisão de provedor (0.3) |

## 3. Fases

### Fase 1 — `feat(diff-coverage): CI gating obrigatório para novas linhas`

- **Estado atual:** `scripts/lib/diff-coverage.cjs` já existe no `main` e exporta `calculateDiffCoverage`, `parseDiffLineNumbers` e `parseLcovCoverageMap`. Falta ligá-lo ao CI.
- **Mudanças:**
  - Novo passo no job `test` de `.github/workflows/quality-gate.yml`, depois de "Ratchet", que roda o cálculo sobre o diff do PR contra a cobertura gerada.
  - Chave `ci.diffCoverage` (`enabled`, `minPercentage: 90`, `blockOnFailure`) em `policy.json` e schema.
  - Cobertura precisa estar em LCOV para o parser; confirmar o formato que o job já gera antes de codar.
- **Testes:** casos com linhas novas cobertas, descobertas, mistas e diff vazio; caso de cobertura ausente deve falhar com mensagem clara (não passar em silêncio).
- **Aceite:** PR que adiciona código sem teste fica vermelho; PR com teste passa; `enabled: false` mantém o comportamento atual.
- **Risco:** o hint atual de `quality-gate.js check` aponta para `npm run test:coverage:ci`, que não existe. Corrigir esse hint junto, para não confundir quem roda o gate.

### Fase 7 — `feat(bundle-budget): gate de peso de bundle e assets web`

- **Mudanças:** novo `scripts/bundle-budget.cjs` que mede `dist/**/*.js` em gzip e no total, compara com `ci.bundleBudget` (`maxGzipKb`, `maxTotalKb`, aumento máximo em %) e atualiza baseline via ratchet.
- **Testes:** medição determinística com fixtures geradas em runtime (sem arquivos binários no repo); aumento acima do limite falha; redução atualiza baseline.
- **Aceite:** `enabled: false` é no-op; com `enabled: true`, aumento de bundle acima do limite bloqueia.
- **Fora de escopo nesta fase:** Lighthouse CI. Fica como fatia separada, se for pedida.

### Fase 2 — `feat(boundary): validador estático de arquitetura e imports`

- **Mudanças:** `scripts/boundary-gate.cjs` e `scripts/lib/boundary-rules.cjs`. Regras em `ci.architectureBoundary.rules` (`from` / `disallow`, com glob).
- **Implementação:** extrator de imports com regex para `import`, `require` e `from`, sem dependência nova. Se a precisão do regex não bastar, a Fase 3 traz o AST e esta fase migra para ele.
- **Testes:** import proibido falha; import permitido passa; import dinâmico e `require` são detectados; `..` relativo é resolvido antes de comparar.
- **Aceite:** a regra de exemplo da spec (`src/domain/**` não importa `src/infra/**`) é reproduzível em um fixture de teste gerado em runtime.

### Fase 4 — `feat(fleet): gerenciamento e auditoria multi-repositório`

- **Mudanças:** `scripts/fleet.cjs` (CLI `qg-fleet`) lê `.quality-gate/fleet.json` (caminhos locais) e, para cada repo, verifica: `policy.json` presente, baseline do ratchet, hooks instalados, workflow de CI presente. Saída em tabela de saúde.
- **Regra de privacidade:** o `fleet.json` real não é versionado (entrar em `.gitignore` do repo que o contém). O repo versiona só `fleet.example.json`.
- **Testes:** catálogo com repos sintéticos gerados em tmpdir; repo sem policy aparece como "não gerenciado"; saída é determinística (ordem estável).
- **Aceite:** comando lista a frota e aponta pelo menos uma inconsistência em um repo de teste.
- **Fora de escopo:** aplicar mudanças em lote. Primeiro só auditoria; sincronização em lote vira fatia própria, com `--dry-run` obrigatório.

### Fase 3 — `feat(ast-graph): detecção de chamadas quebradas cross-file`

- **Mudanças:** `scripts/ast-graph.cjs` e `scripts/lib/ast-parser.cjs` (extração de exports, imports e chamadas) usando `oxc-parser` (decisão 0.3), carregado com `require` dentro de try/catch.
- **Escopo inicial:** JS/TS apenas. Python fica para fatia posterior.
- **Testes:** renomear uma função exportada sem atualizar um chamador em outro arquivo deve ser detectado; re-export e import com alias são cobertos; arquivo que não parseia gera aviso, não crash.
- **Aceite:** em um repo de teste com quebra cross-file, o gate aponta o chamador não tocado pelo diff. Medir tempo de execução e registrar; a meta de <2s é a verificar aqui.

### Fase 5 — `feat(inline-review): sugestões contextuais no diff do GitHub`

- **Mudanças:** `scripts/pr-inline-suggest.cjs`. Lê achados (secret-scan, lint, ratchet, boundary) e publica review comments com bloco `suggestion` quando há correção mecânica segura.
- **Regras:** só sugerir quando a correção é mecânica e local (ex.: formatação, import não usado). Achados sem correção segura viram comentário sem `suggestion`.
- **Permissões:** o job precisa de `pull-requests: write`. Documentar o escopo mínimo no workflow.
- **Testes:** mapeamento de linha do achado para posição no diff unificado (usar `parseDiffLineNumbers`); idempotência (não postar duplicado em re-run); modo `--dry-run` que só imprime o que postaria.
- **Aceite:** em PR de teste, um achado de lint aparece como comentário inline com sugestão aplicável; re-run não duplica.

### Fase 6 — `feat(ai-evals): gate determinístico para agentes e prompts`

- **Mudanças:** `scripts/ai-evals-gate.cjs`, `scripts/lib/local-ai-client.cjs` e `.quality-gate/evals/golden-dataset.json`. Dispara só quando arquivos de prompt, skill ou agente mudam.
- **Cliente:** `local-ai-client.cjs` fala o protocolo compatível com OpenAI (`/v1/chat/completions`) e tenta 9Router primeiro, depois Ollama. Host e modelo vêm de `ci.aiEvals.providers` no `policy.json`, com esses valores como padrão.
- **Determinismo:** métricas que não dependem de juiz de IA primeiro (conformidade de schema JSON, presença de campos, limites de custo/latência). Métrica por LLM-as-judge fica para depois e é opt-in.
- **Ratchet:** pass-rate e score mínimo (`ci.aiEvals.minScore`) só sobem.
- **Testes:** dataset sintético com provedor falso (stub), sem chamada de rede nos testes; orçamento de tokens respeitado; ausência de provedor configurado gera "skipped", não "passed".
- **Aceite:** mudança em prompt sem atualizar o baseline falha; sem provedor, o gate fica como skipped e não bloqueia.

## 4. Critérios gerais de conclusão

- Todos os testes passam (`node --test scripts/*.test.cjs`), com a contagem registrada na memória do projeto.
- `node scripts/secret-scan.cjs --all` passa sem exceções por nome de arquivo.
- `node scripts/local-validate.cjs --profile pr` passa, ou falha por motivo explicado e fora da fatia.
- Cada gate novo tem documentação em `README.md` e exemplo em `policy.json` com `enabled: false`.

## 5. Riscos

- **Regressão no CI:** gates novos entram como advisory; promover a required só depois de rodada verde.
- **Falso positivo do boundary/AST:** começar com regras explícitas e conservadoras; ampliar com casos reais.
- **Custo e privacidade na Fase 6:** provedor local por padrão; nada de código sai do repo sem opt-in por repo.
- **Escopo:** cada fase é um PR. Se uma fase crescer, dividir antes de codar.
