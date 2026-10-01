from pathlib import Path

from app import rendered_html
from smg.config import frontend_dir


def test_index_loads_final_menu_color_and_visual_fix_assets():
    index = frontend_dir() / "index.html"
    response = rendered_html(index)
    html = response.body.decode("utf-8")

    assert 'main-menu-colors.css?v=2' in html
    assert 'visual-fixes.css?v=1' in html
    assert 'menu-brand.png?v=3' in html
    assert './sw.js?v=72' in html


def test_visual_fix_restores_real_logo_and_teacher_link_contrast():
    css = (frontend_dir() / "visual-fixes.css").read_text(encoding="utf-8")
    assert ".sidebar .brand::before" in css
    assert "content: none !important" in css
    assert ".brand-menu-image" in css
    assert "display: block !important" in css
    assert ".teacher-tab-link" in css
    assert "color: #fff !important" in css
    assert "opacity: 1 !important" in css
