from smg import APP_VERSION
from smg.config import APP_VERSION as CONFIG_VERSION


def test_application_version_is_centralized():
    assert APP_VERSION == CONFIG_VERSION == "4.9.0"
