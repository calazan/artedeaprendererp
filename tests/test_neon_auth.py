from pathlib import Path

from smg.auth_store import AUTH_SCHEMA_SQL, DUMMY_PASSWORD_HASH, hash_password, verify_password_hash


ROOT = Path(__file__).resolve().parents[1]


def test_password_hash_uses_argon2id_and_verifies():
    encoded = hash_password("UmaSenhaForte#2026")
    assert encoded.startswith("$argon2id$")
    assert verify_password_hash(encoded, "UmaSenhaForte#2026")
    assert not verify_password_hash(encoded, "senha-errada")


def test_auth_schema_contains_required_neon_tables():
    assert "public.organizations" in AUTH_SCHEMA_SQL
    assert "public.app_users" in AUTH_SCHEMA_SQL
    assert "public.organization_members" in AUTH_SCHEMA_SQL
    assert "session_version" in AUTH_SCHEMA_SQL


def test_backend_no_longer_calls_supabase_auth():
    source = (ROOT / "smg" / "auth.py").read_text(encoding="utf-8")
    assert "/auth/v1/token" not in source
    assert "SUPABASE_PUBLISHABLE_KEY" not in source
    assert "httpx.AsyncClient" not in source


def test_bootstrap_script_does_not_accept_password_argument():
    source = (ROOT / "scripts" / "bootstrap_admin.py").read_text(encoding="utf-8")
    assert "--password" not in source
    assert "getpass.getpass" in source
    assert "BOOTSTRAP_ADMIN_PASSWORD" in source


def test_dummy_argon_hash_is_fixed_and_valid_format():
    assert DUMMY_PASSWORD_HASH.startswith("$argon2id$")
    assert not verify_password_hash(DUMMY_PASSWORD_HASH, "qualquer-senha")
