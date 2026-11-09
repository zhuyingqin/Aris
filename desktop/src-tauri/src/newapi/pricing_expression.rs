//! A bounded, pure subset of New API's billing expressions. Unsupported syntax
//! has no estimate; expressions are never evaluated as JavaScript or shell code.
use chrono::{Datelike, FixedOffset, TimeZone, Timelike, Utc};

#[derive(Clone, Debug)]
enum Token {
    Number(f64),
    Text(String),
    Name(String),
    Op(String),
    End,
}

#[derive(Clone, Debug, Default)]
pub(super) struct Fees {
    pub rates: [f64; 4], // ordinary input, output, cache read, cache creation
    pub used: [bool; 4],
    pub fixed: Option<f64>,
    pub tier: Option<String>,
}

#[derive(Clone, Debug)]
enum Value {
    Number(f64),
    Bool(bool),
    Text(String),
    Fees(Fees),
}

fn tokens(source: &str) -> Option<Vec<Token>> {
    if source.len() > 16_384 {
        return None;
    }
    let source = source.trim();
    let source = source.strip_prefix("v1:").unwrap_or(source);
    let bytes = source.as_bytes();
    let mut result = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if result.len() > 4096 {
            return None;
        }
        let start = index;
        match bytes[index] {
            b if b.is_ascii_whitespace() => {
                index += 1;
            }
            b'"' => {
                index += 1;
                while index < bytes.len() && bytes[index] != b'"' {
                    if bytes[index] == b'\\' {
                        index += 1;
                    }
                    index += 1;
                }
                index += 1;
                let text = serde_json::from_str(source.get(start..index)?).ok()?;
                result.push(Token::Text(text));
            }
            b if b.is_ascii_digit() || b == b'.' => {
                index += 1;
                while index < bytes.len() && (bytes[index].is_ascii_digit() || bytes[index] == b'.')
                {
                    index += 1;
                }
                if matches!(bytes.get(index), Some(b'e' | b'E')) {
                    index += 1;
                    if matches!(bytes.get(index), Some(b'+' | b'-')) {
                        index += 1;
                    }
                    while index < bytes.len() && bytes[index].is_ascii_digit() {
                        index += 1;
                    }
                }
                let number: f64 = source.get(start..index)?.parse().ok()?;
                if !number.is_finite() {
                    return None;
                }
                result.push(Token::Number(number));
            }
            b if b.is_ascii_alphabetic() || b == b'_' => {
                index += 1;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
                {
                    index += 1;
                }
                result.push(Token::Name(source.get(start..index)?.to_string()));
            }
            _ => {
                let two = source.get(index..index + 2).unwrap_or_default();
                if matches!(two, "&&" | "||" | "<=" | ">=" | "==" | "!=") {
                    result.push(Token::Op(two.to_string()));
                    index += 2;
                } else {
                    let one = source.get(index..index + 1)?;
                    if !"()+-*/<>,?:!".contains(one) {
                        return None;
                    }
                    result.push(Token::Op(one.to_string()));
                    index += 1;
                }
            }
        }
    }
    result.push(Token::End);
    Some(result)
}

struct Parser {
    tokens: Vec<Token>,
    index: usize,
    timestamp: i64,
    context_length: f64,
    temporal: bool,
}

impl Parser {
    fn take(&mut self, operator: &str) -> bool {
        if matches!(self.tokens.get(self.index), Some(Token::Op(value)) if value == operator) {
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn expression(&mut self, minimum: u8, depth: usize) -> Option<Value> {
        if depth > 64 {
            return None;
        }
        let token = self.tokens.get(self.index)?.clone();
        self.index += 1;
        let mut left = match token {
            Token::Number(number) => Value::Number(number),
            Token::Text(text) => Value::Text(text),
            Token::Name(name) => self.named(&name, depth + 1)?,
            Token::Op(operator) if operator == "(" => {
                let inner = self.expression(0, depth + 1)?;
                if !self.take(")") {
                    return None;
                }
                inner
            }
            Token::Op(operator) if matches!(operator.as_str(), "-" | "+" | "!") => {
                let inner = self.expression(7, depth + 1)?;
                match (operator.as_str(), inner) {
                    ("-", Value::Number(number)) => Value::Number(-number),
                    ("+", Value::Number(number)) => Value::Number(number),
                    ("!", Value::Bool(value)) => Value::Bool(!value),
                    _ => return None,
                }
            }
            _ => return None,
        };
        loop {
            let operator = match self.tokens.get(self.index)? {
                Token::Op(operator) => operator.clone(),
                _ => break,
            };
            if operator == "?" && minimum == 0 {
                self.index += 1;
                let yes = self.expression(0, depth + 1)?;
                if !self.take(":") {
                    return None;
                }
                let no = self.expression(0, depth + 1)?;
                left = match left {
                    Value::Bool(true) => yes,
                    Value::Bool(false) => no,
                    _ => return None,
                };
                continue;
            }
            let precedence = match operator.as_str() {
                "||" => 1,
                "&&" => 2,
                "==" | "!=" => 3,
                "<" | "<=" | ">" | ">=" => 4,
                "+" | "-" => 5,
                "*" | "/" => 6,
                _ => break,
            };
            if precedence < minimum {
                break;
            }
            self.index += 1;
            let right = self.expression(precedence + 1, depth + 1)?;
            left = binary(&operator, left, right)?;
        }
        Some(left)
    }

    fn named(&mut self, name: &str, depth: usize) -> Option<Value> {
        if !self.take("(") {
            if name == "len" {
                return Some(Value::Number(self.context_length));
            }
            let slot = match name {
                "p" => 0,
                "c" => 1,
                "cr" => 2,
                "cc" => 3,
                _ => return None,
            };
            let mut fees = Fees::default();
            fees.rates[slot] = 1.0;
            fees.used[slot] = true;
            return Some(Value::Fees(fees));
        }
        let first = self.expression(0, depth + 1)?;
        let second = if self.take(",") {
            Some(self.expression(0, depth + 1)?)
        } else {
            None
        };
        if !self.take(")") {
            return None;
        }
        match (name, first, second) {
            ("tier", Value::Text(tier), Some(value)) => {
                if tier.chars().count() > 120 {
                    return None;
                }
                let mut fees = match value {
                    Value::Fees(fees) => fees,
                    Value::Number(0.0) => Fees::default(),
                    _ => return None,
                };
                fees.tier = Some(tier);
                Some(Value::Fees(fees))
            }
            ("fixed", Value::Number(amount), None) if amount >= 0.0 && amount.is_finite() => {
                Some(Value::Fees(Fees {
                    fixed: Some(amount),
                    ..Fees::default()
                }))
            }
            ("hour" | "weekday", Value::Text(zone), None) => {
                // These are the observed gateway zones. Other IANA zones remain unsupported.
                let seconds = match zone.as_str() {
                    "Asia/Shanghai" => 8 * 3600,
                    "UTC" | "Etc/UTC" | "" => 0,
                    _ => return None,
                };
                let date = Utc
                    .timestamp_millis_opt(self.timestamp)
                    .single()?
                    .with_timezone(&FixedOffset::east_opt(seconds)?);
                self.temporal = true;
                Some(Value::Number(if name == "hour" {
                    date.hour() as f64
                } else {
                    date.weekday().num_days_from_sunday() as f64
                }))
            }
            _ => None,
        }
    }
}

fn binary(operator: &str, left: Value, right: Value) -> Option<Value> {
    match (left, right) {
        (Value::Bool(a), Value::Bool(b)) => Some(Value::Bool(match operator {
            "&&" => a && b,
            "||" => a || b,
            "==" => a == b,
            "!=" => a != b,
            _ => return None,
        })),
        (Value::Number(a), Value::Number(b)) => {
            let number = match operator {
                "+" => a + b,
                "-" => a - b,
                "*" => a * b,
                "/" if b != 0.0 => a / b,
                "<" => return Some(Value::Bool(a < b)),
                "<=" => return Some(Value::Bool(a <= b)),
                ">" => return Some(Value::Bool(a > b)),
                ">=" => return Some(Value::Bool(a >= b)),
                "==" => return Some(Value::Bool(a == b)),
                "!=" => return Some(Value::Bool(a != b)),
                _ => return None,
            };
            number.is_finite().then_some(Value::Number(number))
        }
        (Value::Fees(mut a), Value::Fees(b))
            if matches!(operator, "+" | "-")
                && a.fixed.is_none()
                && b.fixed.is_none()
                && a.tier.is_none()
                && b.tier.is_none() =>
        {
            for (left, right) in a.rates.iter_mut().zip(b.rates) {
                *left += if operator == "+" { right } else { -right };
            }
            for (left, right) in a.used.iter_mut().zip(b.used) {
                *left |= right;
            }
            Some(Value::Fees(a))
        }
        (Value::Fees(fees), Value::Number(scale)) if matches!(operator, "*" | "/") => scale_fees(
            fees,
            if operator == "*" {
                scale
            } else if scale != 0.0 {
                1.0 / scale
            } else {
                return None;
            },
        ),
        (Value::Number(scale), Value::Fees(fees)) if operator == "*" => scale_fees(fees, scale),
        _ => None,
    }
}

fn scale_fees(mut fees: Fees, scale: f64) -> Option<Value> {
    if !scale.is_finite() || scale < 0.0 {
        return None;
    }
    for rate in &mut fees.rates {
        *rate *= scale;
    }
    if let Some(amount) = fees.fixed.as_mut() {
        *amount *= scale;
    }
    Some(Value::Fees(fees))
}

pub(super) fn evaluate(source: &str, timestamp: u64, context_length: u32) -> Option<(Fees, bool)> {
    let mut parser = Parser {
        tokens: tokens(source)?,
        index: 0,
        timestamp: timestamp.try_into().ok()?,
        context_length: context_length as f64,
        temporal: false,
    };
    let fees = match parser.expression(0, 0)? {
        Value::Fees(fees) => fees,
        _ => return None,
    };
    if !matches!(parser.tokens.get(parser.index), Some(Token::End))
        || fees
            .rates
            .iter()
            .any(|rate| !rate.is_finite() || *rate < 0.0)
        || fees
            .fixed
            .is_some_and(|rate| !rate.is_finite() || rate < 0.0)
    {
        return None;
    }
    Some((fees, parser.temporal))
}
