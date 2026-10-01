import pytest

from smg.domains import RESOURCE_TYPES, normalize_id, normalize_resource


def test_all_functional_modules_are_exposed():
    required = {"other-income", "expenses", "bank-accounts", "bank-movements", "calendar-events",
                "rental-contracts", "rental-receivables", "rental-repasses", "rental-assets", "proposals",
                "employee-schedules", "employee-payroll", "employee-taxes", "company-settings", "backups"}
    assert required <= RESOURCE_TYPES


def test_resource_allowlist_blocks_unknown_modules():
    with pytest.raises(ValueError):
        normalize_resource("../../secrets")


def test_ids_are_sanitized():
    assert normalize_id(" aluno 1/../../ ") == "aluno1...."
