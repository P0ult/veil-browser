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

if ($Token -eq 'ghp_yourtokenhere' -or $Token -match '^ghp_your') {
    throw "That is the example token, not a real one. Make one at github.com > Settings > Developer settings > Personal access tokens > Tokens (classic), tick only 'gist', then: `$env:GITHUB_TOKEN = 'ghp_...'"
}

$script:Headers = @{
    Authorization          = "Bearer $Token"
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'           = 'veil-publish-ai-endpoint'
}

<#
    Turn whatever GitHub said into something worth reading. A 401 here means
    one of three things and the message should say which, rather than leaving
    somebody to read a stack trace.
#>
function Get-GitHubReason {
    param($ErrorRecord)

    $status = $null
    try { $status = [int]$ErrorRecord.Exception.Response.StatusCode } catch { }

    switch ($status) {
        401 { return "401 Unauthorized - the token is wrong, expired, or lacks the 'gist' scope." }
        403 { return '403 Forbidden - the token is valid but not allowed to write this gist.' }
        404 { return "404 Not Found - no gist with that id, or it belongs to another account." }
        default {
            if ($status) { return "$status from GitHub." }
            return $ErrorRecord.Exception.Message
        }
    }
}

<# Can this token write this gist? Asked before the tunnel starts, so a bad
   token costs a second rather than a started-and-killed tunnel. #>
function Test-GistAccess {
    try {
        $gist = Invoke-RestMethod -Method Get -Uri "https://api.github.com/gists/$GistId" -Headers $script:Headers
    } catch {
        throw "Cannot read the gist: $(Get-GitHubReason $_)"
    }

    if (-not $gist.owner) {
        Write-Warning 'The gist has no owner in the response; writing may fail.'
        return
    }

    try {
        $me = Invoke-RestMethod -Method Get -Uri 'https://api.github.com/user' -Headers $script:Headers
    } catch {
        throw "The token was refused: $(Get-GitHubReason $_)"
    }

    if ($gist.owner.login -ne $me.login) {
        throw "That gist belongs to $($gist.owner.login), and the token is $($me.login)'s. Only the owner can write it."
    }

    Write-Host "Token accepted for $($me.login), gist is writable."
}

<#
    Write the address, and leave exactly one address behind.

    A gist can hold several files, and GitHub hands them back in name order
    rather than in the order they were written - so a gist filled in by hand as
    `gistfile1.txt` and then written by this script as `veil-ai-endpoint.txt`
    holds two addresses, of which the stale one sorts first. Veil prefers the
    file this script writes, but the tidy thing is not to leave the other one
    lying there at all.

    Only files whose whole content is an address are removed. Anything else in
    the gist is somebody's notes and is left alone.
#>
function Write-Gist {
    param([string] $Address)

    $files = @{ $FileName = @{ content = "$Address`n" } }

    try {
        $current = Invoke-RestMethod -Method Get -Uri "https://api.github.com/gists/$GistId" -Headers $script:Headers
        foreach ($name in $current.files.PSObject.Properties.Name) {
            if ($name -eq $FileName) { continue }
            $content = $current.files.$name.content
            if ($content -and $content.Trim() -match '^https?://[^\s]+$') {
                # A stale address in another file: remove it, so the gist holds
                # one address and there is nothing to read the wrong one from.
                $files[$name] = $null
                Write-Host "  Removing a stale address from $name"
            }
        }
    } catch {
        # Not worth failing the publish over; the preferred file still wins.
    }

    $body = @{ files = $files } | ConvertTo-Json -Depth 5

    Invoke-RestMethod -Method Patch -Uri "https://api.github.com/gists/$GistId" `
        -Headers $script:Headers -Body $body -ContentType 'application/json' | Out-Null
}

# Before anything is started: is the token any good, and is the gist ours to
# write? Both are one request, and finding out now beats finding out after a
# tunnel has been opened.
Test-GistAccess

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

            # A tunnel that is up is worth keeping even if the gist write
            # fails: the address can be pasted into Veil by hand, and killing
            # the tunnel over a bad token helps nobody.
            try {
                Write-Gist -Address $address
                $published = $true

                Write-Host ''
                Write-Host "  Address : $address"
                Write-Host "  Gist    : https://gist.github.com/$GistId"
                Write-Host ''
                Write-Host 'Written to the gist. Veil will pick it up within five minutes, or'
                Write-Host 'immediately if you press Test in Settings > Search > Short answer.'
            } catch {
                Write-Warning "The tunnel is up but the gist was not written: $(Get-GitHubReason $_)"
                Write-Host ''
                Write-Host "  Address : $address"
                Write-Host ''
                Write-Host 'Paste that into Veil: Settings > Search > Short answer > Address.'
            }

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
