"""Rebuild the native-math integration fixture with the bundled converter."""
from pathlib import Path
import sys
from test_docx_accuracy import load

converter = load("patent-disclosure", "md_to_docx")
math = load("patent-disclosure", "math_to_omml")
markdown = r"""# DOCX accuracy fixture

Mixed **bold** and plain text. Inline $x_1^2+\hat{x}$ remains editable.

$$
\left(\frac{x_1^2}{\sqrt{1+y}}\right)\leq 1
$$

$$
\hat{x}+\tilde{y}+\vec{z}+\bar{a}+\underline{b}
$$

$$
\sum_{i=1}^n x_i
$$

$$
\lim_{n\to\infty} a_n
$$

$$
\begin{pmatrix}a&b\\c&d\end{pmatrix}
$$

$$
\begin{cases}x&x\geq0\\-x&x<0\end{cases}
$$

$$
\mathrm{abc}+a^{\circ}+\sqrt[3]{x}
$$

| Label | Value |
| --- | --- |
| Table cell | Original value |
"""
doc = converter.convert_md_to_docx(markdown, None)
paragraph = doc.add_paragraph()
paragraph.add_run("跨格式").bold = True
paragraph.add_run("文本").italic = True
paragraph._p.append(math.latex_to_omml(r"\frac{a}{b}+\hat{x}", display=False))
paragraph.add_run("公式后正文")
doc.sections[0].header.paragraphs[0].add_run("Original header")
converter.save_docx_atomically(doc, Path(sys.argv[1]))
converter.get_math_stats().report()
