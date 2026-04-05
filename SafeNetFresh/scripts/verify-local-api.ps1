# No admin needed. Run while uvicorn is up. Confirms API answers on localhost.
# Usage: npm run verify:api
$ErrorActionPreference = "Stop"
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:8000/" -UseBasicParsing -TimeoutSec 8
  Write-Host "OK: API responded HTTP" $r.StatusCode "from http://127.0.0.1:8000/"
  exit 0
} catch {
  Write-Host "FAIL: Nothing answered on http://127.0.0.1:8000/"
  Write-Host "  Fix: cd to backend folder, then:"
  Write-Host "    python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"
  exit 1
}
