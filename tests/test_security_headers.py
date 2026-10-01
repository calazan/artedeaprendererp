from pathlib import Path
import re

from fastapi.testclient import TestClient

from app import app
from smg.app import SECURITY_CSP
from smg.auth import login_page

ROOT = Path(__file__).resolve().parents[1]


def test_security_headers_blocking_mode(monkeypatch):
    monkeypatch.delenv("CSP_REPORT_ONLY", raising=False)
    response = TestClient(app).get("/api/python-info")
    assert response.headers["strict-transport-security"] == "max-age=31536000; includeSubDomains"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "same-origin"
    assert response.headers["permissions-policy"] == "camera=(), microphone=(), geolocation=()"
    assert response.headers["content-security-policy"] == SECURITY_CSP
    assert "content-security-policy-report-only" not in response.headers


def test_security_headers_report_only_mode(monkeypatch):
    monkeypatch.setenv("CSP_REPORT_ONLY", "true")
    response = TestClient(app).get("/api/python-info")
    assert response.headers["content-security-policy-report-only"] == SECURITY_CSP
    assert "content-security-policy" not in response.headers


def test_authenticated_html_has_no_inline_javascript():
    html_paths = [
        ROOT / "frontend" / "index.html",
        ROOT / "frontend" / "pre-cadastro.html",
        ROOT / "frontend" / "chamada-professores.html",
        ROOT / "frontend" / "atualizar.html",
    ]
    inline_script = re.compile(r"<script(?![^>]*\bsrc=)[^>]*>", re.I)
    inline_handler = re.compile(r"\son[a-z]+\s*=", re.I)
    for path in html_paths:
        source = path.read_text(encoding="utf-8")
        assert not inline_script.search(source), path
        assert not inline_handler.search(source), path

    login = login_page("/").body.decode("utf-8")
    assert not inline_script.search(login)
    assert not inline_handler.search(login)
    assert "/login-auth.js?v=1" in login


def test_print_templates_do_not_use_inline_event_handlers():
    for relative in (
        "frontend/app.min.js",
        "frontend/receipt-monthly-value-only-fix.js",
        "frontend/zebra-logo-label-fix.js",
        "frontend/extra-event-individual-report-fix.js",
    ):
        source = (ROOT / relative).read_text(encoding="utf-8")
        assert 'onclick="window.print()"' not in source, relative


def test_sensitive_server_data_is_escaped_before_preregistration_html():
    source = (ROOT / "frontend" / "pre-registration-admin.js").read_text(encoding="utf-8")
    for expression in (
        "escapeHTML(data.childName",
        "escapeHTML(data.guardianName",
        "escapeHTML(data.guardianCpf",
        "escapeHTML(healthSummary)",
        "escapeHTML(data.routineDetails",
        "escapeHTML(peopleText(data.authorizedPeople))",
    ):
        assert expression in source
