# Pré-registro do conjunto de defeitos semeados (v1)

- Data: 2026-11-05
- Repositório de teste: devAndreotti/quality-gate-lab, PRs #18 a #25 (branches seed/seed01 a seed/seed08, rascunhos, não mergear)
- Casos: 5 defeitos (CWE-78, CWE-95, CWE-22, CWE-798, CWE-338) e 3 controles sem defeito
- SHA-256 do manifesto com as respostas esperadas: `7604161e1a7ebe9ae8440cc75611202780e3aad313942b32131de3798b1713c9`

O manifesto (tipo, CWE, arquivo, linha e descrição de cada caso) fica fora do repositório público, para que nenhuma ferramenta o leia. A verificação é: quando o manifesto for revelado após a medição, o hash deve bater com o acima. Se não bater, a medição é inválida.

Regra de avaliação: uma ferramenta "detecta" um defeito se emite achado no arquivo certo, com linha a até 2 do esperado, e categoria compatível com o CWE. Achado fora desse critério é ruído.
