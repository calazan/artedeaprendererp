from __future__ import annotations

import hashlib
import hmac
import secrets

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .auth_store import authenticate_user, bootstrap_user, ensure_auth_schema
from .config import database_configured
from .db import connection

router = APIRouter()

_TARGET_EMAIL = "sabermaisf@gmail.com"
_TARGET_NAME = "Administrador"
_TARGET_ORGANIZATION = "Arte de Aprender"
_TOKEN_SHA256 = "1b8672cd7f2669abba95d36536ce6427429b0c2cc5be3e21bd26fac1d35003d5"


def _authorized(token: str) -> bool:
    candidate = hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()
    return hmac.compare_digest(candidate, _TOKEN_SHA256)


async def _ensure_temp_table() -> None:
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                CREATE TABLE IF NOT EXISTS public.smg_bootstrap_ephemeral (
                  nonce text PRIMARY KEY,
                  fernet_key text NOT NULL,
                  expires_at timestamptz NOT NULL
                )
                """
            )
            await cur.execute(
                "DELETE FROM public.smg_bootstrap_ephemeral WHERE expires_at <= now()"
            )


@router.get("/api/internal/bootstrap-owner/start")
async def bootstrap_owner_start(request: Request):
    if not _authorized(str(request.query_params.get("token") or "")):
        return JSONResponse({"ok": False}, status_code=404, headers={"Cache-Control": "no-store"})
    if not database_configured():
        return JSONResponse({"ok": False, "error": "database-not-configured"}, status_code=503)

    await ensure_auth_schema()
    await _ensure_temp_table()

    nonce = secrets.token_urlsafe(24)
    key = Fernet.generate_key().decode("ascii")
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO public.smg_bootstrap_ephemeral(nonce, fernet_key, expires_at)
                VALUES (%s, %s, now() + interval '5 minutes')
                ON CONFLICT (nonce) DO UPDATE SET
                  fernet_key=EXCLUDED.fernet_key,
                  expires_at=EXCLUDED.expires_at
                """,
                (nonce, key),
            )
    return JSONResponse(
        {"ok": True, "nonce": nonce, "key": key, "expiresSeconds": 300},
        headers={"Cache-Control": "no-store"},
    )


@router.get("/api/internal/bootstrap-owner/finish")
async def bootstrap_owner_finish(request: Request):
    if not _authorized(str(request.query_params.get("token") or "")):
        return JSONResponse({"ok": False}, status_code=404, headers={"Cache-Control": "no-store"})

    nonce = str(request.query_params.get("nonce") or "").strip()
    payload = str(request.query_params.get("payload") or "").strip()
    if not nonce or not payload:
        return JSONResponse({"ok": False, "error": "missing-payload"}, status_code=400)

    await _ensure_temp_table()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT fernet_key
                FROM public.smg_bootstrap_ephemeral
                WHERE nonce=%s AND expires_at > now()
                LIMIT 1
                """,
                (nonce,),
            )
            row = await cur.fetchone()
    if not row:
        return JSONResponse({"ok": False, "error": "expired"}, status_code=410)

    try:
        password = Fernet(str(row[0]).encode("ascii")).decrypt(payload.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeDecodeError, ValueError):
        return JSONResponse({"ok": False, "error": "invalid-payload"}, status_code=400)

    try:
        result = await bootstrap_user(
            email=_TARGET_EMAIL,
            password=password,
            display_name=_TARGET_NAME,
            organization_name=_TARGET_ORGANIZATION,
            role="owner",
            reset_password=True,
        )
        verified = await authenticate_user(_TARGET_EMAIL, password)
        if not verified or verified.get("role") != "owner":
            raise RuntimeError("login verification failed")
    finally:
        async with connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "DELETE FROM public.smg_bootstrap_ephemeral WHERE nonce=%s",
                    (nonce,),
                )

    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("DROP TABLE IF EXISTS public.smg_bootstrap_ephemeral")

    return JSONResponse(
        {
            "ok": True,
            "created": bool(result.get("created")),
            "email": _TARGET_EMAIL,
            "role": "owner",
            "loginVerified": True,
        },
        headers={"Cache-Control": "no-store"},
    )
