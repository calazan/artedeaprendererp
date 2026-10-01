from pathlib import Path

from app import rendered_html
from smg.config import frontend_dir


def test_index_loads_final_brand_and_visual_assets():
    index = frontend_dir() / "index.html"
    response = rendered_html(index)
    html = response.body.decode("utf-8")

    assert 'main-menu-colors.css?v=20261001' in html
    assert 'visual-fixes.css?v=20261001' in html
    assert 'logo-horizontal.webp?v=20261001' in html
    assert 'banner-dashboard.webp?v=20261001' in html
    assert 'register-sw.js?v=1' in html
    register_sw = (frontend_dir() / "register-sw.js").read_text(encoding="utf-8")
    assert './sw.js?v=20261001-online1' in register_sw


def test_visual_fix_restores_official_logo_and_teacher_link_contrast():
    css = (frontend_dir() / "visual-fixes.css").read_text(encoding="utf-8")
    assert ".sidebar .brand::before" in css
    assert "content:none!important" in css.replace(" ", "")
    assert ".brand-menu-image" in css
    assert "display:block!important" in css.replace(" ", "")
    assert "background:transparent!important" in css.replace(" ", "")
    assert ".teacher-tab-link" in css
    assert "color:#fff!important" in css.replace(" ", "")
    assert "opacity:1!important" in css.replace(" ", "")
