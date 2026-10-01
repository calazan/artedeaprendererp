from __future__ import annotations

import uuid

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError
from argon2.low_level import Type

from .config import database_url
from .db import connection

PASSWORD_HASHER = PasswordHasher(
    time_cost=3,
    memory_cost=65536,
    parallelism=4,
    hash_len=32,
    salt_len=16,
    type=Type.ID,
)

AUTH_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS organizations_name_unique
  ON public.organizations(lower(name));

CREATE TABLE IF NOT EXISTS public.app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_unique
  ON public.app_users(lower(email));

CREATE TABLE IF NOT EXISTS public.organization_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','manager','teacher')),
  display_name text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS organization_members_user_active_idx
  ON public.organization_members(user_id, active);
"""

_schema_ready = False


def normalize_email(value: str) -> str:
    return str(value or "").strip().lower()[:254]


def hash_password(password: str) -> str:
    value = str(password or "")
    if len(value) < 12:
        raise ValueError("A senha deve ter pelo menos 12 caracteres.")
    return PASSWORD_HASHER.hash(value)


def verify_password_hash(password_hash: str, password: str) -> bool:
    try:
        return bool(PASSWORD_HASHER.verify(str(password_hash or ""), str(password or "")))
    except (VerifyMismatchError, VerificationError, ValueError):
        return False


async def ensure_auth_schema() -> None:
    global _schema_ready
    if _schema_ready:
        return
    if not database_url():
        raise RuntimeError("DATABASE_URL não configurada.")
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(AUTH_SCHEMA_SQL)
    _schema_ready = True


async def get_active_membership(user_id: str) -> dict | None:
    if not user_id or not database_url():
        return None
    await ensure_auth_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT m.role::text,
                       COALESCE(NULLIF(m.display_name,''), NULLIF(u.display_name,''), ''),
                       m.organization_id::text
                FROM public.organization_members m
                JOIN public.app_users u ON u.id=m.user_id
                JOIN public.organizations o ON o.id=m.organization_id
                WHERE m.user_id=%s::uuid
                  AND m.active=true
                  AND u.active=true
                  AND o.active=true
                ORDER BY CASE m.role
                  WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
                  WHEN 'manager' THEN 2 ELSE 3 END,
                  m.created_at
                LIMIT 1
                """,
                (user_id,),
            )
            row = await cur.fetchone()
    if not row:
        return None
    return {
        "role": str(row[0]),
        "displayName": str(row[1]),
        "organizationId": str(row[2]),
    }


async def authenticate_user(email: str, password: str) -> dict | None:
    clean_email = normalize_email(email)
    if not clean_email or not password or not database_url():
        return None
    await ensure_auth_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT u.id::text, u.password_hash,
                       COALESCE(NULLIF(m.display_name,''), NULLIF(u.display_name,''), ''),
                       m.role::text, m.organization_id::text
                FROM public.app_users u
                JOIN public.organization_members m ON m.user_id=u.id
                JOIN public.organizations o ON o.id=m.organization_id
                WHERE lower(u.email)=lower(%s)
                  AND u.active=true
                  AND m.active=true
                  AND o.active=true
                ORDER BY CASE m.role
                  WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
                  WHEN 'manager' THEN 2 ELSE 3 END,
                  m.created_at
                LIMIT 1
                """,
                (clean_email,),
            )
            row = await cur.fetchone()
            if not row or not verify_password_hash(str(row[1]), password):
                return None

            user_id = str(row[0])
            if PASSWORD_HASHER.check_needs_rehash(str(row[1])):
                await cur.execute(
                    "UPDATE public.app_users SET password_hash=%s,updated_at=now() WHERE id=%s::uuid",
                    (hash_password(password), user_id),
                )
            await cur.execute(
                "UPDATE public.app_users SET last_login_at=now(),updated_at=now() WHERE id=%s::uuid",
                (user_id,),
            )
    return {
        "userId": user_id,
        "displayName": str(row[2]),
        "role": str(row[3]),
        "organizationId": str(row[4]),
    }


async def bootstrap_user(
    *,
    email: str,
    password: str,
    display_name: str,
    organization_name: str,
    role: str = "owner",
    reset_password: bool = False,
) -> dict:
    clean_email = normalize_email(email)
    display_name = str(display_name or "").strip()[:120]
    organization_name = str(organization_name or "").strip()[:160]
    role = str(role or "owner").strip().lower()
    if role not in {"owner", "admin", "manager", "teacher"}:
        raise ValueError("Papel inválido.")
    if not clean_email or "@" not in clean_email:
        raise ValueError("E-mail inválido.")
    if not display_name or not organization_name:
        raise ValueError("Nome do usuário e organização são obrigatórios.")

    new_hash = hash_password(password)
    await ensure_auth_schema()
    async with connection() as conn:
        async with conn.transaction():
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT id::text FROM public.organizations WHERE lower(name)=lower(%s) LIMIT 1",
                    (organization_name,),
                )
                org_row = await cur.fetchone()
                if org_row:
                    organization_id = str(org_row[0])
                    await cur.execute(
                        "UPDATE public.organizations SET active=true,updated_at=now() WHERE id=%s::uuid",
                        (organization_id,),
                    )
                else:
                    organization_id = str(uuid.uuid4())
                    await cur.execute(
                        "INSERT INTO public.organizations(id,name,active) VALUES (%s::uuid,%s,true)",
                        (organization_id, organization_name),
                    )

                await cur.execute(
                    "SELECT id::text FROM public.app_users WHERE lower(email)=lower(%s) LIMIT 1",
                    (clean_email,),
                )
                user_row = await cur.fetchone()
                created = not bool(user_row)
                if created:
                    user_id = str(uuid.uuid4())
                    await cur.execute(
                        """
                        INSERT INTO public.app_users(id,email,password_hash,display_name,active)
                        VALUES (%s::uuid,%s,%s,%s,true)
                        """,
                        (user_id, clean_email, new_hash, display_name),
                    )
                else:
                    user_id = str(user_row[0])
                    if reset_password:
                        await cur.execute(
                            """
                            UPDATE public.app_users
                            SET password_hash=%s,display_name=%s,active=true,updated_at=now()
                            WHERE id=%s::uuid
                            """,
                            (new_hash, display_name, user_id),
                        )
                    else:
                        await cur.execute(
                            """
                            UPDATE public.app_users
                            SET display_name=%s,active=true,updated_at=now()
                            WHERE id=%s::uuid
                            """,
                            (display_name, user_id),
                        )

                await cur.execute(
                    """
                    INSERT INTO public.organization_members
                      (organization_id,user_id,role,display_name,active)
                    VALUES (%s::uuid,%s::uuid,%s,%s,true)
                    ON CONFLICT(organization_id,user_id) DO UPDATE SET
                      role=EXCLUDED.role,
                      display_name=EXCLUDED.display_name,
                      active=true,
                      updated_at=now()
                    """,
                    (organization_id, user_id, role, display_name),
                )

    return {
        "created": created,
        "userId": user_id,
        "organizationId": organization_id,
        "email": clean_email,
        "role": role,
    }
