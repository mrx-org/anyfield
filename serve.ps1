$ErrorActionPreference = "Stop"

Write-Host "Starting static server on http://localhost:8000" -ForegroundColor Cyan
python -u -m http.server 8000





