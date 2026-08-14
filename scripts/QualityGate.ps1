<#
.SYNOPSIS
    Script auxiliar para o Quality Gate integrado com o perfil Scriply.
.DESCRIPTION
    Este script expõe funções para gerenciar e executar as checagens do Quality Gate.
    Código em inglês; comentários em português do Brasil (regra de global user).
#>

param(
    [switch]$Init,
    [switch]$Doctor,
    [switch]$Check,
    [switch]$Update,
    [switch]$Report,
    [switch]$Help,

    # Flags específicas para o -Init
    [switch]$Sonar,
    [switch]$SkipCodex,
    [switch]$SkipBaseline,
    [switch]$SkipCommit,
    [switch]$SkipGitHub,
    [switch]$DryRun,
    [switch]$Yes,
    [switch]$Force,
    [string]$Repo
)

$ErrorActionPreference = 'Stop'

# Função para exibir ajuda amigável
function Show-Help {
    Write-Host ''
    Write-Host '  ╭────────────────────────────────────────────────────────────╮' -ForegroundColor Blue
    Write-Host '  │  Quality Gate                                          v1.0│' -ForegroundColor Blue
    Write-Host '  ╰────────────────────────────────────────────────────────────╯' -ForegroundColor Blue
    Write-Host ''
    Write-Host '   COMANDOS' -ForegroundColor Blue
    Write-Host '  ────────────────────────────────────────────────────────────' -ForegroundColor DarkGray
    Write-Host '    qg                  -               exibe esta tela de ajuda' -ForegroundColor Gray
    Write-Host '    qg-init             qg -Init        wizard interativo de instalacao' -ForegroundColor Gray
    Write-Host '    qg-doc              qg -Doctor      diagnostico das ferramentas' -ForegroundColor Gray
    Write-Host '    qg-chk              qg -Check       verifica regressao de metricas' -ForegroundColor Gray
    Write-Host '    qg-upd              qg -Update      atualiza o baseline de metricas' -ForegroundColor Gray
    Write-Host '    qg-rpt              qg -Report      exibe o relatorio de qualidade' -ForegroundColor Gray
    Write-Host ''
    Write-Host '   FLAGS DO WIZARD (-Init)' -ForegroundColor Blue
    Write-Host '  ────────────────────────────────────────────────────────────' -ForegroundColor DarkGray
    Write-Host '    -Sonar              -               configura org/token do SonarCloud' -ForegroundColor Gray
    Write-Host '    -SkipCodex          -               pula a copia da pasta .codex/' -ForegroundColor Gray
    Write-Host '    -SkipBaseline       -               pula a captura do baseline inicial' -ForegroundColor Gray
    Write-Host '    -SkipCommit         -               pula o commit automatico no git' -ForegroundColor Gray
    Write-Host '    -SkipGitHub         -               pula branch protection e ruleset remoto' -ForegroundColor Gray
    Write-Host '    -DryRun             -               executa em modo demonstracao' -ForegroundColor Gray
    Write-Host '    -Yes                -               confirma etapas com padrao seguro' -ForegroundColor Gray
    Write-Host '    -Force              -               permite instalar em stack nao Node' -ForegroundColor Gray
    Write-Host '    -Repo <owner/repo>  -               forca repositorio especifico' -ForegroundColor Gray
    Write-Host ''
    Write-Host '  uso: qg-init | qg-chk | qg-upd | qg-doc | qg-rpt' -ForegroundColor DarkGray
    Write-Host '  atalhos: qg-init [-Yes] [-Sonar] [-SkipCodex] [-SkipBaseline] [-SkipCommit] [-SkipGitHub] [-DryRun] [-Force] [-Repo <slug>]' -ForegroundColor DarkGray
    Write-Host ''
}

# Helper interativo para escolha de Sim/Pular/Cancelar
function Confirm-Step {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,
        [switch]$DefaultYes
    )
    $choices = "[S]im / [P]ular / [C]ancelar"
    if ($DefaultYes) {
        $choices = "[S]im (padrão) / [P]ular / [C]ancelar"
    }
    
    while ($true) {
        $response = Read-Host "$Message ($choices)"
        if ([string]::IsNullOrWhiteSpace($response)) {
            if ($DefaultYes) { return "s" }
            continue
        }
        $r = $response.ToLower().Trim()
        if ($r -eq 's' -or $r -eq 'sim') { return 's' }
        if ($r -eq 'p' -or $r -eq 'pular') { return 'p' }
        if ($r -eq 'c' -or $r -eq 'cancelar') { return 'c' }
        Write-Host "Opção inválida. Escolha S, P ou C." -ForegroundColor Yellow
    }
}

function Write-DryRunPlan {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message
    )
    Write-Host "    [DryRun] $Message" -ForegroundColor DarkGray
}

function Request-Step {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,
        [switch]$DefaultYes
    )
    if ($DryRun) {
        Write-DryRunPlan "$Message -> simulado"
        return 's'
    }
    if ($Yes) {
        Write-InitItem "$Message -> sim" 'DarkGray'
        return 's'
    }
    return Confirm-Step -Message $Message -DefaultYes:$DefaultYes
}

function Get-GhKeyringToken {
    $hadGitHubToken = Test-Path Env:\GITHUB_TOKEN
    $hadGhToken = Test-Path Env:\GH_TOKEN
    $savedGitHubToken = $env:GITHUB_TOKEN
    $savedGhToken = $env:GH_TOKEN

    try {
        Remove-Item Env:\GITHUB_TOKEN -ErrorAction SilentlyContinue
        Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue
        $token = (gh auth token 2>$null)
        if ([string]::IsNullOrWhiteSpace($token)) { return $null }
        return $token.Trim()
    } catch {
        return $null
    } finally {
        if ($hadGitHubToken) { $env:GITHUB_TOKEN = $savedGitHubToken } else { Remove-Item Env:\GITHUB_TOKEN -ErrorAction SilentlyContinue }
        if ($hadGhToken) { $env:GH_TOKEN = $savedGhToken } else { Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue }
    }
}

$script:QgInitSummary = @()

function Write-InitBanner {
    param(
        [Parameter(Mandatory=$true)]
        [string]$ProjectRoot,
        [Parameter(Mandatory=$true)]
        [string]$TemplateRoot,
        [Parameter(Mandatory=$true)]
        [string]$Mode
    )
    Write-Host ''
    Write-Host '  ╭────────────────────────────────────────────────────────────╮' -ForegroundColor Cyan
    Write-Host '  │  Quality Gate Init                                     v1.0│' -ForegroundColor Cyan
    Write-Host '  ╰────────────────────────────────────────────────────────────╯' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '   CONTEXTO' -ForegroundColor Cyan
    Write-Host '  ────────────────────────────────────────────────────────────' -ForegroundColor DarkGray
    Write-Host ("    Projeto   {0}" -f $ProjectRoot) -ForegroundColor Gray
    Write-Host ("    Template  {0}" -f $TemplateRoot) -ForegroundColor Gray
    Write-Host ("    Modo      {0}" -f $Mode) -ForegroundColor Gray
    Write-Host ''
}

function Write-InitStep {
    param(
        [Parameter(Mandatory=$true)]
        [int]$Number,
        [Parameter(Mandatory=$true)]
        [string]$Title,
        [Parameter(Mandatory=$true)]
        [string]$Description
    )
    Write-Host ''
    Write-Host ("  [{0}/5] {1}" -f $Number, $Title) -ForegroundColor Yellow
    Write-Host '  ────────────────────────────────────────────────────────────' -ForegroundColor DarkGray
    Write-Host ("    {0}" -f $Description) -ForegroundColor DarkGray
}

function Write-InitItem {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,
        [string]$Color = 'Gray'
    )
    Write-Host ("    {0}" -f $Message) -ForegroundColor $Color
}

function Add-InitSummary {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Step,
        [Parameter(Mandatory=$true)]
        [string]$Status,
        [Parameter(Mandatory=$true)]
        [string]$Detail
    )
    $script:QgInitSummary += [pscustomobject]@{
        Step = $Step
        Status = $Status
        Detail = $Detail
    }
}

function Write-InitSummary {
    Write-Host ''
    Write-Host '   RESUMO' -ForegroundColor Cyan
    Write-Host '  ────────────────────────────────────────────────────────────' -ForegroundColor DarkGray
    foreach ($item in $script:QgInitSummary) {
        $color = 'Gray'
        $marker = '•'
        if ($item.Status -eq 'ok') { $color = 'Green'; $marker = '✓' }
        elseif ($item.Status -eq 'warn') { $color = 'Yellow'; $marker = '!' }
        elseif ($item.Status -eq 'fail') { $color = 'Red'; $marker = 'x' }
        elseif ($item.Status -eq 'skip') { $color = 'DarkGray'; $marker = '-' }
        Write-Host ("    {0} {1,-12} {2}" -f $marker, $item.Step, $item.Detail) -ForegroundColor $color
    }
    Write-Host ''
}

function Get-ProjectProfile {
    param([Parameter(Mandatory=$true)][string]$Root)

    if (Test-Path (Join-Path $Root 'package.json')) {
        return [pscustomobject]@{ Name = 'node'; Detail = 'package.json na raiz' }
    }
    if (Test-Path (Join-Path $Root 'pyproject.toml')) {
        return [pscustomobject]@{ Name = 'python-uv'; Detail = 'pyproject.toml na raiz' }
    }
    if (Test-Path (Join-Path $Root 'pipeline\pyproject.toml')) {
        return [pscustomobject]@{ Name = 'python-uv'; Detail = 'pipeline\pyproject.toml' }
    }
    return [pscustomobject]@{ Name = 'unknown'; Detail = 'stack nao detectada' }
}

function Test-ProjectProfileSupported {
    param([Parameter(Mandatory=$true)][string]$Profile)
    return $Profile -in @('node', 'python-uv')
}

# Passo 3 do wizard (GitHub via setup.js), extraído para função porque também
# é chamado isoladamente pelo menu interativo (opção "Setup GitHub remote policy").
function Invoke-GitHubSetupStep {
    if ($SkipGitHub) {
        Write-InitItem 'Setup do GitHub pulado por parâmetro.' 'DarkGray'
        Add-InitSummary -Step 'GitHub' -Status 'skip' -Detail 'pulado por flag'
        return
    }
    $confirm = Request-Step -Message "Deseja rodar o script de setup do GitHub (setup.js)?" -DefaultYes
    if ($confirm -eq 'c') {
        Write-Host "Setup cancelado pelo usuário." -ForegroundColor Red
        return
    }
    if ($confirm -ne 's') {
        Write-InitItem 'Setup do GitHub pulado.' 'DarkGray'
        Add-InitSummary -Step 'GitHub' -Status 'skip' -Detail 'pulado'
        return
    }

    $token = $null
    if ($DryRun) {
        Write-DryRunPlan "Não leria token do GitHub; setup.js rodará com --dry-run"
    } else {
        $envHasGitHubToken = -not [string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)
        $envHasGhToken = -not [string]::IsNullOrWhiteSpace($env:GH_TOKEN)
        $keyringToken = Get-GhKeyringToken

        if (($envHasGitHubToken -or $envHasGhToken) -and -not [string]::IsNullOrWhiteSpace($keyringToken)) {
            Write-Warning "GITHUB_TOKEN/GH_TOKEN ativo pode sobrescrever o gh keyring. Usando token do gh keyring para esta etapa."
            $token = $keyringToken
        } elseif (-not [string]::IsNullOrWhiteSpace($keyringToken)) {
            $token = $keyringToken
        } elseif ($envHasGitHubToken) {
            Write-Warning "Usando GITHUB_TOKEN do ambiente. Se der 403, rode 'gh auth login' ou limpe GITHUB_TOKEN/GH_TOKEN."
            $token = $env:GITHUB_TOKEN
        } elseif ($envHasGhToken) {
            Write-Warning "Usando GH_TOKEN do ambiente. Se der 403, rode 'gh auth login' ou limpe GITHUB_TOKEN/GH_TOKEN."
            $token = $env:GH_TOKEN
        }

        if ([string]::IsNullOrWhiteSpace($token)) {
            $secureTokenInput = Read-Host "Insira o token do GitHub manualmente (ou dê Enter para pular esta etapa)" -AsSecureString
            if ($secureTokenInput.Length -gt 0) {
                $tokenInput = [System.Net.NetworkCredential]::new('', $secureTokenInput).Password
                if (-not [string]::IsNullOrWhiteSpace($tokenInput)) {
                    $token = $tokenInput.Trim()
                }
            }
        }
    }

    if (-not $DryRun -and [string]::IsNullOrWhiteSpace($token)) {
        Write-Warning "Ignorando configuração do GitHub: GITHUB_TOKEN não fornecido."
        Add-InitSummary -Step 'GitHub' -Status 'skip' -Detail 'sem token'
        return
    }

    $setupArgs = @()
    if ($Repo) {
        $setupArgs += "--repo=$Repo"
    }
    if ($DryRun) {
        $setupArgs += "--dry-run"
    }
    if (-not $Sonar) {
        $setupArgs += "--skip-sonar"
    } elseif (-not $DryRun) {
        $sonarOrg = Read-Host "Insira a Organização do SonarCloud"
        $secureSonarToken = Read-Host "Insira o Token do SonarCloud" -AsSecureString
        $sonarToken = $null
        if ($secureSonarToken.Length -gt 0) {
            $sonarToken = [System.Net.NetworkCredential]::new('', $secureSonarToken).Password
        }
        if ($sonarOrg) { $setupArgs += "--sonar-org=$sonarOrg" }
        if ($sonarToken) { $setupArgs += "--sonar-token=$sonarToken" }
    }

    $setupJs = if ($DryRun) { Join-Path $TemplateRoot "scripts\setup.js" } else { Join-Path $ProjectRoot "scripts\setup.js" }
    if (-not (Test-Path $setupJs)) {
        Add-InitSummary -Step 'GitHub' -Status 'fail' -Detail 'setup.js ausente'
        Write-InitSummary
        Write-Error "setup.js não foi encontrado no projeto!"
        return
    }

    Write-InitItem 'Executando setup.js...'
    $hadGitHubToken = Test-Path Env:\GITHUB_TOKEN
    $hadGhToken = Test-Path Env:\GH_TOKEN
    $savedGitHubToken = $env:GITHUB_TOKEN
    $savedGhToken = $env:GH_TOKEN
    try {
        if (-not $DryRun) {
            $env:GITHUB_TOKEN = $token
            Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue
        }
        & node $setupJs $setupArgs
        if ($LASTEXITCODE -ne 0) {
            Add-InitSummary -Step 'GitHub' -Status 'fail' -Detail "setup.js retornou $LASTEXITCODE"
            Write-InitSummary
            Write-Error "Falha ao executar o setup.js (código de retorno: $LASTEXITCODE)."
        } else {
            Write-Host '    ✓ GitHub configurado com sucesso.' -ForegroundColor Green
            Add-InitSummary -Step 'GitHub' -Status 'ok' -Detail 'configurado'
        }
    } finally {
        if ($hadGitHubToken) { $env:GITHUB_TOKEN = $savedGitHubToken } else { Remove-Item Env:\GITHUB_TOKEN -ErrorAction SilentlyContinue }
        if ($hadGhToken) { $env:GH_TOKEN = $savedGhToken } else { Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue }
    }
}

# ── Slice 8: diagnóstico de auth e remoto ──────────────────
function Get-QgAuthDiagnostic {
    $envHasGitHubToken = -not [string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)
    $envHasGhToken = -not [string]::IsNullOrWhiteSpace($env:GH_TOKEN)
    $keyringToken = Get-GhKeyringToken
    $remoteUrl = $null
    try { $remoteUrl = (git remote get-url origin 2>$null) } catch {}
    $remoteHeads = $null
    if ($remoteUrl) {
        try { $remoteHeads = git ls-remote --heads origin 2>$null } catch {}
    }
    [pscustomobject]@{
        TokenEnvAtivo   = $envHasGitHubToken -or $envHasGhToken
        TokenEnvNome    = if ($envHasGitHubToken) { 'GITHUB_TOKEN' } elseif ($envHasGhToken) { 'GH_TOKEN' } else { $null }
        GhKeyringOk     = -not [string]::IsNullOrWhiteSpace($keyringToken)
        RemotoAusente   = [string]::IsNullOrWhiteSpace($remoteUrl)
        RemotoSemBranch = [bool]($remoteUrl -and -not $remoteHeads)
    }
}

function Show-QgAuthDiagnostic {
    $diag = Get-QgAuthDiagnostic
    Write-Host ''
    Write-Host '   AUTH / REMOTO' -ForegroundColor Cyan
    Write-Host '  ────────────────────────────────────────────────────────────' -ForegroundColor DarkGray
    if ($diag.TokenEnvAtivo) {
        Write-InitItem "Token de ambiente ativo: $($diag.TokenEnvNome)" 'Yellow'
    } else {
        Write-InitItem 'Token de ambiente: nenhum' 'DarkGray'
    }
    Write-InitItem ("gh keyring: {0}" -f $(if ($diag.GhKeyringOk) { 'disponivel' } else { 'indisponivel' })) $(if ($diag.GhKeyringOk) { 'Green' } else { 'DarkGray' })
    if ($diag.RemotoAusente) {
        Write-InitItem 'Repo remoto: ausente (git remote origin não configurado)' 'Yellow'
    } elseif ($diag.RemotoSemBranch) {
        Write-InitItem 'Repo remoto: sem branch default (nenhum push ainda)' 'Yellow'
    } else {
        Write-InitItem 'Repo remoto: configurado' 'Green'
    }
    if ($diag.TokenEnvAtivo -and $diag.GhKeyringOk) {
        Write-InitItem 'Token de ambiente pode conflitar com o gh keyring. Para usar o keyring temporariamente:' 'DarkGray'
        Write-InitItem '$env:GITHUB_TOKEN=$null; $env:GH_TOKEN=$null; git push' 'DarkGray'
    }
    Write-Host ''
}

# ── Slice 9: fluxo de PR integrado ao menu ─────────────────
function Resolve-QgPrNumber {
    $inferred = $null
    try { $inferred = (gh pr view --json number -q .number 2>$null) } catch {}
    if ($inferred -match '^\d+$') { return [int]$inferred }
    $manual = Read-Host 'Número do PR (não foi possível inferir da branch atual)'
    if ($manual -match '^\d+$') { return [int]$manual }
    return $null
}

function Show-QgPrSnapshotSummary {
    param([Parameter(Mandatory=$true)]$Snapshot)

    $status = $Snapshot.merge.status
    $label = switch ($status) {
        'ready' { 'ready' }
        'ready_with_advisory' { 'advisory' }
        default { if ($Snapshot.ci.overall -eq 'pending') { 'waiting' } else { 'blocked' } }
    }
    $color = switch ($label) {
        'ready' { 'Green' }
        'advisory' { 'Yellow' }
        'waiting' { 'DarkGray' }
        default { 'Red' }
    }
    $blockers = @($Snapshot.merge.blockers)
    $actions = @($Snapshot.actions)

    Write-Host ''
    Write-Host ("   PR #{0} — {1}" -f $Snapshot.pr.number, $Snapshot.pr.title) -ForegroundColor Cyan
    Write-Host '  ────────────────────────────────────────────────────────────' -ForegroundColor DarkGray
    Write-InitItem ("Status: {0}" -f $label) $color
    if ($blockers.Count -gt 0) {
        Write-InitItem 'Blockers:' 'Yellow'
        foreach ($blocker in $blockers) {
            Write-InitItem ("  - {0}" -f $blocker.message) 'Yellow'
        }
    }
    if ($actions.Count -gt 0) {
        Write-InitItem ("Next: {0}" -f $actions[0]) 'Gray'
    }
    Write-InitItem ("Link: {0}" -f $Snapshot.pr.url) 'DarkGray'
    Write-Host ''
}

# ── Slice 7: menu interativo (`qg` sem flags) ──────────────
function Get-QgMenuState {
    $projectProfile = Get-ProjectProfile -Root $ProjectRoot
    $branch = $null
    try { $branch = (git rev-parse --abbrev-ref HEAD 2>$null) } catch {}
    $remoteUrl = $null
    try { $remoteUrl = (git remote get-url origin 2>$null) } catch {}
    $auth = Get-QgAuthDiagnostic
    $lastReport = $null
    $reportPath = Join-Path $ProjectRoot ".quality-gate\reports\pr-snapshot.json"
    if (Test-Path $reportPath) {
        $lastReport = (Get-Item $reportPath).LastWriteTime
    }
    $prNumber = $null
    try {
        $hasUpstream = git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null
        if ($hasUpstream) {
            $inferred = (gh pr view --json number -q .number 2>$null)
            if ($inferred -match '^\d+$') { $prNumber = [int]$inferred }
        }
    } catch {}

    [pscustomobject]@{
        Instalado    = Test-Path (Join-Path $ProjectRoot "scripts\doctor.cjs")
        Perfil       = $projectProfile.Name
        RepoRemoto   = if ($remoteUrl) { $remoteUrl } else { 'não configurado' }
        Branch       = if ($branch) { $branch } else { 'desconhecida' }
        TokenAtivo   = $auth.TokenEnvAtivo
        UltimoReport = $lastReport
        PrDetectado  = $prNumber
    }
}

function Show-QgMenuState {
    param([Parameter(Mandatory=$true)]$State)
    Write-Host ''
    Write-Host '  ╭────────────────────────────────────────────────────────────╮' -ForegroundColor Blue
    Write-Host '  │  Quality Gate                                          v1.0│' -ForegroundColor Blue
    Write-Host '  ╰────────────────────────────────────────────────────────────╯' -ForegroundColor Blue
    Write-Host ''
    Write-InitItem ("Perfil         {0}" -f $State.Perfil)
    Write-InitItem ("Repo remoto    {0}" -f $State.RepoRemoto)
    Write-InitItem ("Branch         {0}" -f $State.Branch)
    Write-InitItem ("Token ativo    {0}" -f $(if ($State.TokenAtivo) { 'sim' } else { 'não' }))
    Write-InitItem ("Último report  {0}" -f $(if ($State.UltimoReport) { $State.UltimoReport } else { 'nenhum' }))
    Write-InitItem ("PR detectado   {0}" -f $(if ($State.PrDetectado) { "#$($State.PrDetectado)" } else { 'nenhum' }))
    Write-Host ''
}

function Invoke-QgMenu {
    $state = Get-QgMenuState
    Show-QgMenuState -State $state

    if (-not $state.Instalado) {
        Write-Host '  Quality Gate não está instalado nesta pasta.' -ForegroundColor Yellow
        Write-Host ''
        $items = @(
            [pscustomobject]@{ Opcao = 'I'; Acao = 'Install/repair Quality Gate' }
            [pscustomobject]@{ Opcao = 'H'; Acao = 'Help' }
        )
    } else {
        $items = @(
            [pscustomobject]@{ Opcao = 'I'; Acao = 'Install/repair Quality Gate' }
            [pscustomobject]@{ Opcao = 'D'; Acao = 'Doctor (diagnóstico)' }
            [pscustomobject]@{ Opcao = 'V'; Acao = 'Run local PR validation' }
            [pscustomobject]@{ Opcao = 'U'; Acao = 'Update baseline' }
            [pscustomobject]@{ Opcao = 'G'; Acao = 'Setup GitHub remote policy' }
            [pscustomobject]@{ Opcao = 'S'; Acao = 'PR snapshot' }
            [pscustomobject]@{ Opcao = 'B'; Acao = 'Babysit PR once' }
            [pscustomobject]@{ Opcao = 'R'; Acao = 'Show report' }
            [pscustomobject]@{ Opcao = 'H'; Acao = 'Help' }
        )
    }

    $selection = $null
    $gridAvailable = $false
    if (-not (Get-Module -ListAvailable -Name Microsoft.PowerShell.ConsoleGuiTools)) {
        try {
            Write-Host '  Instalando módulo Microsoft.PowerShell.ConsoleGuiTools (uma vez por máquina)...' -ForegroundColor DarkGray
            Install-Module -Name Microsoft.PowerShell.ConsoleGuiTools -Scope CurrentUser -Force -AllowClobber -Confirm:$false -ErrorAction Stop
        } catch {
            Write-Warning "Não foi possível instalar Microsoft.PowerShell.ConsoleGuiTools ($($_.Exception.Message)). Usando menu de texto."
        }
    }
    if (Get-Module -ListAvailable -Name Microsoft.PowerShell.ConsoleGuiTools) {
        Import-Module Microsoft.PowerShell.ConsoleGuiTools -ErrorAction SilentlyContinue
        if (Get-Command Out-ConsoleGridView -ErrorAction SilentlyContinue) {
            $gridAvailable = $true
        }
    }

    if ($gridAvailable) {
        $picked = $items | Out-ConsoleGridView -Title 'Quality Gate - escolha uma ação' -OutputMode Single
        if ($picked) { $selection = $picked.Opcao }
    } else {
        Write-Host '   ESCOLHA UMA AÇÃO' -ForegroundColor Blue
        Write-Host '  ────────────────────────────────────────────────────────────' -ForegroundColor DarkGray
        foreach ($item in $items) {
            Write-Host ("    [{0}] {1}" -f $item.Opcao, $item.Acao) -ForegroundColor Gray
        }
        Write-Host ''
        $response = Read-Host 'Opção'
        if ($response) { $selection = $response.ToUpper().Trim() }
    }

    if ([string]::IsNullOrWhiteSpace($selection)) {
        Write-Host '  Nenhuma opção selecionada.' -ForegroundColor DarkGray
        return
    }

    switch ($selection) {
        'I' { Invoke-Init }
        'D' {
            Invoke-DoctorAction
            Show-QgAuthDiagnostic
        }
        'V' { Invoke-LocalValidateAction }
        'U' { Invoke-UpdateAction }
        'G' {
            $script:QgInitSummary = @()
            Invoke-GitHubSetupStep
            Write-InitSummary
        }
        'S' {
            $prNumber = if ($state.PrDetectado) { $state.PrDetectado } else { Resolve-QgPrNumber }
            if (-not $prNumber) { Write-Warning 'Número do PR não informado.'; return }
            $snapshotJs = Join-Path $ProjectRoot "scripts\pr-snapshot.cjs"
            if (-not (Test-Path $snapshotJs)) { Write-Error "pr-snapshot.cjs ausente."; return }
            $outputPath = Join-Path $ProjectRoot ".quality-gate\reports\pr-snapshot.json"
            $raw = & node $snapshotJs --pr $prNumber --json --output $outputPath
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "pr-snapshot.cjs retornou $LASTEXITCODE"
                return
            }
            try {
                $snapshot = ($raw -join "`n") | ConvertFrom-Json
                Show-QgPrSnapshotSummary -Snapshot $snapshot
            } catch {
                Write-Host ($raw -join "`n")
            }
        }
        'B' {
            $prNumber = if ($state.PrDetectado) { $state.PrDetectado } else { Resolve-QgPrNumber }
            if (-not $prNumber) { Write-Warning 'Número do PR não informado.'; return }
            $babysitJs = Join-Path $ProjectRoot "scripts\babysit-loop.cjs"
            if (-not (Test-Path $babysitJs)) { Write-Error "babysit-loop.cjs ausente."; return }
            & node $babysitJs --pr $prNumber --once
        }
        'R' { Invoke-ReportAction }
        'H' { Show-Help }
        default { Write-Warning "Opção '$selection' inválida." }
    }
}

# Resolve os caminhos importantes
# $PSScriptRoot é d:\Dev\Tooling\quality-gate\scripts. O pai é a raiz do template.
$TemplateRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $TemplateRoot "scripts\setup.js"))) {
    # Fallback caso o localizador dinâmico falhe
    $TemplateRoot = "d:\Dev\Tooling\quality-gate"
}

$ProjectRoot = $pwd.Path

if ($Help) {
    Show-Help
    return
}

# ── Modo Init (Wizard) ────────────────────────────────────
function Invoke-Init {
    $script:QgInitSummary = @()
    $mode = if ($DryRun) { 'DryRun (sem escrita, commit ou chamada mutável)' } elseif ($Yes) { 'Execução real (-Yes)' } else { 'Execução real' }
    $projectProfile = Get-ProjectProfile -Root $ProjectRoot
    Write-InitBanner -ProjectRoot $ProjectRoot -TemplateRoot $TemplateRoot -Mode $mode
    Write-Host ("    Perfil    {0} ({1})" -f $projectProfile.Name, $projectProfile.Detail) -ForegroundColor Gray

    if (-not (Test-ProjectProfileSupported -Profile $projectProfile.Name) -and -not $DryRun -and -not $Force) {
        Write-Host ''
        Write-Host '  PERFIL INCOMPATIVEL' -ForegroundColor Yellow
        Write-Host '  ────────────────────────────────────────────────────────────' -ForegroundColor DarkGray
        Write-Host '    Este pacote v1 suporta node e python-uv.' -ForegroundColor Yellow
        Write-Host '    O perfil atual nao foi reconhecido; workflow poderia quebrar o CI.' -ForegroundColor Yellow
        Write-Host '    Use -DryRun para inspecionar ou -Force se voce realmente quiser instalar mesmo assim.' -ForegroundColor Yellow
        Add-InitSummary -Step 'Perfil' -Status 'fail' -Detail ("{0} nao suportado sem -Force" -f $projectProfile.Name)
        Write-InitSummary
        return
    }

    # Passo 1: Copiar arquivos
    Write-InitStep -Number 1 -Title 'Arquivos do pacote' -Description 'Copia workflow, scripts, policy, skill local e sonar-project.properties.'
    $confirm = Request-Step -Message "Deseja copiar arquivos base (.github, scripts, etc.) para o projeto?" -DefaultYes
    if ($confirm -eq 'c') {
        Write-Host "Setup cancelado pelo usuário." -ForegroundColor Red
        return
    }
    if ($confirm -eq 's') {
        $folders = @(".github", "scripts", ".quality-gate")
        if (-not $SkipCodex) {
            $folders += ".codex"
        }
        $existingBaselinePath = Join-Path $ProjectRoot "scripts\baseline.json"
        $existingBaseline = $null
        if (-not $DryRun -and (Test-Path $existingBaselinePath)) {
            $existingBaseline = Get-Content -Raw $existingBaselinePath
        }
        
        foreach ($folder in $folders) {
            $src = Join-Path $TemplateRoot $folder
            $dst = Join-Path $ProjectRoot $folder
            if (Test-Path $src) {
                if ($DryRun) {
                    Write-DryRunPlan "Copiaria pasta $folder para $dst"
                } else {
                    Write-InitItem "Copiando pasta $folder..."
                    if (-not (Test-Path $dst)) {
                        New-Item -ItemType Directory -Path $dst -Force | Out-Null
                    }
                    Copy-Item -Path "$src\*" -Destination $dst -Recurse -Force
                }
            }
        }

        if ($null -ne $existingBaseline) {
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllText($existingBaselinePath, $existingBaseline, $utf8NoBom)
            Write-InitItem "Baseline existente preservado."
        }

        $rootFiles = @("VERSION", "CHANGELOG.md")
        foreach ($file in $rootFiles) {
            $src = Join-Path $TemplateRoot $file
            $dst = Join-Path $ProjectRoot $file
            if (Test-Path $src) {
                if ($DryRun) {
                    Write-DryRunPlan "Copiaria $file para $dst"
                } else {
                    Write-InitItem "Copiando $file..."
                    Copy-Item -Path $src -Destination $dst -Force
                }
            }
        }
        
        # Copia propriedades do Sonar
        $sonarSrc = Join-Path $TemplateRoot "sonar-project.properties"
        $sonarDst = Join-Path $ProjectRoot "sonar-project.properties"
        if (Test-Path $sonarSrc) {
            if ($DryRun) {
                Write-DryRunPlan "Copiaria sonar-project.properties para $sonarDst"
            } else {
                Write-InitItem "Copiando sonar-project.properties..."
                Copy-Item -Path $sonarSrc -Destination $sonarDst -Force
            }
        }
        
        # Remove scripts específicos de administração no destino
        $cleanScripts = @("QualityGate.ps1", "QualityGate.test.ps1")
        foreach ($script in $cleanScripts) {
            $unwanted = Join-Path $ProjectRoot "scripts\$script"
            if (Test-Path $unwanted) {
                if ($DryRun) {
                    Write-DryRunPlan "Removeria script administrativo $unwanted"
                } else {
                    Remove-Item -Path $unwanted -Force
                }
            }
        }
        
        if ($DryRun) {
            Write-Host '    ✓ DryRun: cópia de arquivos simulada.' -ForegroundColor Green
            Add-InitSummary -Step 'Arquivos' -Status 'ok' -Detail 'simulado'
        } else {
            Write-Host '    ✓ Cópia de arquivos concluída.' -ForegroundColor Green
            Add-InitSummary -Step 'Arquivos' -Status 'ok' -Detail 'copiados'
        }

        $configJs = if ($DryRun) { Join-Path $TemplateRoot "scripts\configure-project.cjs" } else { Join-Path $ProjectRoot "scripts\configure-project.cjs" }
        if (Test-Path $configJs) {
            Write-InitItem "Configurando perfil $($projectProfile.Name)..."
            $configArgs = @("--project", $ProjectRoot, "--profile", $projectProfile.Name)
            if (-not $Sonar) {
                $configArgs += "--skip-sonar"
            }
            if ($DryRun) {
                $configArgs += "--dry-run"
            }
            & node $configJs $configArgs
            if ($LASTEXITCODE -ne 0) {
                Add-InitSummary -Step 'Perfil' -Status 'fail' -Detail "configure-project retornou $LASTEXITCODE"
                Write-InitSummary
                Write-Error "Falha ao configurar perfil do projeto."
            }
            Add-InitSummary -Step 'Perfil' -Status 'ok' -Detail $projectProfile.Name
        } else {
            Add-InitSummary -Step 'Perfil' -Status 'warn' -Detail 'configure-project ausente'
        }
    } else {
        Write-InitItem 'Cópia pulada.' 'DarkGray'
        Add-InitSummary -Step 'Arquivos' -Status 'skip' -Detail 'pulado'
    }

    # Passo 2: Configurar .gitignore
    Write-InitStep -Number 2 -Title '.gitignore' -Description 'Ignora estado local e relatórios gerados em .quality-gate/.'
    $confirm = Request-Step -Message "Deseja adicionar os paths do Quality Gate no .gitignore?" -DefaultYes
    if ($confirm -eq 'c') {
        Write-Host "Setup cancelado pelo usuário." -ForegroundColor Red
        return
    }
    if ($confirm -eq 's') {
        $gitignore = Join-Path $ProjectRoot ".gitignore"
        $entries = @(
            ".quality-gate/state.json",
            ".quality-gate/reports/"
        )
        
        if (-not (Test-Path $gitignore)) {
            if ($DryRun) {
                Write-DryRunPlan "Criaria arquivo .gitignore"
                $lines = @()
            } else {
                New-Item -ItemType File -Path $gitignore -Force | Out-Null
                $lines = Get-Content $gitignore -ErrorAction SilentlyContinue
            }
        } else {
            $lines = Get-Content $gitignore -ErrorAction SilentlyContinue
        }
        if ($null -eq $lines) { $lines = @() }
        
        $toAdd = @()
        foreach ($entry in $entries) {
            $exists = $false
            foreach ($line in $lines) {
                if ($line.Trim() -eq $entry) {
                    $exists = $true
                    break
                }
            }
            if (-not $exists) {
                $toAdd += $entry
            }
        }
        
        if ($toAdd.Count -gt 0) {
            if ($DryRun) {
                foreach ($entry in $toAdd) {
                    Write-DryRunPlan "Adicionaria no .gitignore: $entry"
                }
                Write-Host '    ✓ DryRun: .gitignore simulado.' -ForegroundColor Green
                Add-InitSummary -Step 'Gitignore' -Status 'ok' -Detail 'simulado'
            } else {
                $nextLines = @($lines)
                if ($nextLines.Count -gt 0 -and $nextLines[-1] -ne "") {
                    $nextLines += ""
                }
                $nextLines += "# Quality Gate"
                foreach ($entry in $toAdd) {
                    $nextLines += $entry
                    Write-InitItem "Adicionado: $entry"
                }
                $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
                [System.IO.File]::WriteAllText($gitignore, (($nextLines -join "`n") + "`n"), $utf8NoBom)
                Write-Host '    ✓ .gitignore atualizado.' -ForegroundColor Green
                Add-InitSummary -Step 'Gitignore' -Status 'ok' -Detail 'atualizado'
            }
        } else {
            Write-Host '    ✓ .gitignore já configurado.' -ForegroundColor Green
            Add-InitSummary -Step 'Gitignore' -Status 'ok' -Detail 'já configurado'
        }
    } else {
        Write-InitItem 'Atualização de .gitignore pulada.' 'DarkGray'
        Add-InitSummary -Step 'Gitignore' -Status 'skip' -Detail 'pulado'
    }

    # Passo 3: Configurar GitHub via setup.js
    Write-InitStep -Number 3 -Title 'GitHub' -Description 'Configura bootstrap, branch protection, PR ruleset e secrets opcionais.'
    Invoke-GitHubSetupStep

    # Passo 4: Capturar baseline inicial
    Write-InitStep -Number 4 -Title 'Baseline' -Description 'Lê coverage do projeto (Jest ou pytest-cov) e grava scripts/baseline.json.'
    if ($SkipBaseline) {
        Write-InitItem 'Captura de baseline pulada por parâmetro.' 'DarkGray'
        Add-InitSummary -Step 'Baseline' -Status 'skip' -Detail 'pulado por flag'
    } else {
        $confirm = Request-Step -Message "Deseja gerar o baseline de métricas inicial (quality-gate.js init)?" -DefaultYes
        if ($confirm -eq 'c') {
            Write-Host "Setup cancelado pelo usuário." -ForegroundColor Red
            return
        }
        if ($confirm -eq 's') {
            $gateJs = if ($DryRun) { Join-Path $TemplateRoot "scripts\quality-gate.js" } else { Join-Path $ProjectRoot "scripts\quality-gate.js" }
            if (Test-Path $gateJs) {
                Write-InitItem 'Executando quality-gate.js init...'
                $gateArgs = @("init")
                if ($DryRun) {
                    $gateArgs += "--dry-run"
                }
                & node $gateJs $gateArgs
                if ($LASTEXITCODE -ne 0) {
                    Write-Warning "Não foi possível gerar o baseline automático (relatório de coverage ausente?)."
                    if ($projectProfile.Name -eq 'python-uv') {
                        Write-Warning "No TCC/Python: cd pipeline; uv run pytest --basetemp .pytest-tmp-qg -q --cov=src --cov-report=json:../coverage/coverage.json --cov-report=xml:../coverage/coverage.xml --cov-report=term-missing; cd ..; qg-upd"
                    } else {
                        Write-Warning "Em Node: npm run test:coverage:ci; qg-upd"
                    }
                    Add-InitSummary -Step 'Baseline' -Status 'warn' -Detail 'coverage ausente'
                } else {
                    Write-Host '    ✓ Baseline inicial gravado com sucesso.' -ForegroundColor Green
                    Add-InitSummary -Step 'Baseline' -Status 'ok' -Detail $(if ($DryRun) { 'simulado' } else { 'gravado' })
                }
            } else {
                Add-InitSummary -Step 'Baseline' -Status 'fail' -Detail 'quality-gate.js ausente'
                Write-InitSummary
                Write-Error "quality-gate.js não foi encontrado no projeto!"
            }
        } else {
            Write-InitItem 'Captura de baseline pulada.' 'DarkGray'
            Add-InitSummary -Step 'Baseline' -Status 'skip' -Detail 'pulado'
        }
    }

    # Passo 5: Fazer commit inicial
    Write-InitStep -Number 5 -Title 'Commit' -Description 'Stagia arquivos do Quality Gate e cria commit inicial opcional.'
    if ($SkipCommit) {
        Write-InitItem 'Commit pulado por parâmetro.' 'DarkGray'
        Add-InitSummary -Step 'Commit' -Status 'skip' -Detail 'pulado por flag'
    } else {
        $confirm = Request-Step -Message "Deseja commitar as alterações do Quality Gate na branch atual?" -DefaultYes
        if ($confirm -eq 'c') {
            Write-Host "Setup cancelado pelo usuário." -ForegroundColor Red
            return
        }
        if ($confirm -eq 's') {
            if ($DryRun) {
                Write-DryRunPlan "Executaria git add dos arquivos do Quality Gate"
                Write-DryRunPlan "Executaria git commit -m 'chore: configurar Quality Gate'"
                Add-InitSummary -Step 'Commit' -Status 'ok' -Detail 'simulado'
            } elseif (Test-Path (Join-Path $ProjectRoot ".git")) {
                git add .github/ scripts/ .quality-gate/
                if (-not $SkipCodex -and (Test-Path (Join-Path $ProjectRoot ".codex"))) {
                    git add .codex/
                }
                if (Test-Path (Join-Path $ProjectRoot "sonar-project.properties")) {
                    git add sonar-project.properties
                }
                if (Test-Path (Join-Path $ProjectRoot ".gitignore")) {
                    git add .gitignore
                }

                git diff --cached --quiet
                if ($LASTEXITCODE -eq 0) {
                    Write-Warning "Nada staged para commitar."
                    Add-InitSummary -Step 'Commit' -Status 'warn' -Detail 'nada staged'
                } else {
                    git commit -m "chore: configurar Quality Gate"
                    if ($LASTEXITCODE -ne 0) {
                        Add-InitSummary -Step 'Commit' -Status 'fail' -Detail 'git commit falhou'
                        Write-InitSummary
                        Write-Error "Falha ao criar commit automático."
                    }
                    Write-Host '    ✓ Commit efetuado.' -ForegroundColor Green
                    Add-InitSummary -Step 'Commit' -Status 'ok' -Detail 'commit criado'
                }
            } else {
                Write-Warning "Pasta .git não encontrada na raiz. Pulando commit automático."
                Add-InitSummary -Step 'Commit' -Status 'skip' -Detail 'sem .git'
            }
        } else {
            Write-InitItem 'Commit automático pulado.' 'DarkGray'
            Add-InitSummary -Step 'Commit' -Status 'skip' -Detail 'pulado'
        }
    }

    Write-InitSummary
    Write-Host '    ✓ Setup do Quality Gate finalizado.' -ForegroundColor Green
    return
}

if ($Init) {
    Invoke-Init
    return
}

# ── Ações de rotina ───────────────────────────────────────
$doctorJs = Join-Path $ProjectRoot "scripts\doctor.cjs"
$gateJs   = Join-Path $ProjectRoot "scripts\quality-gate.js"

# Extraídas em funções para serem reusadas tanto pelas flags (-Doctor/-Check/-Update/-Report)
# quanto pelo menu interativo (Invoke-QgMenu) sem duplicar o header colorido de cada ação.
function Invoke-DoctorAction {
    if (-not (Test-Path $doctorJs)) {
        Write-Error "O Quality Gate não parece estar instalado na pasta atual (doctor.cjs ausente)."
        return
    }
    Write-Host "🔍 Executando diagnóstico (doctor.cjs --dry-run)..." -ForegroundColor Cyan
    & node $doctorJs --dry-run
}

function Invoke-CheckAction {
    if (-not (Test-Path $gateJs)) {
        Write-Error "O Quality Gate não parece estar instalado na pasta atual (quality-gate.js ausente)."
        return
    }
    Write-Host "⚖️  Comparando métricas com o baseline..." -ForegroundColor Cyan
    & node $gateJs check
}

function Invoke-UpdateAction {
    if (-not (Test-Path $gateJs)) {
        Write-Error "O Quality Gate não parece estar instalado na pasta atual (quality-gate.js ausente)."
        return
    }
    Write-Host "🔄 Atualizando baseline com métricas do projeto atual..." -ForegroundColor Cyan
    & node $gateJs update
}

function Invoke-ReportAction {
    if (-not (Test-Path $gateJs)) {
        Write-Error "O Quality Gate não parece estar instalado na pasta atual (quality-gate.js ausente)."
        return
    }
    Write-Host "📊 Exibindo relatório de qualidade..." -ForegroundColor Cyan
    & node $gateJs report
}

function Invoke-LocalValidateAction {
    $localValidate = Join-Path $ProjectRoot "scripts\local-validate.cjs"
    if (-not (Test-Path $localValidate)) {
        Write-Error "O Quality Gate não parece estar instalado na pasta atual (local-validate.cjs ausente)."
        return
    }
    Write-Host "🧪 Rodando validação local de PR (local-validate.cjs)..." -ForegroundColor Cyan
    & node $localValidate --project $ProjectRoot --profile pr --json
}

if ($Doctor) { Invoke-DoctorAction; return }
if ($Check) { Invoke-CheckAction; return }
if ($Update) { Invoke-UpdateAction; return }
if ($Report) {
    Invoke-ReportAction
    return
}

# Se nenhuma flag de ação for passada, abre o menu interativo (Slice 7)
Invoke-QgMenu
