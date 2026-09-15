<#
    Publish the address of a local Ollama to a GitHub gist, so Veil can find it.

    A Cloudflare quick tunnel gets a new address every time it starts, which
    would otherwise mean editing Veil's settings every morning. This starts the
    tunnel, reads the address out of its output, writes that address into a
    gist, and leaves the tunnel running. Veil reads the gist.

    Veil only ever reads the gist, and reads it unauthenticated. The token here
    is used by this script alone, to write.

    Usage:

        $env:GITHUB_TOKEN = 'ghp_...'          # a token with the `gist` scope
        .\publish-ai-endpoint.ps1 -GistId dd9367f161b28ac2c1beeba90a3e15c3

    Leave it running. Ctrl+C stops the tunnel.
#>

[CmdletBinding()]
param(
    # The gist to write into. Create it once at https://gist.github.com; its id
    # is the last part of its address.
    [Parameter(Mandatory = $true)]
    [string] $GistId,

    # Where Ollama is listening on this machine.
    [string] $Local = 'http://localhost:11434',

    # The file inside the gist to write. Any name; Veil reads whichever file
    # holds an address.
    [string] $FileName = 'veil-ai-endpoint.txt',

    # A token with the `gist` scope. Defaults to $env:GITHUB_TOKEN.
    [string] $Token = $env:GITHUB_TOKEN,

    # cloudflared, if it is not on PATH.
    [string] $Cloudflared = 'cloudflared'
)

$ErrorActionPreference = 'Stop'

if (-not $Token) {
    throw "No token. Set `$env:GITHUB_TOKEN to a GitHub token with the 'gist' scope, or pass -Token."
}

function Write-Gist {
    param([string] $Address)

    $body = @{
        files = @{ $FileName = @{ content = "$Address`n" } }
    } | ConvertTo-Json -Depth 5

    $headers = @{
        Authorization          = "Bearer $Token"
        Accept                 = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent'           = 'veil-publish-ai-endpoint'
    }

    Invoke-RestMethod -Method Patch -Uri "https://api.github.com/gists/$GistId" `
        -Headers $headers -Body $body -ContentType 'application/json' | Out-Null
}

# Is Ollama actually up? Saying so now beats a tunnel to nothing.
try {
    Invoke-RestMethod -Uri "$Local/api/tags" -TimeoutSec 5 | Out-Null
    Write-Host "Ollama is answering on $Local"
} catch {
    Write-Warning "Nothing answered on $Local - start Ollama first, or pass -Local."
}

Write-Host "Starting a tunnel to $Local ..."

# cloudflared prints the address on stderr, so both streams are merged and read
# line by line as they arrive.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Cloudflared
$psi.Arguments = "tunnel --url $Local --no-autoupdate"
$psi.RedirectStandardError = $true
$psi.RedirectStandardOutput = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

$proc = [System.Diagnostics.Process]::Start($psi)

$published = $false

try {
    while (-not $proc.HasExited) {
        $line = $proc.StandardError.ReadLine()
        if ($null -eq $line) { $line = $proc.StandardOutput.ReadLine() }
        if ($null -eq $line) { Start-Sleep -Milliseconds 100; continue }

        if (-not $published -and $line -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
            $address = $Matches[0]
            Write-Gist -Address $address
            $published = $true

            Write-Host ''
            Write-Host "  Address : $address"
            Write-Host "  Gist    : https://gist.github.com/$GistId"
            Write-Host ''
            Write-Host 'Written to the gist. Veil will pick it up within five minutes, or'
            Write-Host 'immediately if you press Test in Settings > Search > Short answer.'
            Write-Host ''
            Write-Host 'Leave this window open. Ctrl+C stops the tunnel.'
        }
    }
} finally {
    if (-not $proc.HasExited) {
        Write-Host 'Stopping the tunnel...'
        $proc.Kill()
    }
}
