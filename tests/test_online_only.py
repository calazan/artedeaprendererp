from pathlib import Path

from smg.auth import login_page

ROOT = Path(__file__).resolve().parents[1]


def test_login_clears_browser_storage_and_cache():
    response = login_page("/")
    assert response.headers["clear-site-data"] == '"cache", "storage"'


def test_auth_bridge_cleans_prefixed_storage_on_logout_and_401():
    source = (ROOT / "frontend" / "python-auth-bridge.js").read_text(encoding="utf-8")
    assert 'const STORAGE_PREFIX = "arteDeAprenderERP."' in source
    assert "response.status === 401" in source
    assert "caches.keys()" in source
    assert "storage.removeItem(key)" in source


def test_service_worker_never_precaches_authenticated_html():
    source = (ROOT / "frontend" / "sw.js").read_text(encoding="utf-8")
    precache = source.split("const PRECACHE = [", 1)[1].split("];", 1)[0]
    assert "index.html" not in precache
    assert '"./",' not in precache
    assert 'event.request.mode === "navigate"' in source
    assert "offlinePage" in source


def test_local_backup_names_are_blocked():
    source = (ROOT / "frontend" / "local-persistence-reliability.js").read_text(encoding="utf-8")
    assert "arteDeAprenderERP.autoBackup." in source
    assert "arteDeAprenderERP.childrenBackup." in source
    assert "_backup_erro_" in source
    assert "if (this === localStorage && isForbiddenBackupKey(key)) return;" in source


def test_preregistration_session_storage_is_id_only():
    admin = (ROOT / "frontend" / "pre-registration-admin.js").read_text(encoding="utf-8")
    recovery = (ROOT / "frontend" / "pre-registration-recovery-fix.js").read_text(encoding="utf-8")
    assert "JSON.stringify({" not in admin[admin.find("PENDING_ENROLLMENT_KEY"):]
    assert "existingStudentId" not in admin[admin.find("PENDING_ENROLLMENT_KEY"):]
    assert "sessionStorage.setItem(PENDING_ENROLLMENT_KEY, String(record.id))" in admin
    assert "sessionStorage.setItem(PENDING_ENROLLMENT_KEY, String(preregistrationId))" in recovery
