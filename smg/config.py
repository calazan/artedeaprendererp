from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from . import APP_VERSION

ROOT_DIR = Path(__file__).resolve().parent.parent

DATABASE_ENV_NAMES = (
    "DATABASE_URL",
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL_NON_POOLING",
)


def _truthy_env(name: str) -> bool:
    return bool(str(os.getenv(name, "")).strip())


def normalize_database_url(raw: str = "") -> str:
    """Normalize PostgreSQL URLs without stripping Neon TLS parameters."""
    value = str(raw or "").strip()
    if not value:
        return ""
    try:
        parts = urlsplit(value)
        query = dict(parse_qsl(parts.query, keep_blank_values=True))
        # These parameters are used by some JavaScript clients but are not libpq
        # connection parameters. Keep sslmode/channel_binding required by Neon.
        query.pop("pgbouncer", None)
        query.pop("connection_limit", None)
        query["application_name"] = "arte-de-aprender-python"

        hostname = parts.hostname or ""
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
        if parts.port:
            netloc += f":{parts.port}"

        scheme = "postgresql" if parts.scheme == "postgres" else parts.scheme
        return urlunsplit((scheme, netloc, parts.path, urlencode(query), parts.fragment))
    except Exception:
        return value


def database_url() -> str:
    for name in DATABASE_ENV_NAMES:
        value = str(os.getenv(name, "")).strip()
        if value:
            return normalize_database_url(value)
    return ""


def database_configured() -> bool:
    return bool(database_url())


def database_provider(raw: str = "") -> str:
    value = str(raw or database_url()).strip()
    if not value:
        return "unconfigured"
    try:
        hostname = (urlsplit(value).hostname or "").lower()
        if hostname.endswith(".neon.tech") or ".neon.tech" in hostname:
            return "neon-postgres"
    except Exception:
        pass
    return "postgresql"


def session_secret() -> str:
    return str(os.getenv("SESSION_SECRET", "")).strip()


def frontend_dir() -> Path:
    raw = str(os.getenv("SMG_FRONTEND_DIR", "frontend")).strip() or "frontend"
    path = Path(raw)
    if not path.is_absolute():
        path = ROOT_DIR / path
    return path.resolve()


def environment_status() -> dict:
    secret = session_secret()
    return {
        "appVersion": APP_VERSION,
        "databaseUrl": _truthy_env("DATABASE_URL"),
        "postgresUrl": _truthy_env("POSTGRES_URL"),
        "postgresPrismaUrl": _truthy_env("POSTGRES_PRISMA_URL"),
        "postgresNonPooling": _truthy_env("POSTGRES_URL_NON_POOLING"),
        "databaseConfigured": database_configured(),
        "databaseProvider": database_provider(),
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
