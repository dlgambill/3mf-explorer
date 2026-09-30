# Send files to the Windows Recycle Bin (recoverable - not a hard delete).
# Paths come in via a UTF8 file, one per line, to sidestep quoting problems.
param([Parameter(Mandatory=$true)][string]$ListFile)
Add-Type -AssemblyName Microsoft.VisualBasic
$ok = 0; $fail = 0
foreach ($line in (Get-Content -LiteralPath $ListFile -Encoding UTF8)) {
  $p = $line.Trim()
  if (-not $p) { continue }
  try {
    if (Test-Path -LiteralPath $p) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
        $p,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
      $ok++
    } else { $fail++ }
  } catch { $fail++ }
}
Write-Output "recycled=$ok failed=$fail"
