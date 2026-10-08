#!/usr/bin/env python
"""LaTeX → 可编辑 Word Office Math（OMML）。

技术路线：``latex2mathml`` 转 MathML，再映射为 ``m:oMath`` / ``m:oMathPara``，
供 ``python-docx`` 挂到段落。不依赖本机 TeX / Word COM。

不支持的结构明确失败；调用方要求可编辑时不得静默回退 PNG/原文。

依赖：``pip install latex2mathml``（另需已有 ``python-docx``）。
"""
from __future__ import annotations

import re
from copy import deepcopy
from xml.etree import ElementTree

from docx.oxml import OxmlElement
from docx.oxml.ns import qn

MATHML_NS = "{http://www.w3.org/1998/Math/MathML}"
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")

# latex2mathml 不认识的单位/符号宏 → 宋体与 Cambria Math 都有的字符或已知命令
_LATEX_CMD_TO_REPL: tuple[tuple[str, str], ...] = (
    ("perthousand", "‰"),
    ("textcelsius", "℃"),
    ("textfahrenheit", "℉"),
    ("textdegree", "°"),
    ("angstrom", "Å"),
    ("permil", "‰"),
    ("degree", "°"),
    ("micro", "µ"),
    ("ohm", "Ω"),
    ("AA", "Å"),
)

_CIRC_UNIT_PATTERNS: tuple[str, ...] = (
    r"\\mathrm\s*\{\s*\^\s*\{\s*\\circ\s*\}\s*([A-Z])\s*\}",
    r"\\mathrm\s*\{\s*\^\s*\\circ\s*([A-Z])\s*\}",
    r"\^\s*\{\s*\\circ\s*\}\s*\\mathrm\s*\{\s*([A-Z])\s*\}",
    r"\^\s*\\circ\s*\\mathrm\s*\{\s*([A-Z])\s*\}",
    r"\^\s*\{\s*\\circ\s*\}\s*([A-Z])\b",
    r"\^\s*\\circ\s*([A-Z])\b",
)
_CIRC_UNIT_CHARS = {"C": "℃", "F": "℉"}


def _circ_unit_repl(match: re.Match[str]) -> str:
    letter = match.group(1)
    return _CIRC_UNIT_CHARS.get(letter, "°" + letter)


def normalize_latex_for_omml(latex: str) -> str:
    """去掉 Word 公式不友好的外壳，并把缺字符号换成可显示字符。"""
    body = (latex or "").strip()
    if not body:
        return ""
    body = re.sub(r"\\tag\s*\{([^{}]*)\}", r"\\quad (\1)", body)
    body = re.sub(r"\\notag\b", "", body)
    body = re.sub(r"\\label\s*\{[^{}]*\}", "", body)
    body = body.replace("\n", " ")
    body = re.sub(r"[ \t]{2,}", " ", body).strip()
    # Match a complete TeX control word. Prefix replacement corrupts \\left,
    # \\leq and \\geq. Preserve delimiters for the MathML converter.
    aliases = {"le": "leq", "ge": "geq", "land": "wedge", "lor": "vee"}
    body = re.sub(
        r"\\(le|ge|land|lor)(?![A-Za-z])",
        lambda match: "\\" + aliases[match.group(1)],
        body,
    )
    for cmd, repl in _LATEX_CMD_TO_REPL:
        body = re.sub(rf"\\{re.escape(cmd)}(?![A-Za-z])", lambda _match, r=repl: r, body)
    for pattern in _CIRC_UNIT_PATTERNS:
        body = re.sub(pattern, _circ_unit_repl, body)
    # 范围「约」：ASCII ~ 在公式里难看，改用波浪算子
    body = re.sub(r"\\sim(?![A-Za-z])", "∼", body)
    return body


def _map_glyphs(text: str, *, in_script: bool) -> str:
    """保留数学字符身份；单位转换仅在明确的单位命令中进行。"""
    if not text:
        return ""
    return text


def _element(name: str):
    return OxmlElement(f"m:{name}")


def _text_run(text: str, *, in_script: bool = False, math_style: str = "p"):
    text = _map_glyphs(text, in_script=in_script)
    run = _element("r")
    properties = _element("rPr")
    style = _element("sty")
    style.set(qn("m:val"), math_style)
    properties.append(style)
    run.append(properties)
    if text and not _CJK_RE.search(text):
        wrpr = OxmlElement("w:rPr")
        rfonts = OxmlElement("w:rFonts")
        for attr in ("ascii", "hAnsi", "cs", "eastAsia"):
            rfonts.set(qn(f"w:{attr}"), "Cambria Math")
        wrpr.append(rfonts)
        run.append(wrpr)
    value = _element("t")
    value.text = text
    run.append(value)
    return run


def _is_empty_math_node(node) -> bool:
    if node is None:
        return True
    if "".join(node.itertext()).strip():
        return False
    children = list(node)
    if not children:
        return True
    return all(_is_empty_math_node(child) for child in children)


def _append_children(target, source, *, in_script: bool = False) -> None:
    children = list(source)
    # latex2mathml emits plain operator parentheses for matrix environments.
    matrix_fences = (len(children) == 3 and children[1].tag == MATHML_NS + "mtable"
        and children[0].tag == children[2].tag == MATHML_NS + "mo"
        and ("".join(children[0].itertext()), "".join(children[2].itertext()))
            in {("(", ")"), ("[", "]"), ("{", "}"), ("|", "|"), ("‖", "‖")})
    if children and (_is_fence(children[0], "prefix") or matrix_fences):
        last_is_fence = matrix_fences or (len(children) > 1 and _is_fence(children[-1], "postfix"))
        delimiter = _element("d")
        properties = _element("dPr")
        for name, value in (
            ("begChr", "".join(children[0].itertext())),
            ("endChr", "".join(children[-1].itertext()) if last_is_fence else ""),
            ("grow", "1"),
        ):
            item = _element(name)
            item.set(qn("m:val"), value)
            properties.append(item)
        expression = _element("e")
        for child in children[1:-1] if last_is_fence else children[1:]:
            _append_mathml(expression, child, in_script=in_script)
        delimiter.extend((properties, expression))
        target.append(delimiter)
        return
    if source.text and source.text.strip():
        target.append(_text_run(source.text.strip(), in_script=in_script))
    for child in source:
        _append_mathml(target, child, in_script=in_script)
        if child.tail and child.tail.strip():
            target.append(_text_run(child.tail.strip(), in_script=in_script))


def _is_fence(node, form: str) -> bool:
    return (
        node.tag == MATHML_NS + "mo"
        and node.attrib.get("fence") == "true"
        and node.attrib.get("form") == form
    )


def _append_limits_or_accent(target, node) -> None:
    tag = node.tag.removeprefix(MATHML_NS)
    children = list(node)
    expected = 3 if tag == "munderover" else 2
    if len(children) != expected:
        raise ValueError(f"Invalid {tag}: expected {expected} arguments")
    if tag == "munderover":
        lower = ElementTree.Element(MATHML_NS + "munder")
        lower.extend(children[:2])
        upper = ElementTree.Element(MATHML_NS + "mover", node.attrib)
        upper.extend((lower, children[2]))
        _append_limits_or_accent(target, upper)
        return
    base, mark = children
    below = tag == "munder"
    glyph = "".join(mark.itertext()) if mark.tag == MATHML_NS + "mo" else ""
    accents = {
        "^": "\u0302", "~": "\u0303", "→": "\u20d7", "↔": "\u20e1",
        "˙": "\u0307", ".": "\u0307", "¨": "\u0308", "ˇ": "\u030c",
        "´": "\u0301", "\u0060": "\u0300", "˘": "\u0306",
    }
    explicit = node.attrib.get("accentunder" if below else "accent")
    if glyph in {"⏞", "⏟", "←", "⌢", "⌣"} and explicit != "false":
        raise ValueError(f"Unsupported mathematical accent: {glyph!r}")
    is_bar = glyph in {"¯", "_", "\u203e", "\u0332", "\u2015"} and explicit != "false"
    is_accent = (explicit == "true" or glyph in accents) and explicit != "false"
    if is_bar:
        result = _element("bar")
        properties = _element("barPr")
        position = _element("pos")
        position.set(qn("m:val"), "bot" if below else "top")
        properties.append(position)
        result.append(properties)
    elif is_accent:
        if below or glyph not in accents:
            raise ValueError(f"Unsupported mathematical accent: {glyph!r}")
        result = _element("acc")
        properties = _element("accPr")
        character = _element("chr")
        character.set(qn("m:val"), accents[glyph])
        properties.append(character)
        result.append(properties)
    else:
        result = _element("limLow" if below else "limUpp")
    expression = _element("e")
    _append_mathml(expression, base)
    result.append(expression)
    if not (is_bar or is_accent):
        limit = _element("lim")
        _append_mathml(limit, mark)
        result.append(limit)
    target.append(result)


def _script(target, node, kind: str) -> None:
    children = list(node)
    expected = 3 if kind == "sSubSup" else 2
    if len(children) != expected:
        raise ValueError(f"Invalid {kind}: expected {expected} arguments")

    result = _element(kind)
    expression = _element("e")
    if children:
        _append_mathml(expression, children[0])
    result.append(expression)
    if kind == "sSub":
        sub = _element("sub")
        if len(children) > 1:
            _append_mathml(sub, children[1])
        result.append(sub)
    elif kind == "sSup":
        sup = _element("sup")
        if len(children) > 1:
            _append_mathml(sup, children[1], in_script=True)
        result.append(sup)
    else:
        sub = _element("sub")
        sup = _element("sup")
        if len(children) > 1:
            _append_mathml(sub, children[1])
        if len(children) > 2:
            _append_mathml(sup, children[2], in_script=True)
        result.extend((sub, sup))
    target.append(result)


def _append_mathml(target, node, *, in_script: bool = False) -> None:
    tag = node.tag.removeprefix(MATHML_NS)
    children = list(node)

    if tag in {"math", "mrow", "mstyle"}:
        _append_children(target, node, in_script=in_script)
    elif tag == "semantics":
        if children:
            _append_mathml(target, children[0], in_script=in_script)
    elif tag in {"mi", "mn", "mo", "mtext"}:
        text = "".join(node.itertext())
        if "\\" in text:
            raise ValueError(f"Unresolved LaTeX command: {text}")
        variant = node.attrib.get("mathvariant")
        styles = {"normal": "p", "bold": "b", "italic": "i", "bold-italic": "bi"}
        math_style = styles.get(variant, "i" if tag == "mi" and len(text) == 1 else "p")
        target.append(_text_run(text, in_script=in_script, math_style=math_style))
    elif tag == "mfrac":
        if len(children) != 2:
            raise ValueError("Invalid mfrac: expected numerator and denominator")
        fraction = _element("f")
        numerator = _element("num")
        denominator = _element("den")
        if children:
            _append_mathml(numerator, children[0])
        if len(children) > 1:
            _append_mathml(denominator, children[1])
        fraction.extend((numerator, denominator))
        target.append(fraction)
    elif tag == "msub":
        _script(target, node, "sSub")
    elif tag == "msup":
        _script(target, node, "sSup")
    elif tag == "msubsup":
        _script(target, node, "sSubSup")
    elif tag in {"munder", "mover", "munderover"}:
        _append_limits_or_accent(target, node)
    elif tag == "msqrt":
        radical = _element("rad")
        properties = _element("radPr")
        hide_degree = _element("degHide")
        hide_degree.set(qn("m:val"), "1")
        properties.append(hide_degree)
        degree = _element("deg")
        expression = _element("e")
        _append_children(expression, node)
        radical.extend((properties, degree, expression))
        target.append(radical)
    elif tag == "mroot":
        if len(children) != 2:
            raise ValueError("Invalid mroot: expected expression and degree")
        radical = _element("rad")
        degree = _element("deg")
        expression = _element("e")
        if children:
            _append_mathml(expression, children[0])
        if len(children) > 1:
            _append_mathml(degree, children[1])
        radical.extend((degree, expression))
        target.append(radical)
    elif tag == "mfenced":
        delimiter = _element("d")
        properties = _element("dPr")
        begin = _element("begChr")
        begin.set(qn("m:val"), node.attrib.get("open", "("))
        end = _element("endChr")
        end.set(qn("m:val"), node.attrib.get("close", ")"))
        properties.extend((begin, end))
        expression = _element("e")
        _append_children(expression, node)
        delimiter.extend((properties, expression))
        target.append(delimiter)
    elif tag == "mtable":
        if not children or any(row.tag != MATHML_NS + "mtr" for row in children):
            raise ValueError("Unsupported or empty MathML table")
        widths = {len(list(row)) for row in children}
        if len(widths) != 1 or 0 in widths:
            raise ValueError("Invalid MathML matrix: inconsistent column counts")
        matrix = _element("m")
        # Preserve cases/array alignment rather than centering every column.
        properties = _element("mPr")
        columns = _element("mcs")
        table_alignment = node.attrib.get("columnalign", "center").split()
        for index in range(next(iter(widths))):
            alignments = {list(row)[index].attrib.get("columnalign",
                table_alignment[min(index, len(table_alignment) - 1)]) for row in children}
            if len(alignments) != 1 or not alignments <= {"left", "center", "right"}:
                raise ValueError("Unsupported per-row MathML column alignment")
            column, column_properties = _element("mc"), _element("mcPr")
            count, alignment = _element("count"), _element("mcJc")
            count.set(qn("m:val"), "1")
            alignment.set(qn("m:val"), next(iter(alignments)))
            column_properties.extend((count, alignment))
            column.append(column_properties)
            columns.append(column)
        properties.append(columns)
        matrix.append(properties)
        for row_node in children:
            row = _element("mr")
            for cell_node in list(row_node):
                if cell_node.tag != MATHML_NS + "mtd" or any(
                    name in cell_node.attrib for name in ("columnspan", "rowspan")
                ):
                    raise ValueError("Unsupported MathML matrix cell")
                cell = _element("e")
                _append_children(cell, cell_node)
                row.append(cell)
            matrix.append(row)
        target.append(matrix)
    elif tag in {"mtr", "mtd"}:
        _append_children(target, node, in_script=in_script)
    elif tag == "mspace":
        target.append(_text_run(" "))
    elif tag in {"annotation", "annotation-xml"}:
        # These are alternate source representations, not visible math.
        return
    else:
        raise ValueError(f"Unsupported MathML structure: {tag}")


def _inherit_variants(node, inherited: str | None = None) -> None:
    variant = node.attrib.get("mathvariant", inherited)
    if variant is not None and "mathvariant" not in node.attrib:
        node.set("mathvariant", variant)
    for child in node:
        _inherit_variants(child, variant)


def latex_to_omml(latex: str, *, display: bool = True):
    """返回可挂到 ``paragraph._p`` 的 OMML 元素。

    display=True → ``m:oMathPara``（块级）；False → ``m:oMath``（行内）。
    """
    try:
        from latex2mathml.converter import convert
    except ImportError as error:
        raise RuntimeError(
            "原生公式需要 latex2mathml：pip install latex2mathml"
        ) from error

    body = normalize_latex_for_omml(latex)
    if not body:
        raise ValueError("empty latex")

    mathml = ElementTree.fromstring(convert(body, display="block" if display else "inline"))
    if display:
        for node in mathml.iter(MATHML_NS + "msub"):
            base = list(node)[0]
            if base.tag == MATHML_NS + "mo" and "".join(base.itertext()) in {"lim", "liminf", "limsup"}:
                node.tag = MATHML_NS + "munder"
    _inherit_variants(mathml)
    math = _element("oMath")
    _append_mathml(math, mathml)
    if display:
        paragraph = _element("oMathPara")
        paragraph.append(math)
        return paragraph
    return math


def try_latex_to_omml(latex: str, *, display: bool = True):
    """成功返回 OMML 元素，失败返回 None（不抛给调用方）。"""
    try:
        return latex_to_omml(latex, display=display)
    except Exception:
        return None


def clone_omml(element):
    return deepcopy(element)


def omml_available() -> bool:
    try:
        import latex2mathml

        return True
    except ImportError:
        return False
