$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root 'artifacts'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$installer = Get-ChildItem (Join-Path $root 'dist/*-setup.exe') | Select-Object -First 1
if (-not $installer) { throw '没有找到 Windows 安装包' }
$temporary = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$session = Join-Path $temporary ('OpenAllSmoke-' + [Guid]::NewGuid().ToString('N'))
$install = Join-Path $session 'app'
New-Item -ItemType Directory -Path $session -Force | Out-Null
$report = [ordered]@{ installed = $false; launched = $false; checksPassed = $false; uninstalled = $false }
$process = $null
try {
    # NSIS 要求安装目录参数在最后；测试目录使用唯一名称，避免覆盖已有安装。
    $setup = Start-Process -FilePath $installer.FullName -ArgumentList @('/S', "/D=$install") -Wait -PassThru
    if ($setup.ExitCode -ne 0) { throw "安装器退出码：$($setup.ExitCode)" }
    $executable = Join-Path $install 'OpenAll.exe'
    if (-not (Test-Path $executable)) { throw '安装后未找到 OpenAll.exe' }
    $report.installed = $true
    $env:OPENALL_CI_SMOKE = '1'
    $env:OPENALL_TEST_USER_DATA = Join-Path $session 'data'
    $env:OPENALL_SMOKE_OUTPUT = Join-Path $output 'screens'
    $process = Start-Process -FilePath $executable -PassThru -RedirectStandardOutput (Join-Path $output 'app.log') -RedirectStandardError (Join-Path $output 'app-errors.log')
    $report.launched = $true
    if (-not $process.WaitForExit(240000)) { $process.Kill(); throw '安装后应用检查超时' }
    $process.Refresh()
    $resultPath = Join-Path $output 'screens/report.json'
    if (-not (Test-Path $resultPath)) { throw '应用没有生成检查报告' }
    $result = Get-Content -Raw $resultPath | ConvertFrom-Json
    if (-not $result.passed -or $result.platform -ne 'win32' -or $result.arch -ne 'x64') { throw '应用回归检查失败' }
    if ($process.ExitCode -ne 0) { throw "应用退出码：$($process.ExitCode)" }
    $report.checksPassed = $true
} finally {
    if ($process -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    Remove-Item Env:OPENALL_CI_SMOKE -ErrorAction SilentlyContinue
    Remove-Item Env:OPENALL_TEST_USER_DATA -ErrorAction SilentlyContinue
    Remove-Item Env:OPENALL_SMOKE_OUTPUT -ErrorAction SilentlyContinue
    $uninstaller = Join-Path $install 'Uninstall OpenAll.exe'
    if (Test-Path $uninstaller) {
        # 固定卸载目录使检查等待真实卸载完成，而非只等待临时启动器退出。
        $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$install") -Wait -PassThru
        $report.uninstalled = $uninstall.ExitCode -eq 0 -and -not (Test-Path (Join-Path $install 'OpenAll.exe'))
    }
    $report | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $output 'installer-report.json')
}
if (-not $report.uninstalled) { throw '卸载检查未通过' }
Write-Host 'Windows 安装、启动、工具功能回归与卸载检查通过'
