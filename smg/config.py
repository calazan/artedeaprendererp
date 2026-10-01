from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from . import APP_VERSION

ROOT_DIR = Path(__file__).resolve().parent.parent
# Identificador fixado após auditoria; uma variável antiga não pode redirecionar o banco
# nem o endpoint que recebe credenciais de login.
EXPECTED_SUPABASE_REF = str(os.getenv("SUPABASE_PROJECT_REF", "")).strip()
DEFAULT_SUPABASE_URL = f"https://{EXPECTED_SUPABASE_REF}.supabase.co" if EXPECTED_SUPABASE_REF else ""
# A chave publicável deve ser fornecida somente pelo ambiente do novo projeto.
DEFAULT_PUBLISHABLE_KEY = ""


def _truthy_env(name: str) -> bool:
    return bool(str(os.getenv(name, "")).strip())


def normalize_database_url(raw: str = "", *, force_transaction_mode: bool = False) -> str:
    value = str(raw or "").strip()
    if not value:
        return ""
    try:
        parts = urlsplit(value)
        query = dict(parse_qsl(parts.query, keep_blank_values=True))
        for key in (
            "sslmode",
            "sslcert",
            "sslkey",
            "sslrootcert",
            "uselibpqcompat",
            "pgbouncer",
            "connection_limit",
        ):
            query.pop(key, None)

        hostname = parts.hostname or ""
        port = parts.port
        if force_transaction_mode and hostname.endswith("pooler.supabase.com"):
            port = 6543

        userinfo = ""
        if parts.username:
            userinfo = parts.username
            if parts.password is not None:
                userinfo += f":{parts.password}"
            userinfo += "@"

        host = hostname
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        netloc = f"{userinfo}{host}"
        if port:
            netloc += f":{port}"

        query["application_name"] = "arte-de-aprender-python"
        return urlunsplit((parts.scheme, netloc, parts.path, urlencode(query), parts.fragment))
    except Exception:
        return value


def database_url() -> str:
    # URL preparada para serverless > URL pooled > NON_POOLING > SUPABASE_DB_URL.
    pooled = str(os.getenv("POSTGRES_PRISMA_URL") or os.getenv("POSTGRES_URL") or "").strip()
    if pooled:
        return normalize_database_url(pooled, force_transaction_mode=True)
    return normalize_database_url(
        os.getenv("POSTGRES_URL_NON_POOLING")
        or os.getenv("SUPABASE_DB_URL")
        or ""
    )


def remote_sync_key() -> str:
    # Mantida somente como segredo interno/compatibilidade. O navegador autenticado
    # usa a sessão HttpOnly do backend Python e não precisa conhecer este valor.
    return str(os.getenv("REMOTE_SYNC_KEY", "")).strip()


def session_secret() -> str:
    return str(os.getenv("SESSION_SECRET", "")).strip()


def configured_supabase_url() -> str:
    return str(
        os.getenv("SUPABASE_URL")
        or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
        or ""
    ).strip()


def _valid_expected_supabase_url(raw: str = "") -> bool:
    """Allow auth credentials to be sent only to the audited Supabase HTTPS host."""
    try:
        parts = urlsplit(str(raw or "").strip())
        hostname = (parts.hostname or "").lower()
        return (
            parts.scheme.lower() == "https"
            and hostname == f"{EXPECTED_SUPABASE_REF}.supabase.co"
            and parts.username is None
            and parts.password is None
        )
    except Exception:
        return False


def supabase_url() -> str:
    configured = configured_supabase_url()
    if configured and _valid_expected_supabase_url(configured):
        return configured.rstrip("/")
    return DEFAULT_SUPABASE_URL


def publishable_key() -> str:
    configured_key = str(
        os.getenv("SUPABASE_PUBLISHABLE_KEY")
        or os.getenv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")
        or ""
    ).strip()
    configured_url = configured_supabase_url()
    if configured_key and (not configured_url or _valid_expected_supabase_url(configured_url)):
        return configured_key
    return DEFAULT_PUBLISHABLE_KEY


def database_project_ref(raw: str = "") -> str:
    value = str(raw or database_url()).strip()
    if not value:
        return ""
    try:
        parts = urlsplit(value)
        hostname = (parts.hostname or "").lower()
        if hostname.startswith("db.") and hostname.endswith(".supabase.co"):
            return hostname[3:-12]
        username = parts.username or ""
        if username.startswith("postgres."):
            return username.split(".", 1)[1]
    except Exception:
        return ""
    return ""


def api_project_ref() -> str:
    try:
        hostname = (urlsplit(supabase_url()).hostname or "").lower()
        return hostname[:-12] if hostname.endswith(".supabase.co") else ""
    except Exception:
        return ""


def _expected_supabase_connected() -> bool:
    configured_api_url = configured_supabase_url()
    if configured_api_url and not _valid_expected_supabase_url(configured_api_url):
        return False
    db_ref = database_project_ref()
    api_ref = api_project_ref()
    # Algumas integrações da Vercel fornecem URL PostgreSQL opaca, sem project-ref.
    # Quando o ref é identificável, ele deve coincidir com o projeto auditado.
    return bool(
        EXPECTED_SUPABASE_REF
        and api_ref == EXPECTED_SUPABASE_REF
        and (not db_ref or db_ref == EXPECTED_SUPABASE_REF)
    )


def supabase_configured() -> bool:
    # A conexão PostgreSQL e o segredo interno precisam estar presentes, e ambos
    # devem permanecer presos ao mesmo projeto Supabase auditado.
    return (
        bool(database_url())
        and _expected_supabase_connected()
        and bool(remote_sync_key())
    )


def frontend_dir() -> Path:
    # A UI é empacotada neste mesmo repositório. A variável só permite escolher
    # um diretório local durante desenvolvimento; não aceita URL/repositório externo.
    raw = str(os.getenv("SMG_FRONTEND_DIR", "frontend")).strip() or "frontend"
    path = Path(raw)
    if not path.is_absolute():
        path = ROOT_DIR / path
    return path.resolve()


def environment_status() -> dict:
    secret = session_secret()
    configured_api_url = configured_supabase_url()
    return {
        "appVersion": APP_VERSION,
        "postgresUrl": _truthy_env("POSTGRES_URL"),
        "postgresPrismaUrl": _truthy_env("POSTGRES_PRISMA_URL"),
        "postgresNonPooling": _truthy_env("POSTGRES_URL_NON_POOLING"),
        "postgresHost": _truthy_env("POSTGRES_HOST"),
        "postgresPassword": _truthy_env("POSTGRES_PASSWORD"),
        "supabaseDbUrl": _truthy_env("SUPABASE_DB_URL"),
        "supabaseUrl": bool(supabase_url()),
        "configuredSupabaseUrlValid": not configured_api_url or _valid_expected_supabase_url(configured_api_url),
        "publishableKey": bool(publishable_key()),
        "secretKey": _truthy_env("SUPABASE_SECRET_KEY"),
        "expectedProjectMatched": _expected_supabase_connected(),
        "databaseProjectRefMatched": not database_project_ref() or database_project_ref() == EXPECTED_SUPABASE_REF,
        "apiProjectRefMatched": api_project_ref() == EXPECTED_SUPABASE_REF,
        "remoteSyncKeyConfigured": bool(remote_sync_key()),
        "sessionSecretConfigured": bool(secret),
        "sessionSecretStrong": len(secret.encode("utf-8")) >= 32 if secret else False,
        "externalFrontend": False,
    }


def whatsapp_provider_config() -> dict:
    return {
        "accessToken": str(os.getenv("WHATSAPP_ACCESS_TOKEN", "")).strip(),
        "phoneNumberId": str(os.getenv("WHATSAPP_PHONE_NUMBER_ID", "")).strip(),
        "templateName": str(os.getenv("WHATSAPP_TEMPLATE_NAME", "lembrete_mensalidade_arte_de_aprender")).strip(),
        "templateLanguage": str(os.getenv("WHATSAPP_TEMPLATE_LANGUAGE", "pt_BR")).strip(),
        "graphVersion": str(os.getenv("WHATSAPP_GRAPH_API_VERSION", "v25.0")).strip(),
        "appSecret": str(os.getenv("WHATSAPP_APP_SECRET", "")).strip(),
        "webhookVerifyToken": str(os.getenv("WHATSAPP_WEBHOOK_VERIFY_TOKEN", "")).strip(),
    }
