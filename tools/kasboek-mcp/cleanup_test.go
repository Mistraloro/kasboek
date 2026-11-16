package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRemoveFromDesktopConfigOnlyOwnEntry(t *testing.T) {
	dir := t.TempDir()
	self := filepath.Join(dir, "Kasboek", "kasboek-mcp")
	path := filepath.Join(dir, "claude_desktop_config.json")
	write := func(cmd string) {
		cfg := map[string]any{"mcpServers": map[string]any{"kasboek": map[string]any{"command": cmd, "args": []string{}}, "other": map[string]any{"command": "x"}}, "theme": "dark"}
		b, _ := json.Marshal(cfg)
		if err := os.WriteFile(path, b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// Another installation's helper: left alone.
	write(filepath.Join(dir, "Elsewhere", "kasboek-mcp"))
	if removeFromDesktopConfig(path, self) {
		t.Fatal("removed an entry of another installation")
	}
	// This helper: removed, the rest kept, a copy saved.
	write(self)
	if !removeFromDesktopConfig(path, self) {
		t.Fatal("own entry not removed")
	}
	var cfg struct {
		McpServers map[string]any `json:"mcpServers"`
		Theme      string         `json:"theme"`
	}
	raw, _ := os.ReadFile(path)
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	if _, ok := cfg.McpServers["kasboek"]; ok || cfg.McpServers["other"] == nil || cfg.Theme != "dark" {
		t.Fatalf("unexpected config: %s", raw)
	}
	if _, err := os.Stat(path + ".before-kasboek-uninstall"); err != nil {
		t.Fatal("no backup copy")
	}
}

func TestCleanDataDirKeepsDataAndRefusesOtherFolders(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "Kasboek")
	for _, p := range []string{"kasboek.db", "account.json", filepath.Join("Cache", "x"), filepath.Join("updates", "Kasboek.msi"), filepath.Join("safety-backups", "b.kasboek")} {
		_ = os.MkdirAll(filepath.Dir(filepath.Join(data, p)), 0o700)
		_ = os.WriteFile(filepath.Join(data, p), []byte("x"), 0o600)
	}
	cleanDataDir(data, false)
	for _, keep := range []string{"kasboek.db", "account.json", filepath.Join("safety-backups", "b.kasboek")} {
		if _, err := os.Stat(filepath.Join(data, keep)); err != nil {
			t.Fatalf("%s was deleted", keep)
		}
	}
	for _, gone := range []string{"Cache", "updates"} {
		if _, err := os.Stat(filepath.Join(data, gone)); err == nil {
			t.Fatalf("%s was kept", gone)
		}
	}
	// A folder with another name is never touched, even with --remove-data.
	other := filepath.Join(root, "Documents")
	_ = os.MkdirAll(other, 0o700)
	cleanDataDir(other, true)
	if _, err := os.Stat(other); err != nil {
		t.Fatal("deleted a folder that isn't Kasboek's")
	}
	cleanDataDir(data, true)
	if _, err := os.Stat(data); err == nil {
		t.Fatal("data kept although removal was asked")
	}
}
