from smg import APP_VERSION
from smg.auth import login_page


def test_login_uses_saber_brand_and_centralized_version():
    response = login_page("/")
    html = response.body.decode("utf-8")

    assert '/menu-brand.png?v=2' in html
    assert f"Arte de Aprender ERP • Versão {APP_VERSION}" in html
    assert f"Arte de Aprender ERP V{APP_VERSION}" in html
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["x-content-type-options"] == "nosniff"
