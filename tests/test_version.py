from pathlib import Path

from smg import APP_VERSION
from smg.config import APP_VERSION as CONFIG_VERSION

ROOT = Path(__file__).resolve().parents[1]


def test_application_version_is_centralized_in_python():
    assert APP_VERSION == CONFIG_VERSION == "4.9.0"


def test_frontend_does_not_hardcode_historical_app_versions():
    for relative in (
        "frontend/index.html",
        "frontend/chamada-professores.html",
        "frontend/app.min.js",
        "frontend/teacher-bundle.min.js",
    ):
        source = (ROOT / relative).read_text(encoding="utf-8")
        for stale in ("4.6.9", "4.8.0", "4.9.0"):
            assert stale not in source, f"{relative} ainda contém versão fixa {stale}"


def test_server_no_longer_rewrites_frontend_version_strings():
    source = (ROOT / "app.py").read_text(encoding="utf-8")
    assert 'replace("V4.6.9"' not in source
    assert 'data-app-version="4.6.9"' not in source


def test_ci_contains_dependency_static_and_secret_scans():
    workflow = (ROOT / ".github" / "workflows" / "security.yml").read_text(encoding="utf-8")
    assert "pip_audit" in workflow
    assert "bandit" in workflow
    assert "gitleaks/gitleaks-action@v2" in workflow
