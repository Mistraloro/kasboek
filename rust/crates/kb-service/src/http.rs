//! The one HTTP client of the app (ECB rates, assistant providers, updater, WebDAV), behind the [`Http`] trait so that the
//! scenarios and tests serve recorded answers ([`FakeHttp`]) and nothing in the test suite touches the network.
//!
//! [`UreqHttp`] is blocking `ureq` 3 with rustls (the `ring` provider) and the operating system's trust store
//! (`rustls-platform-verifier`: Windows CryptoAPI, macOS Security.framework, the system certificate files on Linux). Proxies
//! come from `HTTPS_PROXY` / `ALL_PROXY` and, on Windows, the registry; a PAC script is not evaluated. Decision and reasons:
//! docs/rust-port-plan.md section 11.2 (O0).
//!
//! Calls block their thread: they run on job threads (`jobs.rs`), never on the database worker.
use crate::jobs::Cancel;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// A reply is refused above this many bytes unless the request says otherwise.
pub const DEFAULT_MAX_BODY: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// Longest reply body `send` accepts (`HttpError::TooLarge` above it).
    pub max_body: usize,
    /// Time for the whole call; `None` is the client's default of 60 seconds.
    pub timeout: Option<Duration>,
}

impl HttpRequest {
    pub fn new(method: &str, url: &str) -> Self {
        Self { method: method.to_owned(), url: url.to_owned(), headers: Vec::new(), body: None, max_body: DEFAULT_MAX_BODY, timeout: None }
    }

    pub fn get(url: &str) -> Self {
        Self::new("GET", url)
    }

    pub fn post(url: &str, body: Vec<u8>) -> Self {
        Self { body: Some(body), ..Self::new("POST", url) }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// The first header called `name` (case does not matter).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpError {
    /// No connection, DNS, TLS or protocol failure. The text is for the log, not for the person.
    Network(String),
    Timeout,
    /// The reply body is longer than `max_body`.
    TooLarge,
    /// The job was cancelled (the person locked the app or asked to stop).
    Cancelled,
    /// [`FakeHttp`] only: the call does not match the next recorded answer.
    Unexpected(String),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(why) => write!(f, "network error: {why}"),
            Self::Timeout => f.write_str("the request timed out"),
            Self::TooLarge => f.write_str("the reply is too large"),
            Self::Cancelled => f.write_str("cancelled"),
            Self::Unexpected(why) => write!(f, "unexpected request: {why}"),
        }
    }
}

impl std::error::Error for HttpError {}

pub trait Http: Send + Sync {
    /// One request, the whole reply (any status: a 404 is a response, not an error).
    fn send(&self, req: HttpRequest) -> Result<HttpResponse, HttpError>;

    /// One request whose reply is read line by line (server-sent events): `line` gets every line without its line ending
    /// (blank lines too). Returns the status; the lines of a non-2xx reply are delivered the same way. Stops with
    /// `HttpError::Cancelled` when `cancel` is set, checked between lines.
    fn stream(&self, req: HttpRequest, cancel: &Cancel, line: &mut dyn FnMut(&str)) -> Result<u16, HttpError>;
}

/// No network: every call fails. The default of a service whose app gave it no client.
pub struct NoHttp;

impl Http for NoHttp {
    fn send(&self, _req: HttpRequest) -> Result<HttpResponse, HttpError> {
        Err(HttpError::Network("no HTTP client".into()))
    }

    fn stream(&self, _req: HttpRequest, _cancel: &Cancel, _line: &mut dyn FnMut(&str)) -> Result<u16, HttpError> {
        Err(HttpError::Network("no HTTP client".into()))
    }
}

/// The real client.
pub struct UreqHttp {
    agent: ureq::Agent,
}

impl Default for UreqHttp {
    fn default() -> Self {
        Self::new()
    }
}

impl UreqHttp {
    pub fn new() -> Self {
        use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
        let tls = TlsConfig::builder()
            .provider(TlsProvider::Rustls)
            .unversioned_rustls_crypto_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .root_certs(RootCerts::PlatformVerifier)
            .build();
        let agent = ureq::Agent::config_builder()
            .tls_config(tls)
            .http_status_as_error(false)
            .user_agent("Kasboek")
            .timeout_global(Some(Duration::from_secs(60)))
            .build()
            .new_agent();
        Self { agent }
    }

    fn call(&self, req: &HttpRequest) -> Result<ureq::http::Response<ureq::Body>, HttpError> {
        use ureq::RequestExt;
        let mut builder = ureq::http::Request::builder().method(req.method.as_str()).uri(req.url.as_str());
        for (name, value) in &req.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        let request = builder.body(req.body.clone().unwrap_or_default()).map_err(|e| HttpError::Network(e.to_string()))?;
        let call = request.with_agent(&self.agent);
        match req.timeout {
            Some(t) => call.configure().timeout_global(Some(t)).run(),
            None => call.run(),
        }
        .map_err(map_error)
    }
}

fn map_error(e: ureq::Error) -> HttpError {
    match e {
        ureq::Error::Timeout(_) => HttpError::Timeout,
        ureq::Error::BodyExceedsLimit(_) => HttpError::TooLarge,
        other => HttpError::Network(other.to_string()),
    }
}

fn headers_of(response: &ureq::http::Response<ureq::Body>) -> Vec<(String, String)> {
    response.headers().iter().filter_map(|(n, v)| Some((n.as_str().to_owned(), v.to_str().ok()?.to_owned()))).collect()
}

impl Http for UreqHttp {
    fn send(&self, req: HttpRequest) -> Result<HttpResponse, HttpError> {
        let mut response = self.call(&req)?;
        let (status, headers) = (response.status().as_u16(), headers_of(&response));
        let body = response.body_mut().with_config().limit(req.max_body as u64).read_to_vec().map_err(map_error)?;
        Ok(HttpResponse { status, headers, body })
    }

    fn stream(&self, req: HttpRequest, cancel: &Cancel, line: &mut dyn FnMut(&str)) -> Result<u16, HttpError> {
        let mut response = self.call(&req)?;
        let status = response.status().as_u16();
        let mut reader = BufReader::new(response.body_mut().as_reader());
        let mut text = String::new();
        loop {
            if cancel.is_cancelled() {
                return Err(HttpError::Cancelled);
            }
            text.clear();
            match reader.read_line(&mut text) {
                Ok(0) => return Ok(status),
                Ok(_) => line(text.trim_end_matches(['\r', '\n'])),
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => return Err(HttpError::Timeout),
                Err(e) => return Err(HttpError::Network(e.to_string())),
            }
        }
    }
}

/// One recorded answer of a scenario's `http` list: `{"url", "status"?, "body"? | "sse"?}`. `sse` is a list of event data
/// strings and is served as `data: <text>` lines each followed by a blank line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recorded {
    pub url: String,
    pub status: u16,
    pub body: Vec<u8>,
}

impl Recorded {
    pub fn new(url: &str, status: u16, body: &str) -> Self {
        Self { url: url.to_owned(), status, body: body.as_bytes().to_vec() }
    }

    /// From the scenario JSON (`status` defaults to 200, `body` to the empty string).
    pub fn from_json(entry: &serde_json::Value) -> Option<Self> {
        let url = entry.get("url")?.as_str()?.to_owned();
        let status = entry.get("status").and_then(serde_json::Value::as_u64).unwrap_or(200) as u16;
        let body = match entry.get("sse").and_then(serde_json::Value::as_array) {
            Some(events) => events.iter().filter_map(serde_json::Value::as_str).map(|e| format!("data: {e}\n\n")).collect(),
            None => entry.get("body").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned(),
        };
        Some(Self { url, status, body: body.into_bytes() })
    }
}

/// Replays recorded answers in order, one per request, and keeps the requests it saw. A request whose URL is not the next
/// recorded one (or with none left) fails with `HttpError::Unexpected`, so a scenario also pins the calls an operation makes.
#[derive(Default)]
pub struct FakeHttp {
    answers: Mutex<VecDeque<Recorded>>,
    seen: Mutex<Vec<HttpRequest>>,
}

impl FakeHttp {
    pub fn new(answers: Vec<Recorded>) -> Self {
        Self { answers: Mutex::new(answers.into()), seen: Mutex::new(Vec::new()) }
    }

    /// The requests received so far, in order.
    pub fn requests(&self) -> Vec<HttpRequest> {
        self.seen.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn next(&self, req: &HttpRequest) -> Result<Recorded, HttpError> {
        self.seen.lock().unwrap_or_else(|e| e.into_inner()).push(req.clone());
        match self.answers.lock().unwrap_or_else(|e| e.into_inner()).pop_front() {
            Some(answer) if answer.url == req.url => Ok(answer),
            Some(answer) => Err(HttpError::Unexpected(format!("{} {} (the next answer is for {})", req.method, req.url, answer.url))),
            None => Err(HttpError::Unexpected(format!("{} {} (no answer left)", req.method, req.url))),
        }
    }
}

impl Http for FakeHttp {
    fn send(&self, req: HttpRequest) -> Result<HttpResponse, HttpError> {
        let answer = self.next(&req)?;
        if answer.body.len() > req.max_body {
            return Err(HttpError::TooLarge);
        }
        Ok(HttpResponse { status: answer.status, headers: Vec::new(), body: answer.body })
    }

    fn stream(&self, req: HttpRequest, cancel: &Cancel, line: &mut dyn FnMut(&str)) -> Result<u16, HttpError> {
        let answer = self.next(&req)?;
        for text in String::from_utf8_lossy(&answer.body).lines() {
            if cancel.is_cancelled() {
                return Err(HttpError::Cancelled);
            }
            line(text);
        }
        Ok(answer.status)
    }
}
