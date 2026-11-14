package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeApp imitates Kasboek's bridge: a named pipe on Windows, a Unix socket elsewhere (see
// fake_*_test.go), so the helper's real way of connecting is what gets tested.
func fakeApp(t *testing.T, dir string) {
	t.Helper()
	ln := listen(t)
	disc, _ := json.Marshal(discovery{Socket: ln.addr, Token: "secret"})
	os.WriteFile(filepath.Join(dir, "mcp-bridge.json"), disc, 0o600)
	go func() {
		for {
			c, err := ln.accept()
			if err != nil {
				return
			}
			go func(c io.ReadWriteCloser) {
				defer c.Close()
				line, _ := bufio.NewReader(c).ReadBytes('\n')
				var req map[string]any
				json.Unmarshal(line, &req)
				id := req["id"]
				var res any
				switch {
				case req["token"] != "secret":
					res = map[string]any{"id": id, "ok": false, "error": "Not authorised."}
				case req["call"] == "list":
					res = map[string]any{"id": id, "ok": true, "result": []any{
						map[string]any{"name": "summary_month", "description": "Summary", "inputSchema": map[string]any{"type": "object"}, "mutates": false},
						map[string]any{"name": "budgets_set", "description": "Set budget", "inputSchema": map[string]any{"type": "object"}, "mutates": true},
					}}
				default:
					res = map[string]any{"id": id, "ok": true, "result": `{"spendingCents":4200}`}
				}
				b, _ := json.Marshal(res)
				c.Write(append(b, '\n'))
			}(c)
		}
	}()
}

func run(t *testing.T, dir string, input string) []map[string]any {
	t.Helper()
	var out bytes.Buffer
	s := &server{bridge: &bridge{dataDir: dir}, out: json.NewEncoder(&out)}
	serve(s, strings.NewReader(input))
	time.Sleep(200 * time.Millisecond) // tool calls answer from goroutines
	var msgs []map[string]any
	dec := json.NewDecoder(&out)
	for {
		var m map[string]any
		if err := dec.Decode(&m); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		msgs = append(msgs, m)
	}
	return msgs
}

const handshake = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
`

func TestConnected(t *testing.T) {
	dir := t.TempDir()
	fakeApp(t, dir)
	msgs := run(t, dir, handshake+`{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"summary_month","arguments":{"month":"2026-11"}}}
{"jsonrpc":"2.0","id":4,"method":"nope"}
`)
	byID := map[float64]map[string]any{}
	for _, m := range msgs {
		if id, ok := m["id"].(float64); ok {
			byID[id] = m
		}
	}
	init := byID[1]["result"].(map[string]any)
	if init["protocolVersion"] != "2025-06-18" {
		t.Fatalf("protocol: %v", init)
	}
	tools := byID[2]["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 2 || tools[1].(map[string]any)["annotations"].(map[string]any)["readOnlyHint"] != false {
		t.Fatalf("tools: %v", tools)
	}
	call := byID[3]["result"].(map[string]any)
	if call["isError"] != false || !strings.Contains(call["content"].([]any)[0].(map[string]any)["text"].(string), "4200") {
		t.Fatalf("call: %v", call)
	}
	if byID[4]["error"].(map[string]any)["code"].(float64) != -32601 {
		t.Fatalf("unknown method: %v", byID[4])
	}
}

func TestNotRunning(t *testing.T) {
	dir := t.TempDir()
	msgs := run(t, dir, handshake+`{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"summary_month","arguments":{}}}
`)
	var list, call map[string]any
	for _, m := range msgs {
		switch m["id"] {
		case 2.0:
			list = m
		case 3.0:
			call = m
		}
	}
	tools := list["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 1 || tools[0].(map[string]any)["name"] != "kasboek_status" {
		t.Fatalf("expected status tool, got %v", tools)
	}
	if call["result"].(map[string]any)["isError"] != true {
		t.Fatalf("expected error result: %v", call)
	}
}
