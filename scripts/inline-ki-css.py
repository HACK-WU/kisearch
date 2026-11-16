#!/usr/bin/env python3
"""把 web/src/styles/ki.css 内联进指定 demo 的 HTML（替换 <style data-ki-css-inline> 块）。

为什么需要：demo 要求单文件零依赖。跨目录 <link rel="stylesheet" href="../../web/...">
在 IDE 内置预览器 / 沙箱里会被拦（只允许访问被预览目录内的资源），一旦加载失败
整页退化为无样式骨架（SVG 会被撑满屏）——已在 demo/ki-ask-grouping 踩过一次。

用法：
    python3 scripts/inline-ki-css.py demo/<slug>/index.html [...]

源文件仍是唯一真相：改样式改 web/src/styles/ki.css，再跑本脚本重新生成。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS_PATH = ROOT / 'web/src/styles/ki.css'
ATTR = 'data-ki-css-inline'
PATTERN = re.compile(
    r'<style ' + re.escape(ATTR) + r'="[^"]*">.*?</style>',
    re.DOTALL,
)


def inline(html_path: Path) -> None:
    html = html_path.read_text(encoding='utf-8')
    if not PATTERN.search(html):
        sys.exit(f'✗ {html_path}: 找不到 <style {ATTR}> 块，请先手工放置一个空块作为锚点')
    css = CSS_PATH.read_text(encoding='utf-8')
    if '</style' in css:
        sys.exit('✗ ki.css 里出现 </style 字面量，内联会破坏 HTML，请先处理')
    out = PATTERN.sub(
        lambda _: f'<style {ATTR}="web/src/styles/ki.css">\n{css}\n</style>',
        html,
        count=1,
    )
    html_path.write_text(out, encoding='utf-8')
    print(f'✓ {html_path.relative_to(ROOT)}  ← {round(len(out) / 1024)} KB (ki.css {round(len(css) / 1024)} KB)')


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    if not CSS_PATH.exists():
        sys.exit(f'✗ 源文件不存在：{CSS_PATH}')
    for arg in sys.argv[1:]:
        inline((ROOT / arg).resolve() if not Path(arg).is_absolute() else Path(arg))


if __name__ == '__main__':
    main()
