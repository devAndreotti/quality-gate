# Ground truth da amostra 1 (quality-gate, seed 1, n=10)

Registrado ANTES de rodar qualquer ferramenta concorrente. Não editar depois de ver resultados; mudanças viram nova versão datada.

- Data do registro: 2026-11-04
- Avaliador: Claude (agente desta sessão). **Viés declarado:** eu escrevi a maioria destes PRs e conheço a intenção de cada um. Isso favorece a leitura de "não é problema". A concordância com um avaliador humano não foi medida.
- Método: leitura do diff completo para PRs pequenos e médios (26, 80, 61, 29, 22, 38, 31, 66). Para os grandes (21 e 42), revisão parcial: busca por padrões de risco (exec/eval/shell, caminhos vindos de argv, segredos, permissões, pull_request_target). **Os achados de 21 e 42 têm confiança baixa.**
- Critério: "real" = defeito ou risco que eu consigo demonstrar no diff. "não_real" = nada demonstrável no diff. "incerto" = não consigo decidir sem executar.

| PR | Estrato | Problemas reais no diff | Classificação | Observação |
|---|---|---|---|---|
| 26 | vermelho | 0 | não_real | include em diff-coverage; sem defeito demonstrado |
| 21 | vermelho | 0 demonstrados | incerto | diff de 4318 linhas, revisão parcial |
| 66 | vermelho | 1 | real | workflow de IA original passava QG_AI_API_KEY (secret de repo) a um job disparável em qualquer branch, sem environment; risco latente, corrigido no PR 78 |
| 80 | vermelho | 0 | não_real | histórico; sem defeito demonstrado |
| 61 | vermelho | 0 | não_real | Semgrep advisory com versão fixa e sem telemetria |
| 22 | verde | 0 | não_real | sugestões inline com validação de entrada |
| 29 | verde | 0 demonstrados | não_real | secret-scan; sem defeito demonstrado |
| 38 | verde | 0 | não_real | commit-lint, pr-size e SBOM |
| 42 | verde | 0 demonstrados | incerto | diff de 7840 linhas, revisão parcial |
| 31 | verde | 0 | não_real | lint e Sonar |

## Consequência para o protocolo

- **Só 1 de 10 PRs tem problema real demonstrável.** Com ground truth assim, a revocação de qualquer ferramenta fica medida sobre um único achado, o que não serve para comparar.
- **O estrato "vermelho" não garante defeito real.** Seis dos cinco vermelhos não têm defeito no diff (o CI ficou vermelho por outros motivos: testes, cobertura, lint). Logo o critério de amostragem não mede o que o protocolo quer medir.
- **Ação necessária antes de comparar ferramentas:** trocar a fonte da ground truth. Opções: (a) semear defeitos conhecidos em PRs de teste e medir se a ferramenta os pega (mede revocação de forma direta); (b) usar PRs de incidentes reais anotados, se houver histórico de bugs que escaparam; (c) aceitar que a medição é só de ruído, e não de revocação.
