package standard

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const (
	hookPath     = "hooks/session-start"
	templatePath = "skills/system-design/template.md"
)

type hookOutput struct {
	HookSpecificOutput struct {
		HookEventName     string `json:"hookEventName"`
		AdditionalContext string `json:"additionalContext"`
	} `json:"hookSpecificOutput"`
}

// runHook runs the hook script with CLAUDE_PLUGIN_ROOT set to root and returns the parsed context
func runHook(t *testing.T, script, root string) string {
	t.Helper()

	var stdout, stderr bytes.Buffer
	cmd := exec.Command("bash", script)
	cmd.Env = append(os.Environ(), "CLAUDE_PLUGIN_ROOT="+root)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("hook failed: %v\nstderr: %s", err, stderr.String())
	}

	var out hookOutput
	if err := json.Unmarshal(stdout.Bytes(), &out); err != nil {
		t.Fatalf("hook output is not JSON: %v\n%s", err, stdout.String())
	}
	if got := out.HookSpecificOutput.HookEventName; got != "SessionStart" {
		t.Errorf("hookEventName = %q, want SessionStart", got)
	}
	return out.HookSpecificOutput.AdditionalContext
}

// tempPlugin returns a plugin root holding a copy of the hook, and rules.md when rules is non-nil
func tempPlugin(t *testing.T, rules *string) string {
	t.Helper()

	hook, err := os.ReadFile(hookPath)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "hooks"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, hookPath), hook, 0o755); err != nil {
		t.Fatal(err)
	}
	if rules != nil {
		if err := os.WriteFile(filepath.Join(root, "rules.md"), []byte(*rules), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestSessionStartEmitsRules(t *testing.T) {
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	rules, err := os.ReadFile("rules.md")
	if err != nil {
		t.Fatal(err)
	}

	got := runHook(t, hookPath, root)

	if got != string(rules) {
		t.Errorf("context = %q, want rules.md %q", got, rules)
	}
}

func TestSessionStartEscapes(t *testing.T) {
	rules := "a \"quote\" \\ back\tslash\nnew line\r\ncarriage return"
	root := tempPlugin(t, &rules)

	got := runHook(t, filepath.Join(root, hookPath), root)

	if got != rules {
		t.Errorf("context = %q, want %q", got, rules)
	}
}

func TestSessionStartWithoutRules(t *testing.T) {
	root := tempPlugin(t, nil)

	got := runHook(t, filepath.Join(root, hookPath), root)

	if want := "standard plugin: rules.md missing"; got != want {
		t.Errorf("context = %q, want %q", got, want)
	}
}

func TestRulesStateTheStandard(t *testing.T) {
	data, err := os.ReadFile("rules.md")
	if err != nil {
		t.Fatal(err)
	}
	rules := string(data)

	for _, want := range []string{
		"A simple bug fix makes the code do what it already promised, by a test, a doc, a spec or an API contract. " +
			"It changes no API contract, no database schema, no config keys, no dependencies and no infrastructure.",
		"`standard:system-design`",
		"`superpowers:brainstorming`",
		"`Design: <path>`",
		"`Design: <path> §<n>`",
		"`Fixes: <path>`",
		"bypass",
	} {
		if !strings.Contains(rules, want) {
			t.Errorf("rules.md lacks %q", want)
		}
	}

	if n := strings.Count(rules, "\n"); n > 40 {
		t.Errorf("rules.md has %d lines, the house style allows 40", n)
	}
}

func TestTemplateSections(t *testing.T) {
	data, err := os.ReadFile(templatePath)
	if err != nil {
		t.Fatal(err)
	}

	var header, headings []string
	for _, line := range strings.Split(string(data), "\n") {
		if heading, ok := strings.CutPrefix(line, "## "); ok {
			headings = append(headings, heading)
		} else if len(headings) == 0 {
			header = append(header, line)
		}
	}

	// The lenses cite these headings by their exact text
	want := []string{
		"What we're building",
		"Why",
		"Goals, non-goals, anti-goals",
		"Fit with existing features",
		"API contract",
		"Data model and migrations",
		"Scaling",
		"Infrastructure and dependencies",
		"Security",
		"Failure and rollback",
		"How we'll know it works",
		"Approaches",
		"Delivery",
		"Decisions",
		"Left to the builder",
		"Design review",
	}
	if !slices.Equal(headings, want) {
		t.Errorf("template headings = %q, want %q", headings, want)
	}

	for _, field := range []struct {
		label  string
		values []string
	}{
		{"Size:", []string{"full", "short"}},
		{"Status:", []string{"draft", "in review", "approved YYYY-MM-DD"}},
		{"From:", nil},
	} {
		i := slices.IndexFunc(header, func(line string) bool {
			return strings.Contains(line, field.label)
		})
		if i < 0 {
			t.Errorf("template header lacks %q", field.label)
			continue
		}
		for _, value := range field.values {
			if !strings.Contains(header[i], value) {
				t.Errorf("template header line %q lacks %q", header[i], value)
			}
		}
	}
}
