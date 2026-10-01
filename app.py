from __future__ import annotations

import mimetypes
import os
from pathlib import Path

from fastapi import Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from smg import APP_VERSION
from smg.app import app
from smg.auth import ADMIN_ROLES, TEACHER_ROLES, login_redirect, role_authorized
from smg.config import database_configured, database_provider, environment_status, frontend_dir, whatsapp_provider_config

FRONTEND_ROOT = frontend_dir()


@app.get("/api/runtime-mode")
async def runtime_mode():
    return JSONResponse(
        {
            "ok": True,
            "mode": "python-direct" if database_configured() else "python-not-ready",
            "pythonFastApi": True,
            "databaseDirect": bool(database_configured()),
            "databaseProvider": database_provider(),
            "compatibilityProxy": False,
            "frontendMode": "python-owned-bundled-ui",
            "externalFrontend": False,
            "externalRepositoryDependency": False,
            "businessLogic": "python",
            "workers": "python",
            "version": APP_VERSION,
        },
        headers={"Cache-Control": "no-store", "X-SMG-Backend-Mode": "python-direct"},
    )


@app.get("/api/environment-status")
async def environment_diagnostic(request: Request):
    if not role_authorized(request, ADMIN_ROLES):
        return JSONResponse({"ok": False, "error": "Autenticação obrigatória."}, status_code=401)
    whatsapp = whatsapp_provider_config()
    return JSONResponse(
        {
            "ok": True,
            "version": APP_VERSION,
            "mode": "python-direct" if database_configured() else "python-not-ready",
            "databaseConfigured": bool(database_configured()),
            "databaseProvider": database_provider(),
            "databaseEnvironment": environment_status(),
            "frontendMode": "python-owned-bundled-ui",
            "externalFrontendConfigured": False,
            "frontendRootLocal": FRONTEND_ROOT.is_dir(),
            "whatsapp": {
                "accessTokenConfigured": bool(whatsapp.get("accessToken")),
                "phoneNumberIdConfigured": bool(whatsapp.get("phoneNumberId")),
                "appSecretConfigured": bool(whatsapp.get("appSecret")),
                "webhookVerifyTokenConfigured": bool(whatsapp.get("webhookVerifyToken")),
                "cronSecretConfigured": bool(os.getenv("CRON_SECRET", "").strip()),
            },
        },
        headers={"Cache-Control": "no-store", "X-SMG-Backend-Mode": "python-direct"},
    )


def safe_frontend_path(relative: str) -> Path | None:
    try:
        candidate = (FRONTEND_ROOT / relative).resolve()
        candidate.relative_to(FRONTEND_ROOT)
        return candidate
    except Exception:
        return None


def response_headers(path: Path) -> dict[str, str]:
    no_store = path.suffix.lower() in {".html", ".js"} or path.name in {"sw.js", "manifest.json"}
    headers = {
        "Cache-Control": "no-store" if no_store else "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "same-origin",
        "X-SMG-Frontend-Source": "python-owned-bundled-ui",
    }
    if path.name == "sw.js":
        headers["Service-Worker-Allowed"] = "/"
    return headers


def rendered_html(path: Path) -> HTMLResponse:
    text = path.read_text(encoding="utf-8")
    if path.name == "index.html":
        # O arquivo estático permanece somente como UI empacotada neste repositório.
        # O backend Python controla a resposta, versão e cache-busting dos assets.
        text = text.replace("V4.6.9", f"V{APP_VERSION}")
        text = text.replace('data-app-version="4.6.9"', f'data-app-version="{APP_VERSION}"')
        text = text.replace(
            '<link rel="stylesheet" href="menu-brand.css?v=20261001" />',
            '<link rel="stylesheet" href="menu-brand.css?v=20261001" />
'
            '    <link rel="stylesheet" href="main-menu-colors.css?v=20261001" />
'
            '    <link rel="stylesheet" href="visual-fixes.css?v=20261001" />',
        )
        text = text.replace("logo-horizontal.webp?v=20261001", "logo-horizontal.webp?v=20261001")
        text = text.replace("python-auth-bridge.js?v=1", "python-auth-bridge.js?v=2")
        text = text.replace("remote-sync-key-fix.js?v=6", "remote-sync-key-fix.js?v=7")
        text = text.replace("./sw.js?v=20261001", "./sw.js?v=20261001")
    return HTMLResponse(text, headers=response_headers(path))


def file_response(path: Path):
    if path.suffix.lower() == ".html":
        return rendered_html(path)
    media_type = {
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
    }.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type, headers=response_headers(path))


@app.get("/{path:path}")
async def bundled_frontend(path: str, request: Request):
    normalized = (path or "").strip("/")
    if normalized.startswith("api/") or normalized == "api":
        return JSONResponse(
            {"ok": False, "error": "Rota de API não encontrada no backend Python."},
            status_code=404,
            headers={"Cache-Control": "no-store"},
        )

    public_pages = {"pre-cadastro", "pre-cadastro.html", "atualizar", "atualizar.html"}
    teacher_pages = {"chamada-professores", "chamada-professores.html"}
    name = Path(normalized).name
    is_page = not normalized or "." not in name or name.endswith(".html")

    if is_page and normalized not in public_pages:
        roles = TEACHER_ROLES if normalized in teacher_pages else ADMIN_ROLES
        if not role_authorized(request, roles):
            return login_redirect("/" + normalized if normalized else "/")

    relative = normalized or "index.html"
    candidate = safe_frontend_path(relative)
    if candidate and candidate.is_file():
        return file_response(candidate)

    if "." not in Path(relative).name:
        candidate = safe_frontend_path(relative + ".html")
        if candidate and candidate.is_file():
            return file_response(candidate)

    if is_page:
        index = safe_frontend_path("index.html")
        if index and index.is_file():
            return file_response(index)

    return JSONResponse({"ok": False, "error": "Arquivo não encontrado."}, status_code=404)
