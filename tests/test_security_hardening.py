from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_dedicated_session_secret_is_documented_and_enforced():
    env_example = (ROOT / ".env.example").read_text(encoding="utf-8")
    auth = (ROOT / "smg" / "auth.py").read_text(encoding="utf-8")
    assert "SESSION_SECRET=" in env_example
    assert "len(raw) < 32" in auth
    assert "SessionConfigurationError" in auth


def test_authentication_rate_limits_are_fail_closed_and_split_by_account_and_ip():
    auth = (ROOT / "smg" / "auth.py").read_text(encoding="utf-8")
    rate_limit = (ROOT / "smg" / "preregistration.py").read_text(encoding="utf-8")
    assert 'f"account-ip:{email}:{client_ip}"' in auth
    assert 'f"ip:{client_ip}"' in auth
    assert auth.count("fail_open=False") >= 2
    assert "fail_open: bool = True" in rate_limit
    assert "return fail_open" in rate_limit


def test_public_preregistration_uses_canonical_ip_and_fail_closed_rate_limit():
    source = (ROOT / "smg" / "routers" / "preregistration.py").read_text(encoding="utf-8")
    assert "from ..auth import get_client_ip" in source
    assert "return get_client_ip(request)" in source
    assert 'namespace="pre-registration-public"' in source
    assert "fail_open=False" in source


def test_vapid_private_key_never_uses_a_temporary_file():
    for relative in ("smg/task_store.py", "smg/push_compat.py"):
        source = (ROOT / relative).read_text(encoding="utf-8")
        assert "NamedTemporaryFile" not in source
        assert "tempfile" not in source
        assert "serialization.Encoding.DER" in source


def test_unexpected_http_500_responses_do_not_echo_raw_exception_text():
    files = (
        "smg/routers/attendance.py",
        "smg/routers/employees.py",
        "smg/routers/health.py",
        "smg/routers/internal_cron.py",
        "smg/routers/preregistration.py",
        "smg/routers/sync.py",
        "smg/routers/tasks.py",
        "smg/routers/whatsapp.py",
    )
    for relative in files:
        source = (ROOT / relative).read_text(encoding="utf-8")
        assert '"error": str(exc) or' not in source, relative
        assert 'return response({"ok": False, "error": str(exc)' not in source, relative
        assert 'return json_response({"ok": False, "error": str(exc)' not in source, relative


def test_manager_restrictions_are_enforced_in_sensitive_routes():
    employees = (ROOT / "smg" / "routers" / "employees.py").read_text(encoding="utf-8")
    sync = (ROOT / "smg" / "routers" / "sync.py").read_text(encoding="utf-8")
    whatsapp = (ROOT / "smg" / "routers" / "whatsapp.py").read_text(encoding="utf-8")
    assert "OWNER_ADMIN_ROLES" in employees
    assert "Permissão insuficiente para excluir funcionários." in employees
    assert "employee_documents_api" in employees and "OWNER_ADMIN_ROLES" in employees
    assert "Permissão insuficiente para sincronização forçada." in sync
    assert "Permissão insuficiente para alterar a configuração do WhatsApp." in whatsapp
