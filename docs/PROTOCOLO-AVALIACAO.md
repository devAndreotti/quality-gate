# Protocolo de avaliação de ferramentas de qualidade

Objetivo: comparar ferramentas (Quality Gate, SonarCloud, Codacy, Semgrep, Socket etc.) pelo que elas **encontram em PRs reais**, não pela lista de funcionalidades. Nota de funcionalidade mede o que a ferramenta promete. Este protocolo mede o que ela entrega.

## 1. Amostra

- Gerar com `node scripts/eval-sample.cjs --repo <dono/repo> --size 10 --seed 1 --out <arquivo>`.
- A amostra é **estratificada**: metade dos PRs teve check vermelho no merge original, metade foi verde. Sem o estrato vermelho, a ferramenta "ganha" por ficar quieta em PR limpo.
- Semente fixa (`--seed`) e registrada no relatório, para que outra pessoa gere a mesma amostra.
- Tamanho mínimo: 10 PRs, com pelo menos 4 vermelhos. Abaixo disso, não comparar.
- A amostra é do **próprio repositório**, em PRs já mergeados. Não escolher PR manualmente.

## 2. Ground truth (o que conta como achado real)

Antes de rodar qualquer ferramenta, um avaliador (que não sabe qual ferramenta gerou cada achado) lê cada PR e registra, no diff do PR:

- **Problemas reais**: bug, vulnerabilidade, segredo, dependência maliciosa ou suspeita, teste faltando em código novo.
- **Não-problemas**: estilo, opinião, falso positivo evidente.

Regra de desempate: se dois avaliadores discordam, o achado conta como "incerto" e fica fora do cálculo de precisão, mas entra no relatório.

Isso precisa de um avaliador humano, ou ao menos de um revisor que não seja a ferramenta sob teste. Um modelo de IA como avaliador só vale se a discordância com humanos for medida antes.

## 3. Execução

- Cada ferramenta roda sobre o **mesmo** commit do PR, com a configuração padrão do fornecedor, sem ajuste feito para aquele PR.
- Se a ferramenta exige conta, token ou instalação de app, registrar o passo exato e quem fez. Ferramenta que não roda sem intervenção manual conta como "não avaliada", não como "zero achados".
- Registrar tempo de execução e falhas de setup.

## 4. Métricas

Para cada ferramenta, sobre a amostra inteira:

| Métrica | Como calcular |
|---|---|
| Achados reais encontrados (revocação) | achados reais detectados ÷ total de achados reais na amostra |
| Precisão | achados reais ÷ total de achados emitidos (sem contar os incertos) |
| Ruído por PR | achados não reais emitidos ÷ PRs da amostra |
| Bloqueios indevidos | PRs bloqueados pela ferramenta que não tinham problema real |
| Tempo até resultado | mediana, em minutos |
| Custo | o que é pago, o que exige plano, o que exige conta |

Revocação e precisão são reportadas separadas. Uma ferramenta que emite 1 achado por PR e acerta todos tem precisão alta mas ruído baixo; uma que emite 50 e acerta todos tem revocação alta mas ruído inaceitável. Nenhum dos dois números sozinho decide.

## 5. Critérios de decisão

- Ferramenta **bloqueante** só entra se: precisão ≥ 80% na amostra **e** bloqueios indevidos ≤ 1 em cada 5 PRs.
- Ferramenta **advisory** entra se: encontra ao menos um achado real que as outras não encontraram, com ruído ≤ 1 por PR.
- Ferramenta sem achado real na amostra é removida, mesmo que tenha boa documentação.

## 6. Relatório

Cada avaliação termina com:
- repositório, data, semente, tamanho da amostra e quantos PRs eram vermelhos;
- planilha preenchida (modelo em `docs/avaliacao/planilha-modelo.csv`);
- achados incertos listados à parte;
- o que não foi avaliado e por quê.

## Limites conhecidos

- Amostra pequena: 10 PRs medem ordem de grandeza, não taxa precisa. Declarar isso no relatório.
- Um único repositório tem perfil próprio (linguagem, tamanho de PR, time). Resultado não generaliza sem repetir em outro repo.
- Este protocolo não mede custo de manutenção (tempo para ajustar regras, triar alertas). Isso precisa de outra medição.
