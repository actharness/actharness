while ($true) {
    $line = [Console]::ReadLine()
    if ($null -eq $line) { break }

    $msg = $line | ConvertFrom-Json

    # Snapshot dynamic-assembly count before step (Location='' and not IsDynamic
    # is the .NET 5+ signal for Add-Type -TypeDefinition compiled assemblies).
    $preCount = ([System.AppDomain]::CurrentDomain.GetAssemblies() |
        Where-Object { $_.Location -eq '' -and -not $_.IsDynamic } |
        Measure-Object).Count

    # Build env and path strings for the wrapper script (JSON re-encode as PS hashtable literal)
    $envEntries = ($msg.env.PSObject.Properties | ForEach-Object {
        '$env_' + [System.Text.RegularExpressions.Regex]::Replace($_.Name, '[^A-Za-z0-9_]', '_') + ' unused'
    })

    $lineCount = if ($msg.coverage) { (Get-Content $msg.scriptPath).Length } else { 0 }

    $escapedScript  = $msg.scriptPath  -replace "'", "''"
    $escapedStdout  = $msg.stdoutPath  -replace "'", "''"
    $escapedStderr  = $msg.stderrPath  -replace "'", "''"
    $escapedCwd     = $msg.cwd         -replace "'", "''"

    # Serialize env as a PS hashtable literal embedded in the wrapper string
    $envPairs = ($msg.env.PSObject.Properties | ForEach-Object {
        $k = $_.Name  -replace "'", "''"
        $v = $_.Value -replace "'", "''"
        "    '$k' = '$v'"
    }) -join "`n"

    $wrapperScript = @"
`$_envMap = @{
$envPairs
}
[System.Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process).Keys |
    ForEach-Object { [System.Environment]::SetEnvironmentVariable(`$_, `$null) }
foreach (`$_pair in `$_envMap.GetEnumerator()) {
    [System.Environment]::SetEnvironmentVariable(`$_pair.Key, `$_pair.Value)
}

Set-Location '$escapedCwd'
`$global:LASTEXITCODE = 0

`$_hits = @{}
`$_lineCount = $lineCount
if (`$_lineCount -gt 0) {
    for (`$_ln = 1; `$_ln -le `$_lineCount; `$_ln++) {
        `$_capturedLn = `$_ln
        Set-PSBreakpoint -Script '$escapedScript' -Line `$_ln -Action {
            `$_k = [string]`$_capturedLn
            if (`$_hits.ContainsKey(`$_k)) { `$_hits[`$_k]++ } else { `$_hits[`$_k] = 1 }
        }.GetNewClosure() | Out-Null
    }
}

`$_code = 0
try {
    `$ErrorActionPreference = 'Stop'
    . '$escapedScript' *> '$escapedStdout' 3>> '$escapedStderr' 2>> '$escapedStderr'
    `$_code = if (`$LASTEXITCODE) { `$LASTEXITCODE } else { 0 }
} catch {
    `$_code = if (`$LASTEXITCODE) { `$LASTEXITCODE } else { 1 }
} finally {
    `$ErrorActionPreference = 'Continue'
}

if (`$_lineCount -gt 0) { Get-PSBreakpoint | Remove-PSBreakpoint }

[pscustomobject]@{ ExitCode = `$_code; Hits = `$_hits }
"@

    $rs = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
    $rs.Open()
    $ps = [System.Management.Automation.PowerShell]::Create()
    $ps.Runspace = $rs
    $ps.AddScript($wrapperScript) | Out-Null

    $stepResult = $ps.Invoke()

    $ps.Dispose()
    $rs.Close()
    $rs.Dispose()

    $exitCode = if ($stepResult.Count -gt 0) { $stepResult[0].ExitCode } else { 1 }
    $hits     = if ($stepResult.Count -gt 0) { $stepResult[0].Hits } else { $null }

    $coverageJson = if ($msg.coverage -and $hits -and $hits.Count -gt 0) {
        $hits | ConvertTo-Json -Compress -Depth 1
    } else { '{}' }

    $postCount = ([System.AppDomain]::CurrentDomain.GetAssemblies() |
        Where-Object { $_.Location -eq '' -and -not $_.IsDynamic } |
        Measure-Object).Count

    $addTypeDetected = ($postCount -gt $preCount).ToString().ToLower()

    [Console]::WriteLine("__ACTHARNESS_DONE__$exitCode $coverageJson $addTypeDetected")
}
