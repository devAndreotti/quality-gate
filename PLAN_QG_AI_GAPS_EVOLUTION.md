# Plano & Especificação Técnica: Evolução do Quality Gate (AI Gaps & Extensões 2026)

**Data:** 28 de Outubro de 2026  
**Status:** Proposto / Especificação Pronta para Implementação  
**Escopo:** `devAndreotti/quality-gate`  
**Filosofia:** *Akita Way* — Determinismo mecânico em CPU pura (custo $0) na base; inferência de IA sob demanda nas exceções arquiteturais.

---

## 1. Contexto & Diagnóstico Atual

O `devAndreotti/quality-gate` atingiu maturidade operacional v1.0.0 com:
- Validação multi-stack (Node.js e Python/uv, além de Go e Rust detectados).
- Ratchet matemático upward-only imutável (`quality-gate.js`).
- Auditoria de licenças (`license-audit.cjs`), convenção de commits (`commit-lint.cjs`), segredos (`secret-scan.cjs`) e contêineres (`docker-gate.cjs`).
- Validação unificada local (`local-validate.cjs`) e perfil `company` sem footprint.
- TUI rica empacotada em bundle único standalone via React 19 + Ink 7 (`menu-tui.mjs`, `dashboard-tui.mjs`).
- Gestão determinística de ciclo de vida de PRs (`pr-snapshot.cjs`, `babysit-loop.cjs`, `ci-diagnose.cjs`).

A auditoria recente contra as plataformas líderes de mercado em 2025/2026 (**Greptile, CodeRabbit, Qodo, Augment Code, Harness AI Evals**) confirmou uma nota ponderada de **8.0 / 10**.

O Quality Gate se destaca em determinismo, custo ($0/mês), velocidade e ausência de vendor lock-in. Contudo, possui quatro gaps em comparação ao estado da arte de IA, além de quatro oportunidades para ecossistemas modernos (como *Memory Apartment*, *Tower* e *Frosted Folio*).

---

## 2. Matriz dos Gaps: O que são e o que fazem

### GAP 1: Grafo Semântico Full-Codebase (Cross-File Call Graph)

* **O que é:** Análise estática profunda que constrói o grafo de dependências, tipos e referências de chamadas de todo o repositório, em vez de avaliar apenas as linhas alteradas no `git diff`.
* **O que faz:**
  - Detecta se a renomeação ou alteração de assinatura de uma função quebrou chamadores em arquivos distantes que não foram tocados no PR.
  - Alerta sobre quebra de contratos de API, divergência de tipos e efeitos colaterais silenciosos.
* **Abordagem no Quality Gate (Zero-Cloud):**
  - Ferramentas como Greptile mantêm bases vetoriais remotas pesadas. No nosso paradigma, implementaremos o **`scripts/ast-graph.cjs`**: utiliza parsers sintáticos locais nativos (AST via `oxc-parser` ou `tree-sitter` / `typescript` compiler API) para extrair símbolos exportados/importados e verificar quebras de referências de forma 100% determinística em <2 segundos.

---

### GAP 2: Inline PR Reviewer & Automated Code Suggestions

* **O que é:** Capacidade de comentar diretamente nas linhas específicas do diff de um Pull Request no GitHub com blocos interativos de sugestão de código (`suggestion`), prontos para merge em um clique.
* **O que faz:**
  - Em vez de apenas emitir um *sticky comment* geral com tabelas agregadas, inspeciona achados de linters, SonarJS e regressões lógicas, mapeando o número exato do arquivo e da linha no diff unificado.
  - Gera comentários contextuais nas linhas afetadas e permite que o desenvolvedor aplique a correção direto pela interface do GitHub.
* **Abordagem no Quality Gate:**
  - Módulo **`scripts/pr-inline-suggest.cjs`**: lê o relatório do linter/doctor (`coverage/eslint-report.json`, achados do `secret-scan` ou falhas do ratchet) e o diff da PR via GitHub API GraphQL/REST, convertendo posições de arquivo em comentários de review com thread ativa.

---

### GAP 3: AI Evals Gate em CI/CD (Gating para Prompts e Agentes)

* **O que é:** Um portão de bloqueio em CI para sistemas que consom Inteligência Artificial (prompts de sistema, agentes autônomos, skills Codex/Hermes, fluxos RAG).
* **O que faz:**
  - Quando um prompt, template ou skill é modificado, executa um *golden dataset* (bateria de casos conhecidos de entrada/saída).
  - Mede métricas formais: fidelidade (*faithfulness*), conformidade de schema JSON, precisão de tool calls, ausência de alucinações e limites de custo/latência.
  - Bloqueia o merge se a pontuação média ou pass-rate cair abaixo do baseline estipulado.
* **Abordagem no Quality Gate:**
  - Módulo **`scripts/ai-evals-gate.cjs`**: lê casos em `.quality-gate/evals/golden-dataset.json`, executa contra um modelo configurado (local ou API) com budget controlado de tokens e calcula a taxa de acerto com suporte a ratchet upward-only.

---

### GAP 4: Multi-Repo Fleet Governance (`qg-fleet`)

* **O que é:** Painel e orquestrador para gerenciar e auditar as políticas de qualidade em dezenas de repositórios simultaneamente.
* **O que faz:**
  - Audita a frota de projetos do usuário (`frosted-motion-folio-v2`, `tower`, `memory-apartment`, repositórios OneMob).
  - Exibe quais repositórios possuem políticas desatualizadas, baselines defasados, hooks ausentes ou branches de CI sem proteção.
  - Aplica atualizações e sincronizações de workflows em lote via comando único.
* **Abordagem no Quality Gate:**
  - CLI **`scripts/fleet.cjs`** / `qg-fleet`: lê um catálogo `.quality-gate/fleet.json` (ou lista de diretórios) e gera matriz de saúde comparativa no terminal via TUI.

---

## 3. Extensões Recomendadas de Alto Impacto ("O que mais adicionar?")

Para elevar o `quality-gate` ao patamar de infraestrutura de elite para engenharia real, as 4 capacidades a seguir completam o ecossistema:

### ADIÇÃO 1: Diff Coverage Ratchet Gate (100% Cobertura em Código Novo)
* **O que é:** Exigência de que todo código *novo* introduzido no PR atinja uma meta estrita de cobertura (ex: $\ge 90\%$ ou $100\%$), independentemente da cobertura histórica total do projeto.
* **O que faz:** O projeto já possui a biblioteca `scripts/lib/diff-coverage.cjs`. Falta integrar esse cálculo ao job de CI do workflow `quality-gate.yml`, impedindo merges de PRs que adicionem linhas executáveis sem testes correspondentes.

### ADIÇÃO 2: Architecture Boundary Enforcement (Fronteiras em Camadas)
* **O que é:** Validador de fronteiras modulares (Clean Architecture / Hexagonal / Monorepo Isolation).
* **O que faz:** Impede violações de importação em tempo de compilação/teste:
  - Domínio (`src/domain/`) não pode importar Infraestrutura (`src/infra/`).
  - Módulos públicos não podem importar arquivos internos de outros pacotes.
  - Zero dependências externas em runtime; executa via parser estático de imports regex/AST.

### ADIÇÃO 3: Performance & Bundle Size Budget Ratchet
* **O que é:** Gate de orçamento de tamanho de arquivos compilados e performance web.
* **O que faz:**
  - Fundamental para aplicações Web e jogos WebGL/Canvas (ex: *Memory Apartment* e *Frosted Folio*).
  - Mede o peso dos artefatos em `dist/` (JavaScript gzip, WebP, shaders) e bloqueia PRs que aumentem o bundle acima de um percentual fixado (ex: +5%).
  - Integração com Lighthouse CI headless para garantir índices mínimos de Core Web Vitals (LCP, TBT, CLS).

### ADIÇÃO 4: Local AI Router para PR Reviews Privados (Zero-Cloud)
* **O que é:** Conector para executar revisões semânticas de código usando LLMs locais ou roteadores privados (9Router, Hermes local, Ollama, LM Studio).
* **O que faz:**
  - Permite revisão inteligente profunda de código em repositórios confidenciais de empresas (ex: OneMob) sem enviar uma única linha de código para provedores públicos de nuvem e com custo financeiro zero.

---

## 4. Especificação dos Componentes Técnicos

```
.quality-gate/
├── policy.json                # Expandido: seções astGraph, diffCoverage, bundleBudget, aiEvals
├── policy.schema.json         # Schemas estritos para as novas chaves
├── fleet.json                 # Catálogo de repositórios gerenciados
└── evals/
    └── golden-dataset.json    # Casos de teste para agentes/prompts

scripts/
├── ast-graph.cjs              # GAP 1: Validador de grafo semântico e referências cruzadas
├── pr-inline-suggest.cjs      # GAP 2: Publicador de sugestões inline de PR
├── ai-evals-gate.cjs          # GAP 3: Executor de evals de IA com ratchet
├── fleet.cjs                  # GAP 4: Auditor e sincronizador de frota multi-repo
├── bundle-budget.cjs          # ADIÇÃO 3: Verificador de orçamento de bundle
└── lib/
    ├── ast-parser.cjs         # Extrator de símbolos (import/export/call)
    ├── boundary-rules.cjs     # Motor de regras arquiteturais de import
    └── local-ai-client.cjs    # Cliente HTTP para 9Router / Hermes / Ollama
```

### 4.1 Schema de Configuração em `policy.json`

```json
{
  "$schema": "./policy.schema.json",
  "profile": "strict-node",
  "requiredChecks": [
    "Security audit",
    "Lint",
    "Tests & ratchet",
    "Diff coverage",
    "Architecture boundary",
    "Docker image gate"
  ],
  "coverageRatchet": true,
  "diffCoverage": {
    "enabled": true,
    "minPercentage": 90.0,
    "blockOnFailure": true
  },
  "architectureBoundary": {
    "enabled": true,
    "rules": [
      {
        "from": "src/domain/**",
        "disallow": ["src/infra/**", "src/controllers/**"]
      }
    ]
  },
  "bundleBudget": {
    "enabled": false,
    "paths": ["dist/**/*.js"],
    "maxGzipKb": 150,
    "maxTotalKb": 500
  },
  "aiEvals": {
    "enabled": false,
    "dataset": ".quality-gate/evals/golden-dataset.json",
    "minScore": 0.85
  }
}
```

---

## 5. Roteiro de Implementação em Fatias (PRs Independentes)

| Fase | Fatia / PR | Foco Técnico | Complexidade |
| :---: | :--- | :--- | :---: |
| **Fase 1** | `feat(diff-coverage): CI gating obrigatório para novas linhas` | Ativar `scripts/lib/diff-coverage.cjs` no workflow de CI para bloquear PRs sem teste em adições. | Baixa |
| **Fase 2** | `feat(boundary): validador estático de arquitetura e imports` | Criar `scripts/boundary-gate.cjs` e schema em `policy.json` para bloquear imports proibidos. | Média |
| **Fase 3** | `feat(ast-graph): detecção de chamadas quebradas cross-file` | Parser AST local (Tree-sitter/oxc) para mapeamento de dependências e exports/imports. | Média |
| **Fase 4** | `feat(fleet): gerenciamento e auditoria multi-repositório` | Utilitário `scripts/fleet.cjs` para varrer e sincronizar múltiplos projetos da máquina. | Média |
| **Fase 5** | `feat(inline-review): sugestões contextuais no diff do GitHub` | Integração via GitHub GraphQL/REST para comentários inline com blocos `suggestion`. | Alta |
| **Fase 6** | `feat(ai-evals): gate determinístico para agentes e prompts` | Motor de evals com golden datasets para projetos de IA/agentes em CI. | Alta |
| **Fase 7** | `feat(bundle-budget): gate de peso de bundle e assets web` | Auditoria de tamanho de dist/chunks com ratchet anti-bloat. | Baixa |
