//! A small XML reader for bank statements (src/core/camt/xml.ts). It builds a tree of elements and nothing else: no DTD, no
//! entities other than the five built-in ones and character references, no namespace lookups (names are kept without their
//! prefix), no external resources, no code. Because entities cannot be defined, an "XML bomb" or an external-entity file
//! (XXE) has nothing to work with: a DOCTYPE is refused outright. It does not recurse, so deeply nested input cannot
//! overflow the stack.
use crate::jsstr::{is_js_space, js_trim};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XmlFailure {
    Dtd,
    Broken,
    TooLarge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XmlError {
    pub failure: XmlFailure,
    pub message: &'static str,
}

/// Nesting deeper than this is not a statement.
const MAX_DEPTH: usize = 64;
/// More elements than this (about a 20 MB file) is refused before memory runs out.
const MAX_ELEMENTS: usize = 2_000_000;

fn fail<T>(message: &'static str) -> Result<T, XmlError> {
    Err(XmlError { failure: XmlFailure::Broken, message })
}

pub struct XmlNode {
    /// Element name without namespace prefix.
    name: String,
    /// In the order they were written; a repeated name appears twice and the last one counts.
    attrs: Vec<(String, String)>,
    children: Vec<usize>,
    /// The element's own text (trimmed).
    text: String,
}

/// The tree: elements in document order, the root first.
pub struct XmlDoc {
    nodes: Vec<XmlNode>,
}

/// An element of a document.
#[derive(Clone, Copy)]
pub struct Node<'a> {
    doc: &'a XmlDoc,
    id: usize,
}

impl<'a> Node<'a> {
    fn data(&self) -> &'a XmlNode {
        &self.doc.nodes[self.id]
    }

    pub fn name(&self) -> &'a str {
        &self.data().name
    }

    pub fn text(&self) -> &'a str {
        &self.data().text
    }

    /// An attribute's value, with the key as written (prefix included).
    pub fn attr(&self, key: &str) -> Option<&'a str> {
        self.data().attrs.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    /// The attribute values in the order `Object.values` of the JavaScript object gives them: keys that are array indexes
    /// first, ascending, then the others in the order they were first written.
    pub fn attr_values(&self) -> Vec<&'a str> {
        let mut seen: HashMap<&str, usize> = HashMap::new();
        let mut unique: Vec<(&str, &str)> = Vec::new();
        for (k, v) in &self.data().attrs {
            match seen.get(k.as_str()) {
                Some(&at) => unique[at].1 = v,
                None => {
                    seen.insert(k, unique.len());
                    unique.push((k, v));
                }
            }
        }
        let index = |k: &str| k.parse::<u64>().ok().filter(|n| *n < 4_294_967_295 && n.to_string() == k);
        let mut indexed: Vec<(u64, &str)> = unique.iter().filter_map(|(k, v)| index(k).map(|n| (n, *v))).collect();
        indexed.sort_by_key(|(n, _)| *n);
        indexed.into_iter().map(|(_, v)| v).chain(unique.iter().filter(|(k, _)| index(k).is_none()).map(|(_, v)| *v)).collect()
    }

    pub fn children(&self) -> impl Iterator<Item = Node<'a>> + 'a {
        let doc = self.doc;
        self.data().children.iter().map(move |&id| Node { doc, id })
    }

    pub fn child_count(&self) -> usize {
        self.data().children.len()
    }

    /// The first child with this name.
    pub fn child(&self, name: &str) -> Option<Node<'a>> {
        self.children().find(|c| c.name() == name)
    }

    /// All children with this name.
    pub fn kids(&self, name: &str) -> Vec<Node<'a>> {
        self.children().filter(|c| c.name() == name).collect()
    }
}

impl XmlDoc {
    pub fn root(&self) -> Node<'_> {
        Node { doc: self, id: 0 }
    }
}

/// `child(child(n, a), b)...`
pub fn path<'a>(n: Option<Node<'a>>, names: &[&str]) -> Option<Node<'a>> {
    names.iter().fold(n, |cur, name| cur.and_then(|c| c.child(name)))
}

/// The text at a path, or "".
pub fn text_at<'a>(n: Option<Node<'a>>, names: &[&str]) -> &'a str {
    path(n, names).map_or("", |n| n.text())
}

/// Replaces `&lt;` `&gt;` `&amp;` `&quot;` `&apos;` and character references; any other `&name;` is an error, a bare `&` stays.
fn decode(text: &str) -> Result<String, XmlError> {
    if !text.contains('&') {
        return Ok(text.to_owned());
    }
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut copied = 0;
    while i < b.len() {
        if b[i] != b'&' {
            i += 1;
            continue;
        }
        // `&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]+);`
        let rest = &b[i + 1..];
        let (kind, len) = if rest.first() == Some(&b'#') && rest.get(1) == Some(&b'x') {
            ('x', rest[2..].iter().take_while(|c| c.is_ascii_hexdigit()).count())
        } else if rest.first() == Some(&b'#') {
            ('d', rest[1..].iter().take_while(|c| c.is_ascii_digit()).count())
        } else {
            ('n', rest.iter().take_while(|c| c.is_ascii_alphabetic()).count())
        };
        let prefix = match kind {
            'x' => 2,
            'd' => 1,
            _ => 0,
        };
        let valid = match kind {
            'x' => (1..=6).contains(&len),
            'd' => (1..=7).contains(&len),
            _ => len >= 1,
        };
        if !valid || rest.get(prefix + len) != Some(&b';') {
            i += 1;
            continue;
        }
        let name = &text[i + 1 + prefix..i + 1 + prefix + len];
        out.push_str(&text[copied..i]);
        if kind == 'n' {
            out.push(match name {
                "lt" => '<',
                "gt" => '>',
                "amp" => '&',
                "quot" => '"',
                "apos" => '\'',
                _ => return Err(XmlError { failure: XmlFailure::Broken, message: "Unknown entity" }),
            });
        } else {
            let code = u32::from_str_radix(name, if kind == 'x' { 16 } else { 10 }).unwrap_or(0);
            match char::from_u32(code).filter(|_| code >= 1) {
                Some(c) => out.push(c),
                None => return Err(XmlError { failure: XmlFailure::Broken, message: "Bad character reference" }),
            }
        }
        i += prefix + len + 2;
        copied = i;
    }
    out.push_str(&text[copied..]);
    Ok(out)
}

/// `NAME = /[^\s/>=<"']+/y` at `pos`: the end of the name there, or `None`.
fn name_at(src: &str, pos: usize) -> Option<usize> {
    let end = src[pos..].find(|c: char| is_js_space(c) || matches!(c, '/' | '>' | '=' | '<' | '"' | '\'')).map_or(src.len(), |n| pos + n);
    (end > pos).then_some(end)
}

fn skip_space(src: &str, pos: usize) -> usize {
    src[pos..].find(|c: char| !is_js_space(c)).map_or(src.len(), |n| pos + n)
}

/// The name without its namespace prefix: `name.replace(/^.*:/, '')`.
fn local(name: &str) -> &str {
    name.rfind(':').map_or(name, |i| &name[i + 1..])
}

pub fn parse_xml(source: &str) -> Result<XmlDoc, XmlError> {
    let src = source.strip_prefix('\u{feff}').unwrap_or(source);
    let mut nodes: Vec<XmlNode> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut texts: Vec<String> = Vec::new();
    let mut have_root = false;
    let mut pos = 0;

    while pos < src.len() {
        let lt = src[pos..].find('<').map(|n| pos + n);
        let chunk = &src[pos..lt.unwrap_or(src.len())];
        if !chunk.is_empty() {
            if let Some(top) = texts.last_mut() {
                top.push_str(&decode(chunk)?);
            } else if !js_trim(chunk).is_empty() {
                return fail("Text outside the root element");
            }
        }
        let Some(lt) = lt else { break };
        pos = lt;
        let here = &src[pos..];
        if here.starts_with("<!--") {
            let Some(end) = src[pos + 4..].find("-->") else { return fail("Unclosed comment") };
            pos = pos + 4 + end + 3;
        } else if here.starts_with("<![CDATA[") {
            let end = src[pos + 9..].find("]]>");
            let (Some(end), Some(top)) = (end, texts.last_mut()) else { return fail("Bad CDATA section") };
            top.push_str(&src[pos + 9..pos + 9 + end]);
            pos = pos + 9 + end + 3;
        } else if here.starts_with("<?") {
            let Some(end) = src[pos + 2..].find("?>") else { return fail("Unclosed processing instruction") };
            pos = pos + 2 + end + 2;
        } else if here.starts_with("<!") {
            // <!DOCTYPE ...> and <!ENTITY ...>: where XML bombs and external entities come from.
            return Err(XmlError { failure: XmlFailure::Dtd, message: "A DTD is not allowed" });
        } else if here.starts_with("</") {
            let name_end = name_at(src, pos + 2);
            let end = here.find('>').map(|n| pos + n);
            let (Some(name_end), Some(end), Some(&top)) = (name_end, end, stack.last()) else { return fail("Mismatched closing tag") };
            if local(&src[pos + 2..name_end]) != nodes[top].name || !js_trim(&src[name_end..end]).is_empty() {
                return fail("Mismatched closing tag");
            }
            let parts = texts.pop().unwrap_or_default();
            nodes[top].text = js_trim(&parts).to_owned();
            stack.pop();
            pos = end + 1;
        } else {
            let Some(name_end) = name_at(src, pos + 1) else { return fail("Bad tag") };
            let mut node =
                XmlNode { name: local(&src[pos + 1..name_end]).to_owned(), attrs: Vec::new(), children: Vec::new(), text: String::new() };
            pos = name_end;
            let mut self_closing = false;
            loop {
                pos = skip_space(src, pos);
                let rest = &src[pos..];
                if rest.starts_with('>') {
                    pos += 1;
                    break;
                }
                if rest.starts_with("/>") {
                    self_closing = true;
                    pos += 2;
                    break;
                }
                let Some(key_end) = name_at(src, pos) else { return fail("Bad attribute") };
                let key = &src[pos..key_end];
                pos = skip_space(src, key_end);
                if !src[pos..].starts_with('=') {
                    return fail("Attribute without value");
                }
                pos = skip_space(src, pos + 1);
                let Some(quote) = src[pos..].chars().next().filter(|c| matches!(c, '"' | '\'')) else {
                    return fail("Attribute value without quotes");
                };
                let Some(close) = src[pos + 1..].find(quote) else { return fail("Unclosed attribute value") };
                let value = &src[pos + 1..pos + 1 + close];
                if value.contains('<') {
                    return fail("Bad attribute value");
                }
                let value = decode(value)?;
                // Assigning to `__proto__` of an object literal with a string does nothing.
                if key != "__proto__" {
                    node.attrs.push((key.to_owned(), value));
                }
                pos = pos + 1 + close + 1;
            }
            if nodes.len() + 1 > MAX_ELEMENTS {
                return Err(XmlError { failure: XmlFailure::TooLarge, message: "Too many elements" });
            }
            let id = nodes.len();
            match stack.last() {
                Some(&parent) => nodes[parent].children.push(id),
                None if have_root => return fail("More than one root element"),
                None => have_root = true,
            }
            nodes.push(node);
            if !self_closing {
                if stack.len() >= MAX_DEPTH {
                    return Err(XmlError { failure: XmlFailure::TooLarge, message: "Nested too deeply" });
                }
                stack.push(id);
                texts.push(String::new());
            }
        }
    }
    if !stack.is_empty() || nodes.is_empty() {
        return fail("The file ends early or has no content");
    }
    Ok(XmlDoc { nodes })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(src: &str) -> XmlFailure {
        parse_xml(src).err().expect("refused").failure
    }

    #[test]
    fn builds_a_tree_without_namespace_prefixes_with_cdata_references_and_comments() {
        let doc = parse_xml(
            "<?xml version=\"1.0\"?><!-- c --><ns2:A x=\"1 &amp; 2\"><B><![CDATA[a < b]]></B><C>&#233;&#x20AC; &lt;&gt;</C><D/></ns2:A>",
        )
        .unwrap();
        let root = doc.root();
        assert_eq!(root.name(), "A");
        assert_eq!(root.attr("x"), Some("1 & 2"));
        assert_eq!(root.children().map(|c| c.name()).collect::<Vec<_>>(), ["B", "C", "D"]);
        assert_eq!(root.child("B").unwrap().text(), "a < b");
        assert_eq!(root.child("C").unwrap().text(), "é€ <>");
    }

    #[test]
    fn refuses_a_doctype_however_it_is_used() {
        let bomb =
            "<?xml version=\"1.0\"?><!DOCTYPE lolz [<!ENTITY lol \"lol\"><!ENTITY lol2 \"&lol;&lol;&lol;&lol;&lol;\">]><lolz>&lol2;</lolz>";
        let xxe = "<?xml version=\"1.0\"?><!DOCTYPE d [<!ENTITY x SYSTEM \"file:///etc/passwd\">]><d>&x;</d>";
        assert_eq!(err(bomb), XmlFailure::Dtd);
        assert_eq!(err(xxe), XmlFailure::Dtd);
    }

    #[test]
    fn refuses_entities_that_are_not_built_in() {
        assert_eq!(err("<a>&x;</a>"), XmlFailure::Broken);
        assert_eq!(err("<a>&#0;</a>"), XmlFailure::Broken);
        assert_eq!(err("<a>&#xD800;</a>"), XmlFailure::Broken);
        assert_eq!(err("<a>&#x110000;</a>"), XmlFailure::Broken);
        assert_eq!(
            parse_xml("<a>a &amp b &#12a; &#x1234567;</a>").unwrap().root().text(),
            "a &amp b &#12a; &#x1234567;",
            "what is no reference stays"
        );
    }

    #[test]
    fn knows_only_the_five_built_in_entities_not_names_of_object_prototype() {
        assert_eq!(parse_xml("<a>&lt;&amp;&gt;&quot;&apos;</a>").unwrap().root().text(), "<&>\"'");
        for name in ["constructor", "toString", "hasOwnProperty"] {
            assert_eq!(err(&format!("<a>&{name};</a>")), XmlFailure::Broken, "{name}");
        }
    }

    #[test]
    fn refuses_malformed_input() {
        for bad in [
            "",
            "not xml",
            "<a>",
            "<a></b>",
            "<a><b></a></b>",
            "<a x=1/>",
            "<a x=\"1/>",
            "<a/><b/>",
            "<a>text</a>trailing",
            "<a><!-- open</a>",
            "<a><![CDATA[x</a>",
            "<a b></a>",
        ] {
            assert_eq!(err(bad), XmlFailure::Broken, "{bad}");
        }
    }

    #[test]
    fn refuses_absurd_nesting() {
        assert_eq!(err(&"<a>".repeat(100_000)), XmlFailure::TooLarge);
    }

    #[test]
    fn reads_a_long_flat_file() {
        let doc = parse_xml(&format!("<a>{}</a>", "<b>1</b>".repeat(50_000))).unwrap();
        assert_eq!(doc.root().child_count(), 50_000);
    }

    #[test]
    fn attribute_values_come_in_the_order_of_a_javascript_object() {
        let doc = parse_xml("<a z=\"1\" 10=\"2\" 2=\"3\" y=\"4\" z=\"5\" __proto__=\"6\" 02=\"7\"/>").unwrap();
        assert_eq!(doc.root().attr_values(), ["3", "2", "5", "4", "7"]);
        assert_eq!(doc.root().attr("z"), Some("5"));
        assert_eq!(doc.root().attr("__proto__"), None);
    }
}
