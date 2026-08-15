// Fonte dev-only do menu rico do qg (mesmo padrao de app.jsx/dashboard-tui.mjs).
// Compilado por scripts/build-tui.mjs em scripts/menu-tui.mjs.
//
// Recebe os itens via arquivo JSON temporario (não via argv) — evita o inferno de
// escaping de aspas/JSON que o PowerShell faria ao passar array pra um processo
// filho. QualityGate.ps1 escreve o temp file, chama este script, le "SELECTED:<opcao>"
// da ultima linha de stdout, apaga o temp file.
import React, { useEffect, useState } from 'react';
import { render, Box, Text, useApp, useInput, useStdin } from 'ink';
import fs from 'node:fs';

const [, , itemsPath, title] = process.argv;
const items = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));

let selected = null;

function Menu() {
  const [index, setIndex] = useState(0);
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const active = Boolean(isRawModeSupported);

  useEffect(() => {
    // Sem TTY real, nenhuma tecla jamais chega -- ficaria pendurado pra sempre
    // esperando input impossivel. O dispatcher no PowerShell já não chama este
    // script fora de um TTY real; isto é só a rede de segurança.
    if (!active) exit();
  }, [active, exit]);

  useInput((input, key) => {
    if (key.upArrow) setIndex((i) => (i - 1 + items.length) % items.length);
    if (key.downArrow) setIndex((i) => (i + 1) % items.length);
    if (key.return) {
      selected = items[index].Opcao;
      exit();
    }
    if (input === 'q' || key.escape) exit();
  }, { isActive: active });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
      <Text bold color="blue">◆ {title || 'Quality Gate'}</Text>
      <Text> </Text>
      {items.map((item, i) => (
        <Text key={item.Opcao} color={i === index ? 'black' : 'white'} backgroundColor={i === index ? 'cyan' : undefined}>
          {i === index ? '❯ ' : '  '}[{item.Opcao}] {item.Acao}
        </Text>
      ))}
      <Text> </Text>
      <Text color="gray">↑/↓ navega · Enter seleciona · q/Esc cancela</Text>
    </Box>
  );
}

const { waitUntilExit } = render(<Menu />);
await waitUntilExit();
// Impresso só depois do unmount (terminal já restaurado) -- imprimir durante o
// render do ink corromperia a tela.
if (selected) console.log(`SELECTED:${selected}`);
