#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import getpass
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env")

from smg.auth_store import bootstrap_user
from smg.config import database_provider, database_url


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(
        description="Cria o primeiro usuário administrativo do Arte de Aprender ERP no Neon."
    )
    value.add_argument("--email", required=True)
    value.add_argument("--name", required=True)
    value.add_argument("--organization", default="Arte de Aprender")
    value.add_argument("--role", choices=("owner", "admin", "manager", "teacher"), default="owner")
    value.add_argument(
        "--reset-password",
        action="store_true",
        help="Atualiza a senha se o usuário já existir.",
    )
    return value


async def main() -> int:
    args = parser().parse_args()
    if not database_url():
        print("ERRO: configure DATABASE_URL antes de executar.", file=sys.stderr)
        return 2

    password = os.getenv("BOOTSTRAP_ADMIN_PASSWORD") or getpass.getpass(
        "Senha do administrador (mínimo 12 caracteres): "
    )
    confirmation = os.getenv("BOOTSTRAP_ADMIN_PASSWORD") or getpass.getpass("Confirme a senha: ")
    if password != confirmation:
        print("ERRO: as senhas não coincidem.", file=sys.stderr)
        return 2

    try:
        result = await bootstrap_user(
            email=args.email,
            password=password,
            display_name=args.name,
            organization_name=args.organization,
            role=args.role,
            reset_password=args.reset_password,
        )
    except Exception as exc:
        print(f"ERRO: {exc}", file=sys.stderr)
        return 1

    action = "criado" if result["created"] else "já existente/atualizado"
    print(
        f"OK: usuário {action}; provedor={database_provider()}; "
        f"email={result['email']}; role={result['role']}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
