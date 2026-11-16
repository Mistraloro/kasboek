package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
)

// The running app writes mcp-bridge.json (readable only by this user) while MCP access is on and
// Kasboek is unlocked: where to connect, and the token for this session.
type discovery struct {
	Socket string `json:"socket"`
	Token  string `json:"token"`
}

type toolInfo struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Mutates     bool           `json:"mutates"`
}

type bridgeResponse struct {
	ID     int64           `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

type bridge struct {
	dataDir string
	nextID  atomic.Int64
	// The connecting app's name from MCP initialize ("claude-ai" for Claude Desktop, "claude-code"),
	// passed on so Kasboek can show which app is connected.
	client atomic.Value
}

func (b *bridge) setClient(name string) {
	b.client.Store(name)
}

var errNotRunning = errors.New("Kasboek isn't running, is locked, or MCP access is off. Open Kasboek, unlock it, and turn on " +
	"\"Claude Desktop & Claude Code (MCP)\" in Settings → Claude.")

func (b *bridge) request(call, name string, input json.RawMessage) (json.RawMessage, error) {
	raw, err := os.ReadFile(filepath.Join(b.dataDir, "mcp-bridge.json"))
	if err != nil {
		return nil, errNotRunning
	}
	var d discovery
	if json.Unmarshal(raw, &d) != nil || d.Socket == "" {
		return nil, errNotRunning
	}
	conn, err := dial(d.Socket)
	if err != nil {
		return nil, errNotRunning
	}
	defer conn.Close()
	id := b.nextID.Add(1)
	req := map[string]any{"token": d.Token, "id": id, "call": call}
	if c, _ := b.client.Load().(string); c != "" {
		req["client"] = c
	}
	if name != "" {
		req["name"] = name
	}
	if len(input) > 0 {
		req["input"] = input
	}
	payload, _ := json.Marshal(req)
	if _, err := conn.Write(append(payload, '\n')); err != nil {
		return nil, errNotRunning
	}
	line, err := bufio.NewReaderSize(conn, 1<<20).ReadBytes('\n')
	if err != nil {
		return nil, errors.New("Kasboek closed the connection.")
	}
	var res bridgeResponse
	if err := json.Unmarshal(line, &res); err != nil {
		return nil, errors.New("unexpected answer from Kasboek")
	}
	if !res.OK {
		return nil, errors.New(res.Error)
	}
	return res.Result, nil
}

func (b *bridge) list() ([]toolInfo, error) {
	raw, err := b.request("list", "", nil)
	if err != nil {
		return nil, err
	}
	var tools []toolInfo
	if err := json.Unmarshal(raw, &tools); err != nil {
		return nil, errors.New("unexpected tool list from Kasboek")
	}
	return tools, nil
}

func (b *bridge) call(name string, input json.RawMessage) (string, error) {
	raw, err := b.request("tool", name, input)
	if err != nil {
		return "", err
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s, nil
	}
	return string(raw), nil
}
