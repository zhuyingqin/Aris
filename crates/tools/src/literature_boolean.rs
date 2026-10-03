//! Provider-independent boolean search expressions.
//!
//! A systematic search is designed as concept blocks — synonyms joined by `OR`,
//! blocks joined by `AND` — and every index then needs that design in its own
//! dialect: Scopus wants `TITLE-ABS-KEY(...)` with quoted phrases, arXiv wants
//! `all:` prefixes and `ANDNOT`, and Crossref and Semantic Scholar parse no
//! boolean syntax at all. Asking the caller for five hand-written strings is how
//! a protocol ends up with one source silently searching a phrase it never
//! meant; asking for one expression and compiling it here is how findpapers and
//! litsearchr approach the same problem.
//!
//! Syntax (operators are upper case so they never swallow a content word):
//!
//! ```text
//! ([continual learning] OR [lifelong learning]) AND [time series] AND NOT [survey]
//! ```
//!
//! A term is `[bracketed]`, `"quoted"`, or a run of bare words. `NOT` is only
//! valid after `AND`, because a bare negation selects most of an index.

use std::collections::BTreeSet;

const MAX_TERMS: usize = 60;
const MAX_TERM_CHARS: usize = 120;
/// Keyword streams a bag-of-words source receives for one expression. Each
/// stream is a full request against the source budget, so this bounds the cost
/// of a long synonym list rather than its coverage.
const MAX_BAG_STREAMS: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BoolExpr {
    Term(String),
    And(Vec<BoolExpr>),
    Or(Vec<BoolExpr>),
    Not(Box<BoolExpr>),
}

/// One provider request compiled from an expression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CompiledStream {
    pub kind: String,
    pub query: String,
    pub rationale: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Open,
    Close,
    And,
    Or,
    Not,
    Term(String),
    /// A bare word; adjacent bare words form one multi-word term.
    Word(String),
}

fn tokenize(input: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let mut characters = input.chars().peekable();
    while let Some(&character) = characters.peek() {
        match character {
            _ if character.is_whitespace() => {
                characters.next();
            }
            '(' => {
                characters.next();
                tokens.push(Token::Open);
            }
            ')' => {
                characters.next();
                tokens.push(Token::Close);
            }
            '[' | '"' => {
                characters.next();
                let close = if character == '[' { ']' } else { '"' };
                let mut text = String::new();
                let mut closed = false;
                for next in characters.by_ref() {
                    if next == close {
                        closed = true;
                        break;
                    }
                    text.push(next);
                }
                if !closed {
                    return Err(format!("booleanQuery has an unclosed {character}"));
                }
                tokens.push(Token::Term(text));
            }
            ']' => return Err("booleanQuery has a `]` without its `[`".to_string()),
            _ => {
                let mut word = String::new();
                while let Some(&next) = characters.peek() {
                    if next.is_whitespace() || matches!(next, '(' | ')' | '[' | ']' | '"') {
                        break;
                    }
                    word.push(next);
                    characters.next();
                }
                tokens.push(match word.as_str() {
                    "AND" => Token::And,
                    "OR" => Token::Or,
                    "NOT" => Token::Not,
                    _ => Token::Word(word),
                });
            }
        }
    }
    // Merge runs of bare words into one term, so `time series AND drift` reads
    // as `[time series] AND [drift]`, which is what a person means by it.
    let mut merged: Vec<Token> = Vec::new();
    for token in tokens {
        match (merged.last_mut(), token) {
            (Some(Token::Word(previous)), Token::Word(word)) => {
                previous.push(' ');
                previous.push_str(&word);
            }
            (_, token) => merged.push(token),
        }
    }
    Ok(merged
        .into_iter()
        .map(|token| match token {
            Token::Word(word) => Token::Term(word),
            token => token,
        })
        .collect())
}

struct Parser {
    tokens: Vec<Token>,
    position: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.position)
    }

    fn next(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.position).cloned();
        self.position += 1;
        token
    }

    fn parse_or(&mut self) -> Result<BoolExpr, String> {
        let mut children = vec![self.parse_and()?];
        while self.peek() == Some(&Token::Or) {
            self.next();
            children.push(self.parse_and()?);
        }
        Ok(flatten(BoolExpr::Or(children)))
    }

    fn parse_and(&mut self) -> Result<BoolExpr, String> {
        if self.peek() == Some(&Token::Not) {
            return Err(
                "booleanQuery NOT must follow AND (`[a] AND NOT [b]`); a bare negation would select most of an index"
                    .to_string(),
            );
        }
        let mut children = vec![self.parse_unary()?];
        while self.peek() == Some(&Token::And) {
            self.next();
            if self.peek() == Some(&Token::Not) {
                self.next();
                children.push(BoolExpr::Not(Box::new(self.parse_unary()?)));
            } else {
                children.push(self.parse_unary()?);
            }
        }
        Ok(flatten(BoolExpr::And(children)))
    }

    fn parse_unary(&mut self) -> Result<BoolExpr, String> {
        match self.next() {
            Some(Token::Open) => {
                let inner = self.parse_or()?;
                match self.next() {
                    Some(Token::Close) => Ok(inner),
                    _ => Err("booleanQuery has an unbalanced `(`".to_string()),
                }
            }
            Some(Token::Term(text)) => {
                let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
                if text.is_empty() {
                    return Err("booleanQuery has an empty term".to_string());
                }
                Ok(BoolExpr::Term(text))
            }
            Some(Token::Close) => Err("booleanQuery has a `)` without its `(`".to_string()),
            Some(Token::And | Token::Or) => {
                Err("booleanQuery has an operator where a term was expected".to_string())
            }
            Some(Token::Not) => {
                Err("booleanQuery NOT must follow AND (`[a] AND NOT [b]`)".to_string())
            }
            Some(Token::Word(_)) => unreachable!("words are merged into terms"),
            None => Err("booleanQuery ends where a term was expected".to_string()),
        }
    }
}

/// Collapse nested groups of the same operator and single-child groups.
fn flatten(expr: BoolExpr) -> BoolExpr {
    match expr {
        BoolExpr::And(children) => {
            let mut flat = Vec::new();
            for child in children {
                match child {
                    BoolExpr::And(inner) => flat.extend(inner),
                    other => flat.push(other),
                }
            }
            if flat.len() == 1 {
                flat.pop().expect("one child")
            } else {
                BoolExpr::And(flat)
            }
        }
        BoolExpr::Or(children) => {
            let mut flat = Vec::new();
            for child in children {
                match child {
                    BoolExpr::Or(inner) => flat.extend(inner),
                    other => flat.push(other),
                }
            }
            if flat.len() == 1 {
                flat.pop().expect("one child")
            } else {
                BoolExpr::Or(flat)
            }
        }
        other => other,
    }
}

fn contains_cjk(value: &str) -> bool {
    value.chars().any(|character| {
        matches!(character as u32,
            0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF)
    })
}

fn validate(expr: &BoolExpr, terms: &mut usize) -> Result<(), String> {
    match expr {
        BoolExpr::Term(text) => {
            *terms += 1;
            if text.chars().count() > MAX_TERM_CHARS {
                return Err(format!(
                    "booleanQuery term is longer than {MAX_TERM_CHARS} characters: {text:?}"
                ));
            }
            if contains_cjk(text) {
                return Err(format!(
                    "booleanQuery term {text:?} is not in English. The indexes carry English titles and abstracts; translate each concept into English academic terms."
                ));
            }
            Ok(())
        }
        BoolExpr::Or(children) => children.iter().try_for_each(|child| {
            if matches!(child, BoolExpr::Not(_)) {
                return Err("booleanQuery NOT cannot be an OR alternative".to_string());
            }
            validate(child, terms)
        }),
        BoolExpr::And(children) => {
            if children
                .iter()
                .all(|child| matches!(child, BoolExpr::Not(_)))
            {
                return Err(
                    "booleanQuery AND needs at least one term that is not negated".to_string(),
                );
            }
            children.iter().try_for_each(|child| validate(child, terms))
        }
        BoolExpr::Not(inner) => validate(inner, terms),
    }
}

/// Parse and validate one expression.
pub(crate) fn parse(input: &str) -> Result<BoolExpr, String> {
    let tokens = tokenize(input.trim())?;
    if tokens.is_empty() {
        return Err("booleanQuery is empty".to_string());
    }
    let mut parser = Parser {
        tokens,
        position: 0,
    };
    let expr = parser.parse_or()?;
    if let Some(token) = parser.peek() {
        return Err(match token {
            Token::Close => "booleanQuery has a `)` without its `(`".to_string(),
            _ => "booleanQuery has two terms with no AND/OR between them".to_string(),
        });
    }
    let mut terms = 0;
    validate(&expr, &mut terms)?;
    if terms > MAX_TERMS {
        return Err(format!(
            "booleanQuery has {terms} terms; keep it under {MAX_TERMS} by grouping synonyms per concept"
        ));
    }
    Ok(expr)
}

#[derive(Clone, Copy)]
enum Dialect {
    Scopus,
    OpenAlex,
    Arxiv,
}

fn needs_quotes(text: &str) -> bool {
    text.chars()
        .any(|character| character.is_whitespace() || !character.is_alphanumeric())
}

fn render_term(text: &str, dialect: Dialect) -> String {
    // A term may not smuggle a quote into the compiled query and end its phrase
    // early; the provider would read the remainder as syntax.
    let text = text.replace('"', " ");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let quoted = if needs_quotes(&text) {
        format!("\"{text}\"")
    } else {
        text
    };
    match dialect {
        Dialect::Scopus | Dialect::OpenAlex => quoted,
        Dialect::Arxiv => format!("all:{quoted}"),
    }
}

fn render_child(expr: &BoolExpr, dialect: Dialect) -> String {
    match expr {
        BoolExpr::Term(_) => render(expr, dialect),
        _ => format!("({})", render(expr, dialect)),
    }
}

fn render(expr: &BoolExpr, dialect: Dialect) -> String {
    match expr {
        BoolExpr::Term(text) => render_term(text, dialect),
        BoolExpr::Or(children) => children
            .iter()
            .map(|child| render_child(child, dialect))
            .collect::<Vec<_>>()
            .join(" OR "),
        BoolExpr::And(children) => {
            let mut rendered = children
                .iter()
                .filter(|child| !matches!(child, BoolExpr::Not(_)))
                .map(|child| render_child(child, dialect))
                .collect::<Vec<_>>()
                .join(" AND ");
            for child in children {
                if let BoolExpr::Not(inner) = child {
                    let operator = match dialect {
                        Dialect::Scopus => " AND NOT ",
                        // OpenAlex documents `NOT` as a binary operator.
                        Dialect::OpenAlex => " NOT ",
                        Dialect::Arxiv => " ANDNOT ",
                    };
                    rendered.push_str(operator);
                    rendered.push_str(&render_child(inner, dialect));
                }
            }
            rendered
        }
        BoolExpr::Not(inner) => render_child(inner, dialect),
    }
}

fn contains_not(expr: &BoolExpr) -> bool {
    match expr {
        BoolExpr::Term(_) => false,
        BoolExpr::Not(_) => true,
        BoolExpr::And(children) | BoolExpr::Or(children) => children.iter().any(contains_not),
    }
}

/// Keyword streams for a source that matches words, not syntax.
///
/// An OR group contributes its alternatives as separate streams; an AND group
/// rotates through each block's alternatives in step, so stream *i* takes the
/// *i*-th synonym of every concept. Every synonym is asked once without the
/// cost of the full cross product.
fn bag_streams(expr: &BoolExpr) -> Vec<Vec<String>> {
    match expr {
        BoolExpr::Term(text) => vec![vec![text.clone()]],
        BoolExpr::Not(_) => Vec::new(),
        BoolExpr::Or(children) => {
            let mut streams = Vec::new();
            let mut seen = BTreeSet::new();
            for child in children {
                for stream in bag_streams(child) {
                    if seen.insert(stream.join(" ").to_ascii_lowercase()) {
                        streams.push(stream);
                    }
                }
            }
            streams
        }
        BoolExpr::And(children) => {
            let blocks = children
                .iter()
                .map(bag_streams)
                .filter(|block| !block.is_empty())
                .collect::<Vec<_>>();
            let width = blocks
                .iter()
                .map(Vec::len)
                .max()
                .unwrap_or(0)
                .min(MAX_BAG_STREAMS);
            (0..width)
                .map(|index| {
                    blocks
                        .iter()
                        .flat_map(|block| block[index % block.len()].clone())
                        .collect()
                })
                .collect()
        }
    }
}

/// Sources that match words rather than syntax, so a record they return has
/// not been checked against the expression at all.
pub(crate) fn evaluated_locally(source: &str) -> bool {
    matches!(source, "crossref" | "semantic-scholar")
}

/// Lower-case alphanumeric words, so `time-series` and `Time Series` compare
/// equal and a term only matches at word boundaries.
fn loose(value: &str) -> String {
    value
        .to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn matches_loose(expr: &BoolExpr, haystack: &str) -> bool {
    match expr {
        BoolExpr::Term(text) => {
            let needle = loose(text);
            !needle.is_empty() && haystack.contains(&format!(" {needle} "))
        }
        BoolExpr::Or(children) => children.iter().any(|child| matches_loose(child, haystack)),
        BoolExpr::And(children) => children.iter().all(|child| match child {
            BoolExpr::Not(inner) => !matches_loose(inner, haystack),
            other => matches_loose(other, haystack),
        }),
        BoolExpr::Not(inner) => !matches_loose(inner, haystack),
    }
}

/// Whether a record's own text (title and abstract) satisfies the expression.
///
/// A keyword source ranks anything sharing a word with the query — measured on
/// Crossref, a stream for continual-learning anomaly detection returned
/// surgical case reports that matched only `detection` — so its records are
/// checked here against the boolean design they were never asked about.
pub(crate) fn matches_text(expr: &BoolExpr, text: &str) -> bool {
    matches_loose(expr, &format!(" {} ", loose(text)))
}

/// Compile one expression into the requests a source receives. An unknown
/// source compiles to nothing, which the run records as a coverage gap.
pub(crate) fn compile_for_source(expr: &BoolExpr, source: &str) -> Vec<CompiledStream> {
    let boolean = |dialect: Dialect, name: &str, wrap: fn(String) -> String| {
        vec![CompiledStream {
            kind: "boolean".to_string(),
            query: wrap(render(expr, dialect)),
            rationale: format!("The caller's booleanQuery, compiled into {name} syntax."),
        }]
    };
    match source {
        "scopus" => boolean(Dialect::Scopus, "Scopus", |query| {
            format!("TITLE-ABS-KEY({query})")
        }),
        "openalex" => boolean(Dialect::OpenAlex, "OpenAlex", |query| query),
        "arxiv" => boolean(Dialect::Arxiv, "arXiv", |query| query),
        "crossref" | "semantic-scholar" => {
            let dropped_not = contains_not(expr);
            let streams = bag_streams(expr);
            let count = streams.len().min(MAX_BAG_STREAMS);
            streams
                .into_iter()
                .take(MAX_BAG_STREAMS)
                .enumerate()
                .map(|(index, terms)| {
                    let mut query = terms.join(" ");
                    if source == "semantic-scholar" {
                        // Its relevance endpoint splits on hyphens inconsistently.
                        query = query.replace(['-', '‐', '‑', '–', '—'], " ");
                    }
                    let query = query.split_whitespace().collect::<Vec<_>>().join(" ");
                    let mut rationale = format!(
                        "The caller's booleanQuery as keyword stream {} of {count}: this source matches words, not boolean syntax, so each stream takes one synonym from every concept block.",
                        index + 1
                    );
                    if dropped_not {
                        rationale.push_str(" NOT clauses cannot be expressed here and were not sent; screen those records out downstream.");
                    }
                    CompiledStream {
                        kind: if index == 0 {
                            "boolean".to_string()
                        } else {
                            format!("boolean_synonyms_{index}")
                        },
                        query,
                        rationale,
                    }
                })
                .collect()
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
#[path = "tests/literature_boolean.rs"]
mod tests;
