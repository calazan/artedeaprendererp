from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_dynamic_table_names_use_psycopg_identifiers():
    state = (ROOT / "smg" / "state.py").read_text(encoding="utf-8")
    assert "sql.Identifier(table)" in state
    assert "public.{table}" not in state


def test_optional_sql_filters_are_not_f_string_interpolated():
    for relative in ("smg/domains.py", "smg/employees.py", "smg/task_store.py"):
        source = (ROOT / relative).read_text(encoding="utf-8")
        assert 'f"SELECT' not in source
        assert 'f"""\n                SELECT' not in source
