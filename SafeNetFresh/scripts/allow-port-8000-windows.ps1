# Run in PowerShell as Administrator (right-click -> Run as administrator).
# iPhone hotspot on Windows is almost always "Public" — without this, port 8000 stays blocked from the phone.
# Usage: npm run windows:firewall-api

$ruleName = "SafeNet-API-8000-dev"
netsh advfirewall firewall delete rule name="$ruleName" >$null 2>&1
netsh advfirewall firewall add rule name="$ruleName" dir=in action=allow protocol=TCP localport=8000 profile=any enable=yes
if ($LASTEXITCODE -ne 0) {
  Write-Host "Failed to add firewall rule. Run PowerShell as Administrator."
  exit 1
}

Write-Host "OK: Firewall allows inbound TCP 8000 on all profiles (Private/Public/Domain)."
Write-Host ""

Write-Host "Listening on port 8000 (should show 0.0.0.0 or ::, not only 127.0.0.1):"
Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue |
  Select-Object -First 5 LocalAddress, LocalPort, State |
  Format-Table -AutoSize

Write-Host "Quick test from this PC (should return JSON):"
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:8000/" -UseBasicParsing -TimeoutSec 5
  Write-Host "  http://127.0.0.1:8000/ -> HTTP" $r.StatusCode
} catch {
  Write-Host "  http://127.0.0.1:8000/ FAILED:" $_.Exception.Message
  Write-Host "  Start API from safenet_v2/backend:"
  Write-Host "    python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"
}

Write-Host ""
Write-Host "On the iPhone: open Safari -> http://YOUR_PC_IP:8000/ (same IP Expo shows for Metro)."
Write-Host "If Safari fails too, it is firewall/network. If Safari works but the app fails, try npx expo run:ios or BACKEND_URL_DEV remote."
