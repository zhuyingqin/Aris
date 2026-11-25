// Starter templates for journals, conferences and theses. Every class used
// here ships with TeX Live (checked with kpsewhich), and each template is a
// small, compiling project — a `main.tex` plus a `refs.bib` (and chapter
// files for theses) — rather than a single file that cites nothing.
import type { Language } from "../store";
import { tr } from "../language";
import type { TypesetTemplate } from "./TypesetLibraryCopy";
import { escapeLatexText } from "./latexText";

export type StarterTemplateId =
  | "ieee-conference"
  | "ieee-journal"
  | "acm-sigconf"
  | "elsevier"
  | "springer-lncs"
  | "aps-revtex"
  | "thesis-zh"
  | "thesis-en";

export interface StarterTemplateFile {
  /** Relative to the new document's folder. */
  path: string;
  content: string;
}

export interface StarterTemplate {
  id: StarterTemplateId;
  /** Which library shelf the document lands on. */
  kind: TypesetTemplate;
  group: "journal" | "thesis";
  label: (language: Language) => string;
  description: (language: Language) => string;
  /** `main.tex` first. */
  files: (title: string) => StarterTemplateFile[];
}

const SAMPLE_BIB = `@article{lecun2015deep,
  title   = {Deep learning},
  author  = {LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey},
  journal = {Nature},
  volume  = {521},
  number  = {7553},
  pages   = {436--444},
  year    = {2015}
}

@inproceedings{vaswani2017attention,
  title     = {Attention Is All You Need},
  author    = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N. and Kaiser, Lukasz and Polosukhin, Illia},
  booktitle = {Advances in Neural Information Processing Systems},
  year      = {2017}
}
`;

const bib = (): StarterTemplateFile => ({ path: "refs.bib", content: SAMPLE_BIB });

function ieee(title: string, journal: boolean): StarterTemplateFile[] {
  const escaped = escapeLatexText(title);
  return [{
    path: "main.tex",
    content: `\\documentclass[${journal ? "journal" : "conference"}]{IEEEtran}
\\usepackage{cite}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\begin{document}

\\title{${escaped}}
\\author{\\IEEEauthorblockN{First Author}
\\IEEEauthorblockA{Department, University\\\\
City, Country\\\\
email@example.com}}

\\maketitle

\\begin{abstract}
Summarize the problem, the method and the main result in one paragraph.
\\end{abstract}

\\begin{IEEEkeywords}
keyword one, keyword two
\\end{IEEEkeywords}

\\section{Introduction}
Deep learning~\\cite{lecun2015deep} and attention models~\\cite{vaswani2017attention} motivate this work.

\\section{Method}
State the model, for example $y = f(x;\\theta)$.

\\section{Experiments}
Describe the data, baselines and results.

\\section{Conclusion}
Summarize the findings.

\\bibliographystyle{IEEEtran}
\\bibliography{refs}

\\end{document}
`,
  }, bib()];
}

function acm(title: string): StarterTemplateFile[] {
  const escaped = escapeLatexText(title);
  return [{
    path: "main.tex",
    content: `\\documentclass[sigconf,nonacm]{acmart}

\\begin{document}

\\title{${escaped}}
\\author{First Author}
\\affiliation{%
  \\institution{University}
  \\city{City}
  \\country{Country}}
\\email{email@example.com}

\\begin{abstract}
Summarize the problem, the method and the main result in one paragraph.
\\end{abstract}

\\keywords{keyword one, keyword two}

\\maketitle

\\section{Introduction}
Deep learning~\\cite{lecun2015deep} and attention models~\\cite{vaswani2017attention} motivate this work.

\\section{Method}
State the model, for example $y = f(x;\\theta)$.

\\section{Conclusion}
Summarize the findings.

\\bibliographystyle{ACM-Reference-Format}
\\bibliography{refs}

\\end{document}
`,
  }, bib()];
}

function elsevier(title: string): StarterTemplateFile[] {
  const escaped = escapeLatexText(title);
  return [{
    path: "main.tex",
    content: `\\documentclass[preprint,12pt]{elsarticle}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}

\\journal{Journal Name}

\\begin{document}

\\begin{frontmatter}
\\title{${escaped}}
\\author{First Author}
\\affiliation{organization={University},
            city={City},
            country={Country}}

\\begin{abstract}
Summarize the problem, the method and the main result in one paragraph.
\\end{abstract}

\\begin{keyword}
keyword one \\sep keyword two
\\end{keyword}
\\end{frontmatter}

\\section{Introduction}
Deep learning~\\cite{lecun2015deep} and attention models~\\cite{vaswani2017attention} motivate this work.

\\section{Method}
State the model, for example $y = f(x;\\theta)$.

\\section{Conclusion}
Summarize the findings.

\\bibliographystyle{elsarticle-num}
\\bibliography{refs}

\\end{document}
`,
  }, bib()];
}

function lncs(title: string): StarterTemplateFile[] {
  const escaped = escapeLatexText(title);
  return [{
    path: "main.tex",
    content: `\\documentclass[runningheads]{llncs}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\begin{document}

\\title{${escaped}}
\\author{First Author\\inst{1}}
\\authorrunning{F. Author}
\\institute{University, City, Country\\\\
\\email{email@example.com}}

\\maketitle

\\begin{abstract}
Summarize the problem, the method and the main result in one paragraph.

\\keywords{keyword one \\and keyword two}
\\end{abstract}

\\section{Introduction}
Deep learning~\\cite{lecun2015deep} and attention models~\\cite{vaswani2017attention} motivate this work.

\\section{Method}
State the model, for example $y = f(x;\\theta)$.

\\section{Conclusion}
Summarize the findings.

\\bibliographystyle{splncs04}
\\bibliography{refs}

\\end{document}
`,
  }, bib()];
}

function revtex(title: string): StarterTemplateFile[] {
  const escaped = escapeLatexText(title);
  return [{
    path: "main.tex",
    content: `\\documentclass[aps,prl,reprint,amsmath,amssymb]{revtex4-2}
\\usepackage{graphicx}

\\begin{document}

\\title{${escaped}}
\\author{First Author}
\\affiliation{Department, University, City, Country}

\\begin{abstract}
Summarize the problem, the method and the main result in one paragraph.
\\end{abstract}

\\maketitle

\\section{Introduction}
Deep learning~\\cite{lecun2015deep} and attention models~\\cite{vaswani2017attention} motivate this work.

\\section{Results}
State the main relation, for example $E = mc^2$.

\\bibliography{refs}

\\end{document}
`,
  }, bib()];
}

function thesisZh(title: string): StarterTemplateFile[] {
  const escaped = escapeLatexText(title);
  return [
    {
      path: "main.tex",
      content: `% !TeX program = xelatex
\\documentclass[UTF8,zihao=-4,openany]{ctexbook}
\\usepackage[a4paper,margin=2.5cm]{geometry}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage[numbers,sort&compress]{natbib}
\\usepackage{hyperref}

\\newtheorem{theorem}{定理}[chapter]
\\newtheorem{definition}{定义}[chapter]

\\title{${escaped}}
\\author{作者姓名}
\\date{\\today}

\\begin{document}

\\frontmatter
\\maketitle

\\chapter*{摘\\quad 要}
\\addcontentsline{toc}{chapter}{摘要}
在这里用一段话概括研究问题、方法和主要结论。

\\textbf{关键词：}关键词一；关键词二

\\tableofcontents

\\mainmatter
\\input{chapters/introduction}
\\input{chapters/method}
\\input{chapters/conclusion}

\\backmatter
\\bibliographystyle{plainnat}
\\bibliography{refs}

\\chapter{致谢}
感谢导师与同学的帮助。

\\end{document}
`,
    },
    {
      path: "chapters/introduction.tex",
      content: `\\chapter{绪论}
\\label{chap:introduction}

\\section{研究背景}
深度学习\\cite{lecun2015deep}与注意力模型\\cite{vaswani2017attention}推动了本课题的研究。

\\section{本文结构}
第\\ref{chap:method}章介绍研究方法，第\\ref{chap:conclusion}章总结全文。
`,
    },
    {
      path: "chapters/method.tex",
      content: `\\chapter{研究方法}
\\label{chap:method}

\\begin{definition}
设模型为 $y = f(x;\\theta)$，其中 $\\theta$ 为待学习参数。
\\end{definition}

\\begin{equation}
  \\mathcal{L}(\\theta) = \\frac{1}{N}\\sum_{i=1}^{N} \\ell\\bigl(f(x_i;\\theta), y_i\\bigr)
  \\label{eq:loss}
\\end{equation}

式~\\eqref{eq:loss} 给出了训练目标。
`,
    },
    {
      path: "chapters/conclusion.tex",
      content: `\\chapter{总结与展望}
\\label{chap:conclusion}

总结本文的主要贡献，并讨论后续工作。
`,
    },
    bib(),
  ];
}

function thesisEn(title: string): StarterTemplateFile[] {
  const escaped = escapeLatexText(title);
  return [
    {
      path: "main.tex",
      content: `\\documentclass[12pt,a4paper,oneside]{book}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage[numbers,sort&compress]{natbib}
\\usepackage{hyperref}

\\newtheorem{theorem}{Theorem}[chapter]
\\newtheorem{definition}{Definition}[chapter]

\\title{${escaped}}
\\author{Author Name}
\\date{\\today}

\\begin{document}

\\frontmatter
\\maketitle

\\chapter*{Abstract}
\\addcontentsline{toc}{chapter}{Abstract}
Summarize the research question, the method and the main findings.

\\tableofcontents

\\mainmatter
\\input{chapters/introduction}
\\input{chapters/method}
\\input{chapters/conclusion}

\\backmatter
\\bibliographystyle{plainnat}
\\bibliography{refs}

\\end{document}
`,
    },
    {
      path: "chapters/introduction.tex",
      content: `\\chapter{Introduction}
\\label{chap:introduction}

\\section{Background}
Deep learning~\\cite{lecun2015deep} and attention models~\\cite{vaswani2017attention} motivate this thesis.

\\section{Outline}
Chapter~\\ref{chap:method} presents the method and Chapter~\\ref{chap:conclusion} concludes.
`,
    },
    {
      path: "chapters/method.tex",
      content: `\\chapter{Method}
\\label{chap:method}

\\begin{definition}
Let the model be $y = f(x;\\theta)$ with learnable parameters $\\theta$.
\\end{definition}

\\begin{equation}
  \\mathcal{L}(\\theta) = \\frac{1}{N}\\sum_{i=1}^{N} \\ell\\bigl(f(x_i;\\theta), y_i\\bigr)
  \\label{eq:loss}
\\end{equation}

Equation~\\eqref{eq:loss} is the training objective.
`,
    },
    {
      path: "chapters/conclusion.tex",
      content: `\\chapter{Conclusion}
\\label{chap:conclusion}

Summarize the contributions and discuss future work.
`,
    },
    bib(),
  ];
}

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    id: "ieee-conference",
    kind: "article",
    group: "journal",
    label: (language) => tr(language, "IEEE 会议论文", "IEEE conference", "Congreso IEEE"),
    description: (language) => tr(language, "IEEEtran 双栏会议格式", "IEEEtran two-column conference format", "Formato de congreso IEEEtran a dos columnas"),
    files: (title) => ieee(title, false),
  },
  {
    id: "ieee-journal",
    kind: "article",
    group: "journal",
    label: (language) => tr(language, "IEEE 期刊论文", "IEEE journal", "Revista IEEE"),
    description: (language) => tr(language, "IEEEtran 期刊格式", "IEEEtran journal format", "Formato de revista IEEEtran"),
    files: (title) => ieee(title, true),
  },
  {
    id: "acm-sigconf",
    kind: "article",
    group: "journal",
    label: (language) => tr(language, "ACM 会议论文", "ACM conference", "Congreso ACM"),
    description: (language) => tr(language, "acmart sigconf 格式", "acmart sigconf format", "Formato acmart sigconf"),
    files: acm,
  },
  {
    id: "elsevier",
    kind: "article",
    group: "journal",
    label: (language) => tr(language, "Elsevier 期刊", "Elsevier journal", "Revista Elsevier"),
    description: (language) => tr(language, "elsarticle 投稿格式", "elsarticle submission format", "Formato de envío elsarticle"),
    files: elsevier,
  },
  {
    id: "springer-lncs",
    kind: "article",
    group: "journal",
    label: (language) => tr(language, "Springer LNCS", "Springer LNCS", "Springer LNCS"),
    description: (language) => tr(language, "llncs 会议论文集格式", "llncs proceedings format", "Formato de actas llncs"),
    files: lncs,
  },
  {
    id: "aps-revtex",
    kind: "article",
    group: "journal",
    label: (language) => tr(language, "APS 物理期刊", "APS physics journal", "Revista de física APS"),
    description: (language) => tr(language, "REVTeX 4.2（Physical Review）", "REVTeX 4.2 (Physical Review)", "REVTeX 4.2 (Physical Review)"),
    files: revtex,
  },
  {
    id: "thesis-zh",
    kind: "report",
    group: "thesis",
    label: (language) => tr(language, "中文学位论文", "Chinese thesis", "Tesis en chino"),
    description: (language) => tr(language, "ctexbook，分章节文件，XeLaTeX 编译", "ctexbook with chapter files, built with XeLaTeX", "ctexbook con capítulos, compilado con XeLaTeX"),
    files: thesisZh,
  },
  {
    id: "thesis-en",
    kind: "report",
    group: "thesis",
    label: (language) => tr(language, "英文学位论文", "English thesis", "Tesis en inglés"),
    description: (language) => tr(language, "book 类，分章节文件", "book class with chapter files", "Clase book con capítulos"),
    files: thesisEn,
  },
];

export function starterTemplate(id: StarterTemplateId): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((template) => template.id === id);
}
