"""Build a self-contained hosted copy of the simulator (for a static host or a preview).

Inlines the simulator scripts (engine, physics, controller, coach, theme) and the theme stylesheet, and swaps the local vendor files for pinned CDN copies,
so each page is a single HTML file with no local script dependencies.

    python tools/build_hosted.py out_dir [--fragment]

--fragment writes index.html without <!doctype>/<head>/<body> wrappers
(for hosts that add their own document skeleton).

The coach (knowledge-base.js, coach.js) runs entirely in the browser, so it works on a static
host. The optional local AI model needs server/server.py. USB (Web Serial) needs localhost or HTTPS in Chrome/Edge.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent / "simulator"
CDN = {
    '<script src="./vendor/gsap.min.js"></script>':
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>',
    '"three": "./vendor/three/build/three.module.js",':
        '"three": "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.min.js",',
    '"three/addons/": "./vendor/three/examples/jsm/"':
        '"three/addons/": "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/"',
}


def inline(html: str, name: str) -> str:
    tag = f'<script src="./{name}"></script>'
    if tag in html:
        code = (ROOT / name).read_text(encoding="utf-8").replace("</script", "<\\/script")
        html = html.replace(tag, "<script>\n" + code + "\n</script>")
    return html


def inline_css(html: str, name: str) -> str:
    tag = f'<link rel="stylesheet" href="./{name}">'
    if tag in html:
        css = (ROOT / name).read_text(encoding="utf-8")
        html = html.replace(tag, "<style>\n" + css + "\n</style>")
    return html


def build(page: str, fragment: bool) -> str:
    html = (ROOT / page).read_text(encoding="utf-8")
    if '<script src="./vendor/gsap.min.js"></script>' not in html:
        raise SystemExit(f"{page}: GSAP script tag not found")
    for a, b in CDN.items():
        html = html.replace(a, b)
    for js in ("engine.js", "physics.js", "controller.js", "knowledge-base.js", "coach.js", "theme.js", "hand-logic.js", "hand-control.js"):
        html = inline(html, js)
    html = inline_css(html, "theme.css")
    if fragment:
        head_start = html.index("<title>")
        html = html[head_start:]
        html = html.replace("</style>\n</head>\n<body>\n", "</style>\n", 1)
        html = html.replace("\n</body>\n</html>\n", "\n", 1)
    return html


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    out = pathlib.Path(sys.argv[1])
    frag = "--fragment" in sys.argv
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(build("index.html", frag), encoding="utf-8")
    for page in ("trainer.html", "internals.html"):
        html = build(page, False)
        if frag:
            html = html.replace('href="./index.html"', 'href="./"')
        (out / page).write_text(html, encoding="utf-8")
    print("wrote index.html, trainer.html and internals.html to", out)


if __name__ == "__main__":
    main()
