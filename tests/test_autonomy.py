from __future__ import annotations

from pathlib import Path

from smg.config import ROOT_DIR, frontend_dir


FORBIDDEN_OPERATIONAL_REFERENCES = (
    "github.com/calazan/smg",
    "raw.githubusercontent.com/calazan/smg",
    "smg-dusky.vercel.app",
)

TEXT_SUFFIXES = {".py", ".js", ".css", ".html", ".json", ".toml", ".txt", ".md", ".yml", ".yaml"}


def operational_text_files():
    roots = [ROOT_DIR / "smg", ROOT_DIR / "frontend", ROOT_DIR / "api", ROOT_DIR / "scripts"]
    top_level = [ROOT_DIR / "app.py", ROOT_DIR / "run.py", ROOT_DIR / "vercel.json", ROOT_DIR / "requirements.txt", ROOT_DIR / "pyproject.toml"]
    for path in top_level:
        if path.is_file():
            yield path
    for root in roots:
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if path.is_file() and path.suffix.lower() in TEXT_SUFFIXES:
                yield path


def test_frontend_is_bundled_locally_in_this_repository():
    frontend = frontend_dir()
    assert frontend == (ROOT_DIR / "frontend").resolve()
    assert frontend.is_dir()
    assert (frontend / "index.html").is_file()
    assert (frontend / "menu-brand.png").is_file()


def test_no_operational_dependency_on_legacy_smg_repository_or_deploy():
    violations: list[str] = []
    for path in operational_text_files():
        text = path.read_text(encoding="utf-8", errors="ignore").lower()
        for forbidden in FORBIDDEN_OPERATIONAL_REFERENCES:
            if forbidden.lower() in text:
                violations.append(f"{path.relative_to(ROOT_DIR)} -> {forbidden}")
    assert not violations, "Dependências legadas encontradas: " + "; ".join(violations)


def test_python_entrypoint_is_local():
    vercel = (ROOT_DIR / "vercel.json").read_text(encoding="utf-8")
    assert '"destination": "/api/index"' in vercel
    api_entrypoint = (ROOT_DIR / "api" / "index.py").read_text(encoding="utf-8")
    assert "from app import app" in api_entrypoint
