from smg.db import connection_kwargs


def test_serverless_postgres_pool_disables_automatic_prepared_statements():
    kwargs = connection_kwargs()
    assert kwargs["autocommit"] is True
    assert kwargs["prepare_threshold"] is None
