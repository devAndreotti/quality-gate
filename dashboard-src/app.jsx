// Fonte dev-only do TUI rico do qg-dash — nunca distribuído como está (ver package.json).
// Compilado por scripts/build-dashboard-tui.mjs em scripts/dashboard-tui.mjs (esse sim
// copiado pelo qg-init, junto do resto de scripts/). Reaproveita a mesma lógica de coleta
// de estado do modo texto (scripts/dashboard.cjs) em vez de duplicá-la.
import React, { useState, useEffect } from 'react';
import { render, Box, Text, useApp, useInput, useStdin } from 'ink';
import path from 'node:path';
// import estático (não createRequire) de propósito: esbuild só inlina o conteúdo de
// dashboard.cjs no bundle final quando consegue resolver a dependência estaticamente
// no grafo de módulos. Um require() via createRequire fica de fora do bundle e quebra
// em runtime quando o .mjs é copiado sozinho para outro lugar (ver plano).
import { collectState, formatAge } from '../scripts/dashboard.cjs';

const REFRESH_MS = 5000;

function StatusIcon({ ok }) {
  return <Text color={ok ? 'green' : 'red'}>{ok ? '✅' : '❌'}</Text>;
}

function EstadoSection({ root, state }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text bold color="cyan">◉ ESTADO</Text>
      <Text>Repo       <Text color="gray">{root}</Text></Text>
      <Text>Branch     <Text color="gray">{state.branch || 'desconhecida'}</Text></Text>
      <Text>Remoto     <Text color="gray">{state.remote || 'nao configurado'}</Text></Text>
      <Text>Token env  <Text color="gray">{state.tokenEnv}</Text></Text>
    </Box>
  );
}

function RatchetSection({ ratchet }) {
  const rows = ratchet?.rows || [];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
      <Text bold color="yellow">▤ RATCHET</Text>
      {!ratchet && <Text color="gray">scripts/quality-gate.js nao encontrado neste projeto</Text>}
      {ratchet?.error && <Text color="yellow">⚠️  {ratchet.error}</Text>}
      {ratchet && !ratchet.error && rows.length === 0 && <Text color="gray">(sem metricas coletadas ainda)</Text>}
      {ratchet && !ratchet.error && rows.map((row) => (
        <Text key={`${row.group}/${row.metric}`}>
          <StatusIcon ok={row.passed} /> {row.group}/{row.metric}{' '}
          <Text color="gray">{row.baseline} -&gt; {row.current} ({row.delta})</Text>
        </Text>
      ))}
    </Box>
  );
}

function PrSection({ snapshot, snapshotAge }) {
  const merge = snapshot?.merge || {};
  const label = merge.status === 'ready' ? 'ready' : merge.status === 'ready_with_advisory' ? 'advisory' : 'blocked';
  const color = label === 'ready' ? 'green' : label === 'advisory' ? 'yellow' : 'red';
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">◇ PR (ULTIMO SNAPSHOT LOCAL)</Text>
      {!snapshot && <Text color="gray">nenhum snapshot salvo ainda — rode "PR snapshot" no menu (qg)</Text>}
      {snapshot && (
        <>
          <Text>#{snapshot.pr?.number ?? '?'} {snapshot.pr?.title ?? ''}</Text>
          <Text>Status  <Text color={color}>{label}</Text> <Text color="gray">({formatAge(snapshotAge)})</Text></Text>
          {(merge.blockers || []).map((blocker, i) => (
            <Text key={i} color="yellow">⚠️  {blocker.message}</Text>
          ))}
        </>
      )}
    </Box>
  );
}

function App({ root }) {
  const [state, setState] = useState(() => collectState(root));
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();

  // Sem TTY real (pipe/CI), useInput lançaria o banner de erro do ink por baixo do
  // pano; o painel ainda funciona, só sem atalhos de teclado -- o refresh automático
  // continua rodando via o setInterval abaixo.
  // isRawModeSupported vem como `undefined` (não `false`) quando stdin não é TTY --
  // ink só pula a ativação do raw mode quando isActive é estritamente `false`, então
  // precisa do Boolean() aqui, senão `undefined` cai no mesmo caminho de "ativo".
  useInput((input) => {
    if (input === 'q') exit();
    if (input === 'r') setState(collectState(root));
  }, { isActive: Boolean(isRawModeSupported) });

  useEffect(() => {
    const timer = setInterval(() => setState(collectState(root)), REFRESH_MS);
    return () => clearInterval(timer);
  }, [root]);

  return (
    <Box flexDirection="column">
      <Text bold color="blue">◆ Quality Gate Dashboard  <Text color="gray">{state.now.toLocaleTimeString()}</Text></Text>
      <Text> </Text>
      <EstadoSection root={root} state={state} />
      <RatchetSection ratchet={state.ratchet} />
      <PrSection snapshot={state.snapshot} snapshotAge={state.snapshotAge} />
      <Text color="gray">atualizado {state.now.toLocaleTimeString()} — a cada {REFRESH_MS / 1000}s — [r] refresh agora  [q] sair</Text>
    </Box>
  );
}

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
render(<App root={root} />);
