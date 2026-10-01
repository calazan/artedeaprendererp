#!/usr/bin/env python3
from __future__ import annotations

import compileall
from pathlib import Path

root = Path(__file__).resolve().parent.parent
ok = compileall.compile_dir(root / "smg", quiet=1)
ok = compileall.compile_dir(root / "scripts", quiet=1) and ok
ok = compileall.compile_file(str(root / "run.py"), quiet=1) and ok
print("OK: sintaxe Python válida." if ok else "ERRO: falha de compilação.")
raise SystemExit(0 if ok else 1)
