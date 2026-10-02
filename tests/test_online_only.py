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
    assert "nativeStorage.removeItem.call(storage, key)" in source
    assert "volatileLocal.clear()" in source
    assert "volatileSession.clear()" in source


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


def test_teacher_attendance_has_no_persistent_offline_queue():
    source = (ROOT / "frontend" / "teacher-bundle.min.js").read_text(encoding="utf-8")
    assert "Modo local de emergência" not in source
    assert "teacher-offline" not in source
    assert "writeJSON(TEACHER_PENDING_KEY" not in source
    assert "Sem fila offline persistente" in source


def test_operational_storage_namespace_is_virtualized_before_app_load():
    source = (ROOT / "frontend" / "python-auth-bridge.js").read_text(encoding="utf-8")
    index = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    assert "Storage.prototype.getItem = function onlineOnlyGetItem" in source
    assert "Storage.prototype.setItem = function onlineOnlySetItem" in source
    assert "purgePersistedSensitiveState();" in source
    assert 'SAFE_PERSISTENT_KEYS' in source
    assert '"arteDeAprenderERP.navigationColors.v2"' in source
    assert index.index("python-auth-bridge.js") < index.index("app.min.js")


def test_pre_app_payment_snapshot_is_not_precached_or_loaded():
    worker = (ROOT / "frontend" / "sw.js").read_text(encoding="utf-8")
    index = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    assert "pre-app-state-guard.js" not in worker
    assert "pre-app-state-guard.js" not in index


def test_security_branch_preserves_latest_main_attendance_and_preregistration_fixes():
    root = ROOT
    state = (root / "smg" / "state.py").read_text(encoding="utf-8")
    sync = (root / "frontend" / "supabase-admin-sync.js").read_text(encoding="utf-8")
    recovery = (root / "frontend" / "pre-registration-recovery-fix.js").read_text(encoding="utf-8")
    app = (root / "frontend" / "app.min.js").read_text(encoding="utf-8")
    worker = (root / "frontend" / "sw.js").read_text(encoding="utf-8")
    index = (root / "frontend" / "index.html").read_text(encoding="utf-8")

    assert "WHERE COALESCE(public.smg_attendance.record->>'updatedAt','')" in state
    assert "const PULL_INTERVAL_MS = 15_000;" in sync
    assert "pullSilent: () => pullNow({ force: true })" in sync
    assert "async function reconcileEnrolledStudents()" in recovery
    assert 'aria-label="Manhã das 08:00 às 12:00">M</button>' in app
    assert "app.min.js?v=469-online2" in worker
    assert "app.min.js?v=469-online2" in index
