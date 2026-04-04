# Start API: run from anywhere — script sets cwd to backend/ (required for `import app`).
Set-Location $PSScriptRoot
$env:PYTHONPATH = $PSScriptRoot
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload --reload-dir app
