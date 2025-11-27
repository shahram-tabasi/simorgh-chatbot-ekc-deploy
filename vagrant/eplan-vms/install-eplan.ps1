# EPLAN 2024 FULL AUTO INSTALL + CRACK (ISO COPY + NATIVE MOUNT)
$ErrorActionPreference = 'Continue'

$src = 'C:\vagrant\Eplan.Electric.P8.2024.0.3.21408'
$dest = 'C:\EPLAN_Install'
New-Item -ItemType Directory -Path $dest -Force | Out-Null

Write-Host "=== EPLAN 2024 INSTALL START ==="

# 1. COPY ISO TO LOCAL DISK (CRITICAL!)
$isoSrc = "$src\Setup.iso"
$isoDest = "$dest\Setup.iso"
Write-Host "Copying Setup.iso (~6GB) to C:\EPLAN_Install\ ..."
Copy-Item $isoSrc $isoDest -Force

# 2. Block hosts
$blockCmd = "$src\Block Host [ Run Administrator ].cmd"
if (Test-Path $blockCmd) {
    Write-Host "Blocking hosts..."
    Start-Process -FilePath $blockCmd -Verb RunAs -Wait
}

# 3. Mount ISO from LOCAL disk
Write-Host "Mounting ISO from local disk..."
$drive = (Mount-DiskImage -ImagePath $isoDest -PassThru | Get-Volume).DriveLetter + ':'
Write-Host "ISO mounted at $drive"

# 4. Silent install
Write-Host "Installing EPLAN 2024.0.3.21408..."
$setup = "$drive\setup.exe"
if (-not (Test-Path $setup)) { Write-Host "ERROR: setup.exe not found"; exit 1 }
Start-Process -FilePath $setup -ArgumentList '/quiet','/norestart' -Wait

# 5. vcruntime140.dll
$bin = 'C:\Program Files\EPLAN\Platform\2024.0.3\Bin'
$vcruntime = "$src\Crack\vcruntime140.dll"
if (Test-Path $vcruntime) {
    Copy-Item $vcruntime $bin -Force
    Write-Host "vcruntime140.dll replaced"
}

# 6. epl.dll
$eplDest = "$env:PUBLIC\EPLAN\Common"
New-Item -ItemType Directory -Path $eplDest -Force
$eplSrc = "$src\Crack\Users\Public\EPL\epl.dll"
if (Test-Path $eplSrc) {
    Copy-Item $eplSrc $eplDest -Force
    Write-Host "epl.dll copied"
}

# 7. Keygen
$keygen = "$src\Keygen\EPlanKeygen.exe"
$tpl = "$src\Keygen\EPLAN_v2024_License.tpl"
if ((Test-Path $keygen) -and (Test-Path $tpl)) {
    Write-Host "Generating license..."
    Set-Location (Split-Path $keygen)
    & ".\EPlanKeygen.exe" "`"$tpl`"" "Create"
    if (Test-Path ".\lservrc") {
        Move-Item ".\lservrc" "$eplDest\lservrc" -Force
    }
}

# 8. Patch
$patch = "$src\patch\EPlanPatcher.exe"
if (Test-Path $patch) {
    Write-Host "Applying patch..."
    Start-Process -FilePath $patch -ArgumentList '/silent' -Wait
}

# 9. License fix
reg add "HKLM\SOFTWARE\EPLAN\Platform\2024.0.3" /v "ShowAllLicenses" /t REG_DWORD /d 0 /f

# 10. Enable RDP
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name "fDenyTSConnections" -Value 0
Enable-NetFirewallRule -DisplayGroup "Remote Desktop"

Write-Host "=== EPLAN 2024 FULLY INSTALLED & CRACKED ==="
