# Política de segurança

## Versões suportadas

Só a branch `main` recebe correções de segurança.

## Como reportar uma vulnerabilidade

O relato privado do GitHub não está habilitado neste repositório, então **não há canal privado no momento**. Para não expor detalhes publicamente, abra uma issue mencionando apenas que tem um relato de segurança e peça um contato, sem incluir a reprodução. Descreva o problema em uma issue pública somente depois que ele estiver corrigido.

Inclua, quando possível: o que é, como reproduzir (comando ou passos mínimos), versão ou commit afetado e o impacto observado.

Para bugs comuns, dúvidas ou sugestões que não são de segurança, use as issues normais.

## Escopo

Dentro do escopo:

- os scripts em `scripts/` e a CLI `qg`;
- os workflows em `.github/workflows/`;
- escrita de arquivos fora do diretório do projeto alvo, execução de comandos a partir de dados não confiáveis (nomes de branch, títulos ou diffs de PR, saída de ferramentas) e vazamento de segredos pelos scripts.

Fora do escopo:

- vulnerabilidades em dependências de terceiros sem impacto demonstrado neste projeto (reporte ao projeto upstream);
- falhas em serviços ou ferramentas externas (GitHub, SonarCloud, Semgrep, CodeQL);
- relatos só com saída de scanner, sem reprodução;
- engenharia social e ataques contra a infraestrutura de quem usa o projeto.

## Resposta

Este projeto é mantido por uma pessoa e não tem prazo de resposta garantido. Relatos são lidos quando possível, e a correção segue a gravidade e a disponibilidade de quem mantém.
