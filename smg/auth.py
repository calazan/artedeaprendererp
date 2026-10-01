from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import time
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from . import APP_VERSION
from .auth_store import authenticate_user, get_active_membership, increment_session_version
from .config import database_configured, session_secret
from .preregistration import consume_rate_limit

SESSION_COOKIE = "smg_session"
SESSION_TTL_SECONDS = 8 * 60 * 60
SESSION_VERSION = 3
MEMBERSHIP_CACHE_TTL_SECONDS = 60
OWNER_ADMIN_ROLES = frozenset({"owner", "admin"})
ADMIN_ROLES = frozenset({"owner", "admin", "manager"})
TEACHER_ROLES = frozenset({*ADMIN_ROLES, "teacher"})
router = APIRouter()
_membership_cache: dict[str, tuple[float, dict | None]] = {}


class SessionConfigurationError(RuntimeError):
    pass


class MembershipLookupError(RuntimeError):
    pass


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _session_secret() -> bytes:
    configured = session_secret()
    if not configured:
        raise SessionConfigurationError("SESSION_SECRET não configurado.")
    raw = configured.encode("utf-8")
    if len(raw) < 32:
        raise SessionConfigurationError("SESSION_SECRET precisa ter pelo menos 32 bytes.")
    return hashlib.sha256(b"arte-erp-session-v1\x00" + raw).digest()


def session_configuration_ready() -> bool:
    try:
        _session_secret()
        return True
    except SessionConfigurationError:
        return False


def create_session(user_id: str, role: str, display_name: str = "", session_version: int = 1) -> str:
    payload = {
        "sub": str(user_id),
        "role": str(role),
        "name": str(display_name or "")[:120],
        "exp": int(time.time()) + SESSION_TTL_SECONDS,
        "v": SESSION_VERSION,
        "sv": max(1, int(session_version or 1)),
    }
    encoded = _b64encode(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    signature = _b64encode(hmac.new(_session_secret(), encoded.encode("ascii"), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def _decode_session(request: Request) -> dict | None:
    token = str(request.cookies.get(SESSION_COOKIE) or "")
    if "." not in token:
        return None
    try:
        secret = _session_secret()
    except SessionConfigurationError:
        return None
    encoded, received = token.rsplit(".", 1)
    expected = _b64encode(hmac.new(secret, encoded.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(expected, received):
        return None
    try:
        payload = json.loads(_b64decode(encoded))
    except Exception:
        return None
    if not isinstance(payload, dict) or payload.get("v") != SESSION_VERSION:
        return None
    if int(payload.get("exp") or 0) <= int(time.time()):
        return None
    if not payload.get("sub") or int(payload.get("sv") or 0) < 1:
        return None
    return payload


def clear_membership_cache(user_id: str = "") -> None:
    if user_id:
        _membership_cache.pop(str(user_id), None)
    else:
        _membership_cache.clear()


async def _active_membership_cached(user_id: str) -> dict | None:
    now = time.monotonic()
    cached = _membership_cache.get(str(user_id))
    if cached and cached[0] > now:
        return cached[1]
    membership = await _active_membership(user_id)
    _membership_cache[str(user_id)] = (now + MEMBERSHIP_CACHE_TTL_SECONDS, membership)
    return membership


async def session_from_request(request: Request) -> dict | None:
    payload = _decode_session(request)
    if not payload:
        return None
    try:
        membership = await _active_membership_cached(str(payload.get("sub") or ""))
    except MembershipLookupError:
        return None
    if not membership:
        return None
    if int(payload.get("sv") or 0) != int(membership.get("sessionVersion") or 0):
        return None
    return {
        **payload,
        "role": str(membership.get("role") or ""),
        "name": str(membership.get("displayName") or ""),
        "organizationId": str(membership.get("organizationId") or ""),
        "sessionVersion": int(membership.get("sessionVersion") or 0),
    }


def _canonical_ip(value: str) -> str:
    candidate = str(value or "").strip()
    if not candidate:
        return ""
    if "," in candidate:
        candidate = candidate.split(",", 1)[0].strip()
    if candidate.startswith("[") and "]" in candidate:
        candidate = candidate[1 : candidate.index("]")]
    elif candidate.count(":") == 1 and "." in candidate:
        host, port = candidate.rsplit(":", 1)
        if port.isdigit():
            candidate = host
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return ""


def get_client_ip(request: Request) -> str:
    for header in ("x-real-ip", "x-forwarded-for"):
        resolved = _canonical_ip(str(request.headers.get(header) or ""))
        if resolved:
            return resolved
    if request.client:
        resolved = _canonical_ip(str(request.client.host or ""))
        if resolved:
            return resolved
    return "unknown"


def same_origin_request(request: Request) -> bool:
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return True
    if str(request.headers.get("sec-fetch-site") or "").lower() == "cross-site":
        return False
    origin = str(request.headers.get("origin") or "").strip()
    if not origin:
        return True
    expected = f"{request.url.scheme}://{request.url.netloc}"
    forwarded_host = str(request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
    forwarded_proto = str(request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    if forwarded_host:
        expected = f"{forwarded_proto or 'https'}://{forwarded_host}"
    return hmac.compare_digest(origin.rstrip("/"), expected.rstrip("/"))


async def require_role(request: Request, roles: frozenset[str] = ADMIN_ROLES) -> dict | None:
    if not same_origin_request(request):
        return None
    session = await session_from_request(request)
    if not session or str(session.get("role")) not in roles:
        return None
    return session


async def role_authorized(request: Request, roles: frozenset[str] = ADMIN_ROLES) -> bool:
    return bool(await require_role(request, roles))


async def _active_membership(user_id: str) -> dict | None:
    if not user_id or not database_configured():
        raise MembershipLookupError("Banco de autorização indisponível.")
    try:
        return await get_active_membership(user_id)
    except Exception as exc:
        raise MembershipLookupError("Falha ao consultar autorização.") from exc


def login_page(next_path: str = "/") -> HTMLResponse:
    safe_next = next_path if next_path.startswith("/") and not next_path.startswith("//") else "/"
    page = f"""<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Entrar — Arte de Aprender ERP V{APP_VERSION}</title>
<style>
:root{{--purple:#7f4389;--purple-dark:#63336f;--yellow:#f5bd35;--ink:#241d28;--muted:#675d6b}}
*{{box-sizing:border-box}}
body{{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 12% 15%,rgba(159,90,166,.23),transparent 29%),radial-gradient(circle at 88% 84%,rgba(245,189,53,.25),transparent 30%),linear-gradient(135deg,#fbf7ef,#f7f2fb);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--ink)}}
main{{width:min(470px,100%);background:rgba(255,255,255,.92);padding:24px 28px 28px;border:1px solid rgba(127,67,137,.12);border-radius:26px;box-shadow:0 24px 80px rgba(49,31,54,.16)}}
.brand-panel{{display:grid;place-items:center;background:#fff;border:1px solid rgba(118,0,138,.12);border-radius:22px;padding:12px;margin-bottom:18px;overflow:hidden}}
.brand-panel img{{display:block;width:min(390px,100%);height:auto;max-height:250px;object-fit:contain}}
.version{{width:max-content;max-width:100%;margin:0 auto 14px;padding:7px 12px;border-radius:999px;background:#f7eef9;color:var(--purple-dark);font-size:12px;font-weight:800;letter-spacing:.04em}}
h1{{margin:0 0 7px;text-align:center;font-size:26px;color:var(--purple-dark)}}
.lead{{margin:0 0 20px;text-align:center;color:var(--muted)}}
label{{display:block;margin:14px 0 6px;font-weight:700;color:#514756}}
input{{width:100%;padding:12px 13px;border:1px solid #d8cfdb;border-radius:12px;background:#fff;font:inherit;outline:none;transition:border-color .16s ease,box-shadow .16s ease}}
input:focus{{border-color:#a86bb1;box-shadow:0 0 0 4px rgba(168,107,177,.14)}}
button{{width:100%;margin-top:18px;padding:13px;border:0;border-radius:13px;background:linear-gradient(135deg,#a86bb1,#7f4389);color:#fff;font:inherit;font-weight:800;cursor:pointer;box-shadow:0 12px 26px rgba(127,67,137,.22)}}
button:hover{{filter:brightness(1.05)}}
#error{{color:#b42318;min-height:24px;margin-top:12px;font-size:14px}}
small{{display:block;color:#746b78;margin-top:15px;text-align:center;line-height:1.4}}
@media(max-width:520px){{body{{padding:14px}}main{{padding:18px;border-radius:22px}}.brand-panel{{padding:8px}}.brand-panel img{{max-height:210px}}}}
</style></head><body><main>
<div class="brand-panel"><img src="/logo-horizontal.webp?v=20261001" alt="Arte de Aprender" decoding="async"></div>
<div class="version">Arte de Aprender ERP • Versão {APP_VERSION}</div>
<h1>Gestão Arte de Aprender</h1><p class="lead">Entre com sua conta autorizada.</p>
<form id="login"><label for="email">E-mail</label><input id="email" type="email" autocomplete="username" required>
<label for="password">Senha</label><input id="password" type="password" autocomplete="current-password" required>
<button type="submit">Entrar</button><div id="error" role="alert"></div></form>
<small>A sessão é protegida e expira automaticamente após 8 horas.</small></main>
<script>
document.getElementById("login").addEventListener("submit", async (event) => {{
  event.preventDefault();
  const error = document.getElementById("error");
  error.textContent = "";
  try {{
    const response = await fetch("/api/auth/login", {{
      method: "POST", headers: {{"Content-Type":"application/json"}},
      body: JSON.stringify({{email:document.getElementById("email").value,password:document.getElementById("password").value}})
    }});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Não foi possível entrar.");
    location.replace("/");
  }} catch (reason) {{ error.textContent = reason.message || "Falha de autenticação."; }}
}});
</script></body></html>"""
    # Preserve validated relative next path without interpolating untrusted HTML/JS.
    page = page.replace("location.replace(\"/\");", f"location.replace({json.dumps(safe_next)});")
    return HTMLResponse(
        page,
        headers={
            "Cache-Control": "no-store",
            "X-Frame-Options": "DENY",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "same-origin",
            "Clear-Site-Data": "\"cache\", \"storage\"",
        },
    )


@router.get("/login")
async def login(request: Request):
    if await session_from_request(request):
        return RedirectResponse("/", status_code=303, headers={"Cache-Control": "no-store"})
    return login_page(str(request.query_params.get("next") or "/"))


@router.post("/api/auth/login")
async def api_login(request: Request):
    if not same_origin_request(request):
        return JSONResponse({"ok": False, "error": "Origem inválida."}, status_code=403)
    try:
        raw = await request.body()
        if len(raw) > 16 * 1024:
            raise ValueError
        body = json.loads(raw.decode("utf-8")) if raw else {}
    except Exception:
        return JSONResponse({"ok": False, "error": "Requisição inválida."}, status_code=400)

    email = str(body.get("email") or "").strip().lower()[:254]
    password = str(body.get("password") or "")
    if not email or not password:
        return JSONResponse({"ok": False, "error": "E-mail ou senha inválidos."}, status_code=401)
    if not database_configured():
        return JSONResponse({"ok": False, "error": "Banco Neon ainda não configurado."}, status_code=503)
    if not session_configuration_ready():
        return JSONResponse({"ok": False, "error": "Segredo de sessão não configurado."}, status_code=503)

    client_ip = get_client_ip(request)
    account_allowed = await consume_rate_limit(
        f"account-ip:{email}:{client_ip}",
        namespace="auth-login",
        limit=8,
        window_seconds=15 * 60,
        fail_open=False,
    )
    ip_allowed = await consume_rate_limit(
        f"ip:{client_ip}",
        namespace="auth-login",
        limit=30,
        window_seconds=15 * 60,
        fail_open=False,
    )
    if not account_allowed or not ip_allowed:
        return JSONResponse(
            {"ok": False, "error": "Muitas tentativas. Aguarde 15 minutos."},
            status_code=429,
            headers={"Retry-After": "900", "Cache-Control": "no-store"},
        )

    try:
        account = await authenticate_user(email, password)
    except Exception:
        return JSONResponse({"ok": False, "error": "Serviço de autenticação indisponível."}, status_code=503)
    if not account:
        return JSONResponse({"ok": False, "error": "E-mail ou senha inválidos."}, status_code=401)
    if account["role"] not in TEACHER_ROLES:
        return JSONResponse({"ok": False, "error": "Usuário sem acesso ativo ao ERP."}, status_code=403)

    try:
        token = create_session(account["userId"], account["role"], account["displayName"], account["sessionVersion"])
    except SessionConfigurationError:
        return JSONResponse({"ok": False, "error": "Segredo de sessão não configurado."}, status_code=503)
    except Exception:
        return JSONResponse({"ok": False, "error": "Falha ao criar sessão."}, status_code=500)

    response = JSONResponse(
        {"ok": True, "role": account["role"], "name": account["displayName"]},
        headers={"Cache-Control": "no-store"},
    )
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_TTL_SECONDS,
        secure=True,
        httponly=True,
        samesite="strict",
        path="/",
    )
    return response


@router.post("/api/auth/logout")
async def api_logout(request: Request):
    if not same_origin_request(request):
        return JSONResponse({"ok": False, "error": "Origem inválida."}, status_code=403)
    payload = _decode_session(request)
    revoked = True
    if payload and database_configured():
        try:
            await increment_session_version(str(payload.get("sub") or ""))
            clear_membership_cache(str(payload.get("sub") or ""))
        except Exception:
            revoked = False
    response = JSONResponse(
        {"ok": revoked},
        status_code=200 if revoked else 503,
        headers={"Cache-Control": "no-store"},
    )
    response.delete_cookie(SESSION_COOKIE, path="/", secure=True, httponly=True, samesite="strict")
    return response


@router.get("/api/auth/session")
async def api_session(request: Request):
    session = await session_from_request(request)
    if not session:
        return JSONResponse(
            {"ok": False, "authenticated": False},
            status_code=401,
            headers={"Cache-Control": "no-store"},
        )
    return JSONResponse(
        {"ok": True, "authenticated": True, "role": session["role"], "name": session.get("name") or ""},
        headers={"Cache-Control": "no-store"},
    )


def login_redirect(path: str) -> RedirectResponse:
    target = path if path.startswith("/") and not path.startswith("//") else "/"
    return RedirectResponse(
        f"/login?next={quote(target, safe='/.-_?=&')}",
        status_code=303,
        headers={"Cache-Control": "no-store"},
    )
