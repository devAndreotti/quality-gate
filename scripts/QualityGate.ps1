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
    [switch]$DryRun,
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
    Write-Host '    -DryRun             -               executa em modo demonstracao' -ForegroundColor Gray
    Write-Host '    -Repo <owner/repo>  -               forca repositorio especifico' -ForegroundColor Gray
    Write-Host ''
    Write-Host '  uso: qg-init | qg-chk | qg-upd | qg-doc | qg-rpt' -ForegroundColor DarkGray
    Write-Host '  atalhos: qg-init [-Sonar] [-SkipCodex] [-SkipBaseline] [-SkipCommit] [-DryRun] [-Repo <slug>]' -ForegroundColor DarkGray
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
    Write-Host "  [DryRun] $Message" -ForegroundColor DarkGray
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
    return Confirm-Step -Message $Message -DefaultYes:$DefaultYes
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
if ($Init) {
    Write-Host "🏁 Iniciando setup interativo do Quality Gate em: $ProjectRoot" -ForegroundColor Cyan
    Write-Host "Template base: $TemplateRoot" -ForegroundColor DarkGray
    if ($DryRun) {
        Write-Host "Modo DryRun ativo: nenhuma escrita, commit ou chamada mutável será feita." -ForegroundColor Yellow
    }

    # Passo 1: Copiar arquivos
    Write-Host "`n[Passo 1/5] Copiar arquivos do Quality Gate" -ForegroundColor Yellow
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
        
        foreach ($folder in $folders) {
            $src = Join-Path $TemplateRoot $folder
            $dst = Join-Path $ProjectRoot $folder
            if (Test-Path $src) {
                if ($DryRun) {
                    Write-DryRunPlan "Copiaria pasta $folder para $dst"
                } else {
                    Write-Host "  Copiando pasta $folder..." -ForegroundColor Gray
                    if (-not (Test-Path $dst)) {
                        New-Item -ItemType Directory -Path $dst -Force | Out-Null
                    }
                    Copy-Item -Path "$src\*" -Destination $dst -Recurse -Force
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
                Write-Host "  Copiando sonar-project.properties..." -ForegroundColor Gray
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
            Write-Host "✓ DryRun: cópia de arquivos simulada." -ForegroundColor Green
        } else {
            Write-Host "✓ Cópia de arquivos concluída." -ForegroundColor Green
        }
    } else {
        Write-Host "Cópia pulada." -ForegroundColor DarkGray
    }

    # Passo 2: Configurar .gitignore
    Write-Host "`n[Passo 2/5] Atualizar .gitignore" -ForegroundColor Yellow
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
                Write-Host "✓ DryRun: .gitignore simulado." -ForegroundColor Green
            } else {
                # Garante que termine com newline
                if ($lines.Count -gt 0 -and $lines[-1] -ne "") {
                    Add-Content -Path $gitignore -Value ""
                }
                Add-Content -Path $gitignore -Value "# Quality Gate"
                foreach ($entry in $toAdd) {
                    Add-Content -Path $gitignore -Value $entry
                    Write-Host "  Adicionado: $entry" -ForegroundColor Gray
                }
                Write-Host "✓ .gitignore atualizado." -ForegroundColor Green
            }
        } else {
            Write-Host "✓ .gitignore já configurado." -ForegroundColor Green
        }
    } else {
        Write-Host "Atualização de .gitignore pulada." -ForegroundColor DarkGray
    }

    # Passo 3: Configurar GitHub via setup.js
    Write-Host "`n[Passo 3/5] Configurar GitHub (Proteção de branch e Secrets)" -ForegroundColor Yellow
    $confirm = Request-Step -Message "Deseja rodar o script de setup do GitHub (setup.js)?" -DefaultYes
    if ($confirm -eq 'c') {
        Write-Host "Setup cancelado pelo usuário." -ForegroundColor Red
        return
    }
    if ($confirm -eq 's') {
        $token = $null
        if ($DryRun) {
            Write-DryRunPlan "Não leria token do GitHub; setup.js rodará com --dry-run"
        } else {
            $token = (gh auth token 2>$null)
            if ([string]::IsNullOrWhiteSpace($token)) {
                Write-Warning "Aviso: Não logado no gh CLI ou gh não encontrado. Verificando GITHUB_TOKEN no ambiente."
                $token = $env:GITHUB_TOKEN
            }

            if ([string]::IsNullOrWhiteSpace($token)) {
                $tokenInput = Read-Host "Insira o token do GitHub manualmente (ou dê Enter para pular esta etapa)"
                if (-not [string]::IsNullOrWhiteSpace($tokenInput)) {
                    $token = $tokenInput.Trim()
                }
            }
        }
        
        if ($DryRun -or -not [string]::IsNullOrWhiteSpace($token)) {
            if (-not $DryRun) {
                $env:GITHUB_TOKEN = $token
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
                $sonarToken = Read-Host "Insira o Token do SonarCloud"
                if ($sonarOrg) { $setupArgs += "--sonar-org=$sonarOrg" }
                if ($sonarToken) { $setupArgs += "--sonar-token=$sonarToken" }
            }
            
            $setupJs = Join-Path $ProjectRoot "scripts\setup.js"
            if ($DryRun -and -not (Test-Path $setupJs)) {
                $setupJs = Join-Path $TemplateRoot "scripts\setup.js"
            }
            if (Test-Path $setupJs) {
                Write-Host "  Executando setup.js..." -ForegroundColor Gray
                & node $setupJs $setupArgs
                if ($LASTEXITCODE -ne 0) {
                    Write-Error "Falha ao executar o setup.js (código de retorno: $LASTEXITCODE)."
                } else {
                    Write-Host "✓ GitHub configurado com sucesso." -ForegroundColor Green
                }
            } else {
                Write-Error "setup.js não foi encontrado no projeto!"
            }
        } else {
            Write-Warning "Ignorando configuração do GitHub: GITHUB_TOKEN não fornecido."
        }
    } else {
        Write-Host "Setup do GitHub pulado." -ForegroundColor DarkGray
    }

    # Passo 4: Capturar baseline inicial
    Write-Host "`n[Passo 4/5] Capturar baseline inicial das métricas" -ForegroundColor Yellow
    if ($SkipBaseline) {
        Write-Host "Captura de baseline pulada por parâmetro." -ForegroundColor DarkGray
    } else {
        $confirm = Request-Step -Message "Deseja gerar o baseline de métricas inicial (quality-gate.js init)?" -DefaultYes
        if ($confirm -eq 'c') {
            Write-Host "Setup cancelado pelo usuário." -ForegroundColor Red
            return
        }
        if ($confirm -eq 's') {
            $gateJs = Join-Path $ProjectRoot "scripts\quality-gate.js"
            if ($DryRun -and -not (Test-Path $gateJs)) {
                $gateJs = Join-Path $TemplateRoot "scripts\quality-gate.js"
            }
            if (Test-Path $gateJs) {
                Write-Host "  Executando quality-gate.js init..." -ForegroundColor Gray
                $gateArgs = @("init")
                if ($DryRun) {
                    $gateArgs += "--dry-run"
                }
                & node $gateJs $gateArgs
                if ($LASTEXITCODE -ne 0) {
                    Write-Warning "Não foi possível gerar o baseline automático (relatório de coverage ausente?)."
                    Write-Warning "Gere o coverage do seu projeto primeiro (npm run test:coverage:ci) e depois rode 'qg-upd'."
                } else {
                    Write-Host "✓ Baseline inicial gravado com sucesso." -ForegroundColor Green
                }
            } else {
                Write-Error "quality-gate.js não foi encontrado no projeto!"
            }
        } else {
            Write-Host "Captura de baseline pulada." -ForegroundColor DarkGray
        }
    }

    # Passo 5: Fazer commit inicial
    Write-Host "`n[Passo 5/5] Realizar commit automático" -ForegroundColor Yellow
    if ($SkipCommit) {
        Write-Host "Commit pulado por parâmetro." -ForegroundColor DarkGray
    } else {
        $confirm = Request-Step -Message "Deseja commitar as alterações do Quality Gate na branch atual?" -DefaultYes
        if ($confirm -eq 'c') {
            Write-Host "Setup cancelado pelo usuário." -ForegroundColor Red
            return
        }
        if ($confirm -eq 's') {
            if ($DryRun) {
                Write-DryRunPlan "Executaria git add dos arquivos do Quality Gate"
                Write-DryRunPlan "Executaria git commit -m 'chore: setup Quality Gate'"
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
                
                git commit -m "chore: setup Quality Gate"
                Write-Host "✓ Commit efetuado." -ForegroundColor Green
            } else {
                Write-Warning "Pasta .git não encontrada na raiz. Pulando commit automático."
            }
        } else {
            Write-Host "Commit automático pulado." -ForegroundColor DarkGray
        }
    }

    Write-Host "`n🎉 Setup do Quality Gate finalizado com sucesso no projeto!" -ForegroundColor Green
    return
}

# ── Ações de rotina ───────────────────────────────────────
$doctorJs = Join-Path $ProjectRoot "scripts\doctor.cjs"
$gateJs   = Join-Path $ProjectRoot "scripts\quality-gate.js"

if ($Doctor) {
    if (-not (Test-Path $doctorJs)) {
        Write-Error "O Quality Gate não parece estar instalado na pasta atual (doctor.cjs ausente)."
        return
    }
    Write-Host "🔍 Executando diagnóstico (doctor.cjs --dry-run)..." -ForegroundColor Cyan
    & node $doctorJs --dry-run
    return
}

if ($Check) {
    if (-not (Test-Path $gateJs)) {
        Write-Error "O Quality Gate não parece estar instalado na pasta atual (quality-gate.js ausente)."
        return
    }
    Write-Host "⚖️  Comparando métricas com o baseline..." -ForegroundColor Cyan
    & node $gateJs check
    return
}

if ($Update) {
    if (-not (Test-Path $gateJs)) {
        Write-Error "O Quality Gate não parece estar instalado na pasta atual (quality-gate.js ausente)."
        return
    }
    Write-Host "🔄 Atualizando baseline com métricas do projeto atual..." -ForegroundColor Cyan
    & node $gateJs update
    return
}

if ($Report) {
    if (-not (Test-Path $gateJs)) {
        Write-Error "O Quality Gate não parece estar instalado na pasta atual (quality-gate.js ausente)."
        return
    }
    Write-Host "📊 Exibindo relatório de qualidade..." -ForegroundColor Cyan
    & node $gateJs report
    return
}

# Se nenhuma flag de ação ou se -Help for passado, exibe a ajuda
Show-Help
