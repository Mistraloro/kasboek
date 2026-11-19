# Starts the Kasboek UI spike, reads its window with Microsoft UI Automation (what Narrator, NVDA and JAWS read on Windows),
# prints the tree, and checks that the controls a screen reader user needs are there, focusable and invokable.
#
#   & .\uia-dump.ps1 -Exe .\kasboek-ui-spike.exe -Screen lock-hello `
#       -Require 'Unlock with Windows Hello','Forgot password','Erase data' -OutFile uia-lock-hello.txt
# (call it from PowerShell: `powershell -File` would pass a list as one string)
#
# Windows PowerShell 5.1 (System.Windows.Automation is .NET Framework). Names are matched as "starts with", so the
# question mark in "Forgot password?" is not needed.
# Exit code: 0 all checks passed; 1 a required control is missing or not focusable/invokable; 3 UI Automation did not see
# the window at all (for example a runner without an interactive desktop), which is informational, not a finding.
param(
    [Parameter(Mandatory)] [string] $Exe,
    [Parameter(Mandatory)] [string] $Screen,
    # Controls that must be keyboard focusable and invokable (Invoke, SelectionItem or Toggle pattern).
    [string[]] $Require = @(),
    # Name of an edit field that must be keyboard focusable (the password field of lock-password).
    [string] $RequireEdit = '',
    [string] $OutFile = "uia-$Screen.txt",
    # How long the app keeps its window open (it closes itself after this).
    [int] $HoldMs = 30000,
    # Tab presses for the focus-order walk; 0 skips it.
    [int] $TabCount = 14
)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
$ErrorActionPreference = 'Stop'
$lines = New-Object System.Collections.Generic.List[string]
function Say([string] $text) { $lines.Add($text); Write-Host $text }
function Finish([int] $code) {
    Set-Content -Path $OutFile -Value $lines -Encoding UTF8
    exit $code
}
function ShortPatterns($element) {
    $names = @()
    foreach ($p in $element.GetSupportedPatterns()) {
        $names += ($p.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', '')
    }
    return $names
}
function IsActionable($element) {
    $patterns = ShortPatterns $element
    return ($element.Current.IsKeyboardFocusable -and
        ($patterns -contains 'Invoke' -or $patterns -contains 'SelectionItem' -or $patterns -contains 'Toggle'))
}

Say "UI Automation dump of the Kasboek UI spike, screen $Screen"
Say ("Machine: {0}, {1}, session {2}, interactive={3}" -f $env:COMPUTERNAME, [Environment]::OSVersion.VersionString, $env:SESSIONNAME, [Environment]::UserInteractive)

$proc = Start-Process -FilePath $Exe -ArgumentList @('--screen', $Screen, '--exit-after-ms', "$HoldMs") -PassThru
$root = [System.Windows.Automation.AutomationElement]::RootElement
$window = $null
for ($i = 0; $i -lt 40 -and -not $window; $i++) {
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) { break }
    $byProcess = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
    $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $byProcess)
}
if (-not $window) {
    Say "RESULT: informational. UI Automation did not find a window of process $($proc.Id) after 20 s (process exited: $($proc.HasExited))."
    Say "Top-level windows UI Automation can see here:"
    foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        Say ("  '{0}' ({1})" -f $w.Current.Name, $w.Current.ClassName)
    }
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    Finish 3
}
Start-Sleep -Milliseconds 1500   # the first tree is sent when the first client asks; give the app time to answer and settle

# ---- the tree ----
Say ""
Say "Window '$($window.Current.Name)' (process $($proc.Id)). Per element: ControlType 'Name' [AutomationId] focusable=... patterns"
$all = New-Object System.Collections.Generic.List[object]
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
function Walk($element, [int] $depth) {
    if ($depth -gt 14 -or $all.Count -gt 600) { return }
    $c = $element.Current
    $type = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    $patterns = ShortPatterns $element
    $all.Add([pscustomobject]@{ Type = $type; Name = $c.Name; Focusable = $c.IsKeyboardFocusable; Patterns = $patterns; Element = $element })
    Say ("{0}{1} '{2}' [{3}] focusable={4} patterns={5}{6}" -f ('  ' * $depth), $type, $c.Name, $c.AutomationId, $c.IsKeyboardFocusable, ($patterns -join '/'), $(if (-not $c.IsEnabled) { ' DISABLED' } else { '' }))
    $child = $walker.GetFirstChild($element)
    while ($child) {
        Walk $child ($depth + 1)
        $child = $walker.GetNextSibling($child)
    }
}
Walk $window 0
Say "$($all.Count) elements."

# ---- checks ----
Say ""
$failures = @()
foreach ($name in $Require) {
    $hit = $all | Where-Object { $_.Name -like "$name*" -and $_.Type -ne 'Text' } | Select-Object -First 1
    if (-not $hit) {
        $failures += "MISSING: no control named '$name'"
    } elseif (-not (IsActionable $hit.Element)) {
        $failures += "NOT ACTIONABLE: '$($hit.Name)' ($($hit.Type)) focusable=$($hit.Focusable) patterns=$($hit.Patterns -join '/')"
    } else {
        Say "ok: '$($hit.Name)' is $($hit.Type), focusable, $($hit.Patterns -join '/')"
    }
}
if ($RequireEdit) {
    $hit = $all | Where-Object { $_.Type -eq 'Edit' -and $_.Name -like "$RequireEdit*" } | Select-Object -First 1
    if (-not $hit) { $failures += "MISSING: no edit field named '$RequireEdit'" }
    elseif (-not $hit.Focusable) { $failures += "NOT FOCUSABLE: edit field '$($hit.Name)'" }
    else { Say "ok: edit field '$($hit.Name)' is focusable" }
}

# ---- Tab order (best effort: needs the window in the foreground of an interactive desktop) ----
if ($TabCount -gt 0) {
    Say ""
    Say "Tab walk (SendKeys), focused element after each press:"
    $reached = @()
    try {
        [void][System.Windows.Forms.Application]::EnableVisualStyles()
        $window.SetFocus()
        Start-Sleep -Milliseconds 500
        for ($n = 1; $n -le $TabCount; $n++) {
            [System.Windows.Forms.SendKeys]::SendWait('{TAB}')
            Start-Sleep -Milliseconds 400
            $f = [System.Windows.Automation.AutomationElement]::FocusedElement
            $label = "{0} '{1}'" -f ($f.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''), $f.Current.Name
            Say ("  Tab {0}: {1} (process {2})" -f $n, $label, $f.Current.ProcessId)
            if ($f.Current.ProcessId -eq $proc.Id) { $reached += $f.Current.Name }
        }
        foreach ($name in $Require) {
            if (-not ($reached | Where-Object { $_ -like "$name*" })) { Say "TAB (informational): '$name' was not reached in $TabCount presses" }
        }
        if ($reached.Count -eq 0) { Say "TAB (informational): focus never reached the app window; no interactive desktop or the window cannot take the foreground." }
    } catch {
        Say "TAB (informational): the walk failed: $($_.Exception.Message)"
    }
}

if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
Say ""
if ($failures.Count -gt 0) {
    foreach ($f in $failures) { Say "FAIL: $f" }
    Say "RESULT: FAILED"
    Finish 1
}
Say "RESULT: passed"
Finish 0
