//! The real client (`UreqHttp`) against a server on the loopback interface: no internet, no proxy.
use kb_service::{Cancel, Http, HttpError, HttpRequest, UreqHttp};
use std::io::{Read, Write};
use std::net::TcpListener;

/// Serves `reply` (a whole HTTP response) to the next connection and returns the address and the request text it got.
fn serve_once(reply: &'static str) -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/path", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut seen = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = stream.read(&mut buf).unwrap();
            seen.extend_from_slice(&buf[..n]);
            if n == 0 || seen.windows(4).any(|w| w == b"\r\n\r\n") && (!seen.starts_with(b"POST") || seen.ends_with(b"{\"a\":1}")) {
                break;
            }
        }
        stream.write_all(reply.as_bytes()).unwrap();
        String::from_utf8_lossy(&seen).into_owned()
    });
    (url, server)
}

fn client() -> UreqHttp {
    // The loopback server must not go through a proxy of the machine that runs the tests.
    std::env::set_var("NO_PROXY", "127.0.0.1");
    UreqHttp::new()
}

#[test]
fn a_post_sends_its_headers_and_body_and_a_404_is_a_response() {
    let (url, server) =
        serve_once("HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnope");
    let request = HttpRequest::post(&url, b"{\"a\":1}".to_vec()).header("x-api-key", "invented");
    let answer = client().send(request).unwrap();
    assert_eq!((answer.status, answer.body.as_slice(), answer.header("content-type")), (404, &b"nope"[..], Some("text/plain")));
    let seen = server.join().unwrap().to_lowercase();
    assert!(seen.starts_with("post /path "), "{seen}");
    assert!(seen.contains("x-api-key: invented") && seen.contains("user-agent: kasboek"), "{seen}");
}

#[test]
fn a_reply_above_the_cap_is_refused() {
    let (url, server) = serve_once("HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\n0123456789");
    let mut request = HttpRequest::get(&url);
    request.max_body = 4;
    assert_eq!(client().send(request), Err(HttpError::TooLarge));
    server.join().unwrap();
}

#[test]
fn a_stream_delivers_lines_without_their_endings() {
    let (url, server) =
        serve_once("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: one\r\n\r\ndata: two\n\n");
    let mut lines = Vec::new();
    let status = client().stream(HttpRequest::get(&url), &Cancel::new(), &mut |l| lines.push(l.to_owned())).unwrap();
    assert_eq!((status, lines), (200, vec!["data: one", "", "data: two", ""].into_iter().map(String::from).collect::<Vec<_>>()));
    server.join().unwrap();
}

#[test]
fn nothing_listening_is_a_network_error() {
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let result = client().send(HttpRequest::get(&format!("http://127.0.0.1:{port}/")));
    assert!(matches!(result, Err(HttpError::Network(_))), "{result:?}");
}
