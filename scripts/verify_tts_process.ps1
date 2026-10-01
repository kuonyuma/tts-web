param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    if (-not $process -or -not $process.ExecutablePath -or -not $process.CommandLine) { exit 1 }
    $project = [IO.Path]::GetFullPath($ProjectRoot)
    $executables = @(
        (Join-Path $project '.venv\Scripts\python.exe'),
        (Join-Path $project '.venv\Scripts\uvicorn.exe')
    )
    if ($process.ExecutablePath -notin $executables) { exit 1 }
    $command = $process.CommandLine
    if ($command -notmatch '(?:^|[\s\\"])uvicorn(?:\.exe)?(?:"|\s|$)' -or
        $command -notmatch '(?:^|\s)app\.main:app(?:\s|$)') { exit 1 }
    $sourceArgument = [regex]::Match($command, '(?:^|\s)--app-dir(?:=|\s+)(?:"([^"]+)"|(\S+))')
    if (-not $sourceArgument.Success) { exit 1 }
    $source = $sourceArgument.Groups[1].Value
    if (-not $source) { $source = $sourceArgument.Groups[2].Value }
    if (-not [IO.Path]::IsPathRooted($source)) { exit 1 }
    $source = [IO.Path]::GetFullPath($source).TrimEnd([char[]]'\/')
    $expectedSource = (Join-Path $project 'src').TrimEnd([char[]]'\/')
    if ($source -ne $expectedSource) { exit 1 }
    exit 0
} catch {
    # Unknown or inaccessible process identity never authorizes a termination.
    exit 1
}
