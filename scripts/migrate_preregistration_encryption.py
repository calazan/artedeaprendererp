from __future__ import annotations

import asyncio

from smg.crypto import encryption_configured
from smg.preregistration import migrate_sensitive_records


async def main() -> None:
    if not encryption_configured():
        raise SystemExit("DATA_ENCRYPTION_KEY ausente ou inválida; migração não iniciada.")
    result = await migrate_sensitive_records()
    print(f"Pré-cadastros migrados com AES-GCM: {result['migrated']}")


if __name__ == "__main__":
    asyncio.run(main())
